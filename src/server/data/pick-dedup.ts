// The server-side duplicate check: the one place that decides whether a pick
// is inserted.
//
// Duplicate detection used to exist only as a preview the import review screen
// asked for (checkDuplicatePicksAction); bulkImportPicksAction inserted
// whatever it was sent, and the manual pick form never checked at all. Anything
// that kept the preview from raising a flag - Import clicked before it
// returned, the check throwing, a second tab - saved the pick twice. Production
// had whole pastes stored twice 70 minutes apart.
//
// Now every Pick insert goes through insertPicksDeduped, in ONE transaction:
//
//   1. pg_advisory_xact_lock on the user - two imports for the same user run
//      one after the other, so the second one's check sees the first one's rows.
//   2. the duplicate check, against this user's logged picks AND the earlier
//      rows of the same request, with the same definition the preview uses
//      (isSameBet, duplicate-pick-detection.ts).
//   3. the pick-limit gate and the insert (insertPicksInTransaction), for the
//      rows that survived.
//
// A duplicate is inserted only when its row carries overrideDuplicate - the
// review screen's explicit per-pick "Import anyway". Every override is written
// to import_skipped_lines as DUPLICATE_OVERRIDDEN, and every duplicate the
// server refused as DUPLICATE_SKIPPED.
//
// If the check itself fails, the transaction throws and nothing is inserted.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeName } from "@/lib/fuzzy-match";
import { dedupCategory, isComparableBet, isSameBet, type BetIdentity } from "@/lib/duplicate-pick-detection";
import { pickCategory } from "@/server/data/stats";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { LIVE_SPORTS } from "@/server/data/odds";
import {
  EXISTING_PICK_SELECT,
  existingBetIdentity,
  existingPickLabel,
  existingPicksWhere,
  findDbDuplicate,
  sportIdsByLowerName,
  type DbDupCandidate,
  type ExistingPickRow,
} from "@/server/data/duplicate-db-match";
import { resolveImportRefs, type PendingPickInsert } from "@/server/data/import-refs";
import {
  ENTITLEMENT_TX_OPTIONS,
  insertPicksInTransaction,
  type AtomicCreateResult,
  type PickInsertData,
} from "@/server/data/subscriptions";
import { recordImportSkippedLines, type SkippedLineEntry } from "@/server/data/import-skipped-lines";

// A pick queued for insert. The catalog import names its capper and sport
// (found or created inside the transaction); the manual form already holds
// their ids and passes them too, so its capper is never re-resolved by name.
export type DedupPickRow = PendingPickInsert & {
  capperId?: string;
  sportId?: string;
  // The review screen's explicit "Import anyway" for THIS pick.
  overrideDuplicate?: boolean;
  // The exact pasted line, for the log only. Falls back to betDetail.
  raw?: string;
};

export type DuplicateHit = {
  index: number; // position in the rows passed in
  capperName: string;
  label: string; // this row's own bet text
  // What it duplicates: a logged pick, or an earlier row of the same request.
  existingPickId: string | null;
  earlierIndex: number | null;
  existingLabel: string;
};

export type DedupInsertResult =
  | {
      allowed: true;
      created: { id: string }[];
      insertedIndexes: number[]; // created[k] is rows[insertedIndexes[k]]
      skippedDuplicates: DuplicateHit[]; // refused - not inserted
      overridden: DuplicateHit[]; // duplicates inserted on an explicit override
    }
  | (Extract<AtomicCreateResult, { allowed: false }> & { skippedDuplicates: DuplicateHit[] });

export type DedupInsertOptions = {
  // The read of this user's logged picks. Replaceable so a test can make the
  // check fail (or stall) - the default is the transaction's own findMany.
  readExistingPicks?: (tx: Prisma.TransactionClient, where: Prisma.PickWhereInput) => Promise<ExistingPickRow[]>;
};

// The Odds API sport key for a sport label - what turns on a league's
// cross-feed team aliases. Undefined for a sport with no live feed.
export function sportKeyForName(sportName: string): string | undefined {
  return LIVE_SPORTS.find((s) => s.label.toUpperCase() === sportName.toUpperCase())?.key;
}

// A queued row as isSameBet sees it.
export function rowBetIdentity(row: DedupPickRow): BetIdentity {
  const period = row.period ?? "FULL_GAME";
  const category = pickCategory({
    betType: row.betType,
    period,
    betDetail: row.betDetail ?? null,
    odds: row.odds,
    line: row.line ?? null,
    sportName: row.sportName,
    pickedSide: row.pickedSide ?? null,
    mlFavoredSide: row.mlFavoredSide ?? null,
    propMarket: row.propMarket ?? null,
  });
  const knownPlayerProp = row.propMarket && row.playerName ? { propMarket: row.propMarket, playerName: row.playerName } : null;
  return {
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    gameTimeMs: row.gameTime.getTime(),
    sportKey: sportKeyForName(row.sportName),
    period,
    betType: row.betType,
    category: category ? dedupCategory(category, row.betType, row.betDetail ?? null, row.pickedSide ?? null, knownPlayerProp, row.sportName) : null,
    pickedSide: row.pickedSide ?? null,
  };
}

const defaultReadExistingPicks: NonNullable<DedupInsertOptions["readExistingPicks"]> = (tx, where) =>
  tx.pick.findMany({ where, select: EXISTING_PICK_SELECT, orderBy: { id: "asc" } });

// Serializes every pick insert for one user for the length of the calling
// transaction. Released automatically at commit or rollback.
export async function lockUserPickInserts(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"pick-insert:" + userId}, 0))`;
}

function hitText(hit: DuplicateHit): string {
  return hit.existingPickId
    ? 'same bet as logged pick ' + hit.existingPickId + ' ("' + hit.existingLabel + '")'
    : 'same bet as "' + hit.existingLabel + '" earlier in the same import';
}

export async function insertPicksDeduped(
  userId: string,
  rows: DedupPickRow[],
  { readExistingPicks = defaultReadExistingPicks }: DedupInsertOptions = {}
): Promise<DedupInsertResult> {
  if (rows.length === 0) return { allowed: true, created: [], insertedIndexes: [], skippedDuplicates: [], overridden: [] };

  const result = await prisma.$transaction(async (tx): Promise<DedupInsertResult> => {
    await lockUserPickInserts(tx, userId);

    // Which existing capper / sport each row refers to. A capper or sport that
    // does not exist yet cannot have a logged pick, so those rows are only
    // compared with the earlier rows of this request.
    const existingCappers = await tx.capper.findMany({ where: { userId }, select: { id: true, name: true } });
    const capperIdByNormalizedName = new Map<string, string>();
    for (const c of existingCappers) {
      const key = normalizeName(c.name);
      if (key !== "" && !capperIdByNormalizedName.has(key)) capperIdByNormalizedName.set(key, c.id);
    }
    const sportNames = Array.from(new Set(rows.filter((r) => !r.sportId).map((r) => r.sportName.toLowerCase())));
    const sportIdByLowerName =
      sportNames.length === 0
        ? new Map<string, string>()
        : sportIdsByLowerName(
            await tx.sport.findMany({
              where: { OR: sportNames.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
              select: { id: true, name: true },
              orderBy: { id: "asc" },
            })
          );

    const prepared = rows.map((row, index) => {
      const normalized = normalizeName(row.capperName);
      const capperId = row.capperId ?? (normalized === "" ? undefined : capperIdByNormalizedName.get(normalized)) ?? null;
      const capperKey = capperId ?? "new:" + (normalized === "" ? "raw:" + row.capperName.trim().toLowerCase() : normalized);
      const sportId = row.sportId ?? sportIdByLowerName.get(row.sportName.toLowerCase()) ?? null;
      const identity = rowBetIdentity(row);
      const candidate: DbDupCandidate | null =
        capperId && sportId && isComparableBet(identity)
          ? {
              capperId,
              sportId,
              sportName: row.sportName,
              homeTeam: identity.homeTeam,
              awayTeam: identity.awayTeam,
              gameTimeMs: identity.gameTimeMs,
              period: identity.period,
              dedupKey: identity.category,
              sportKey: identity.sportKey,
              betType: row.betType,
              pickedSide: identity.pickedSide,
            }
          : null;
      return { row, index, capperKey, identity, candidate };
    });

    const where = existingPicksWhere(
      userId,
      prepared.flatMap((p) => (p.candidate ? [p.candidate] : [])),
      MAX_GAME_TIME_DRIFT_MS
    );
    const existingPicks = where ? await readExistingPicks(tx, where) : [];

    // In input order, "first one wins": a logged pick is checked first, then
    // the earlier rows of this request - every one of them, whether it was
    // itself kept or refused, so a third copy still matches the first.
    const skippedDuplicates: DuplicateHit[] = [];
    const overridden: DuplicateHit[] = [];
    const survivors: typeof prepared = [];
    const seen: typeof prepared = [];
    for (const p of prepared) {
      const label = p.row.betDetail || p.row.betType;
      let hit: DuplicateHit | null = null;
      const logged = p.candidate ? findDbDuplicate(existingPicks, p.candidate, MAX_GAME_TIME_DRIFT_MS) : null;
      if (logged) {
        hit = {
          index: p.index,
          capperName: p.row.capperName,
          label,
          existingPickId: logged.id,
          earlierIndex: null,
          existingLabel: existingPickLabel(logged),
        };
      } else if (isComparableBet(p.identity)) {
        const earlier = seen.find(
          (e) => e.capperKey === p.capperKey && isSameBet(e.identity, p.identity, MAX_GAME_TIME_DRIFT_MS)
        );
        if (earlier) {
          hit = {
            index: p.index,
            capperName: p.row.capperName,
            label,
            existingPickId: null,
            earlierIndex: earlier.index,
            existingLabel: earlier.row.betDetail || earlier.row.betType,
          };
        }
      }
      seen.push(p);
      if (hit && !p.row.overrideDuplicate) {
        skippedDuplicates.push(hit);
        continue;
      }
      if (hit) overridden.push(hit);
      survivors.push(p);
    }

    const inserted = await insertPicksInTransaction(tx, userId, survivors.length, async (db) => {
      // Rows that already carry ids (the manual form) are used as they are;
      // the rest have their capper and sport found or created here, inside the
      // transaction, exactly as before.
      const strip = ({ overrideDuplicate: _o, raw: _r, capperId: _c, sportId: _s, ...rest }: DedupPickRow) => rest;
      const needRefs = survivors.filter((p) => !(p.row.capperId && p.row.sportId));
      // The roster read at the top of this transaction (same lock) is passed on, not read again.
      const resolved = await resolveImportRefs(db, userId, needRefs.map((p) => strip(p.row)), existingCappers);
      const resolvedByIndex = new Map(needRefs.map((p, k) => [p.index, resolved[k]]));
      return survivors.map((p): PickInsertData => {
        const fromRefs = resolvedByIndex.get(p.index);
        if (fromRefs) return fromRefs;
        const { capperName: _n, sportName: _sn, ...rest } = strip(p.row);
        return { ...rest, capperId: p.row.capperId as string, sportId: p.row.sportId as string };
      });
    });

    if (!inserted.allowed) return { ...inserted, skippedDuplicates };
    return {
      allowed: true,
      created: inserted.created,
      insertedIndexes: survivors.map((p) => p.index),
      skippedDuplicates,
      overridden,
    };
  }, ENTITLEMENT_TX_OPTIONS);

  // After the commit, and never able to fail the import (see
  // recordImportSkippedLines). An override is only logged once its pick is
  // really in the table; a refused duplicate is logged either way.
  const entry = (hit: DuplicateHit, stage: SkippedLineEntry["stage"], prefix: string): SkippedLineEntry => {
    const row = rows[hit.index];
    return {
      stage,
      capperName: row.capperName,
      rawText: row.raw ?? row.betDetail ?? row.betType,
      guessedSport: row.sportName,
      reason: prefix + hitText(hit),
    };
  };
  await recordImportSkippedLines(userId, [
    ...result.skippedDuplicates.map((hit) => entry(hit, "DUPLICATE_SKIPPED", "Refused by the server-side duplicate check: ")),
    ...(result.allowed ? result.overridden.map((hit) => entry(hit, "DUPLICATE_OVERRIDDEN", "Imported anyway on an explicit override: ")) : []),
  ]);

  return result;
}

// ---- capper merge ----

// A pair of picks that become the same bet under one capper once two cappers
// are merged: `keptPickId` already belongs to the surviving capper,
// `movedPickId` is being reassigned to it. Reported, never acted on.
export type MergeDuplicatePick = {
  keptPickId: string;
  movedPickId: string;
  keptLabel: string;
  movedLabel: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
};

export type MergePickRow = ExistingPickRow & { sport: { name: string } };

// Every pick of the capper being merged away that is the same bet as a pick the
// surviving capper already has (first match each, both lists in id order).
// Pure - the merge itself moves every pick regardless.
export function findMergeDuplicates(keptPicks: MergePickRow[], movedPicks: MergePickRow[]): MergeDuplicatePick[] {
  const identify = (p: MergePickRow) => ({ p, identity: existingBetIdentity(p, p.sport.name, sportKeyForName(p.sport.name)) });
  const keptBySport = new Map<string, ReturnType<typeof identify>[]>();
  for (const p of keptPicks) {
    const entry = identify(p);
    if (!isComparableBet(entry.identity)) continue;
    const list = keptBySport.get(p.sportId);
    if (list) list.push(entry);
    else keptBySport.set(p.sportId, [entry]);
  }
  const out: MergeDuplicatePick[] = [];
  for (const p of movedPicks) {
    const moved = identify(p);
    if (!isComparableBet(moved.identity)) continue;
    const kept = (keptBySport.get(p.sportId) ?? []).find((k) => isSameBet(k.identity, moved.identity, MAX_GAME_TIME_DRIFT_MS));
    if (!kept) continue;
    out.push({
      keptPickId: kept.p.id,
      movedPickId: p.id,
      keptLabel: existingPickLabel(kept.p),
      movedLabel: existingPickLabel(p),
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      gameTime: p.gameTime,
    });
  }
  return out;
}
