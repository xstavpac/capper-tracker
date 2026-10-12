// The "is this pasted pick already logged?" half of catalog-import duplicate
// detection (checkDuplicatePicksAction), as one database read for the whole
// paste instead of one per pick.
//
// It used to issue a pick.findMany per pasted pick that resolved to a game and
// an existing capper - about a hundred statements for a hundred-pick paste, all
// queued on the instance's small connection pool at once. Now:
//
//   existingPicksWhere(...)   one WHERE that is a SUPERSET of every per-pick
//                             query: this user's picks for the cappers and
//                             sports in the paste, across the span of the
//                             paste's game times (plus the drift tolerance).
//   dbDuplicateLabel(...)     re-applies, per pasted pick, EVERY predicate the
//                             old per-pick WHERE applied (capper, sport, home
//                             team, away team, game-time window) and then the
//                             same period / category / dedupCategory test.
//
// So the result is the same as long as both see the rows in the same order.
// The old query had no ORDER BY (whichever matching row Postgres returned first
// supplied the label); callers of this now order by id so the label is
// deterministic when a capper already has two matching rows.
//
// Parity with the per-pick version is proven by
// duplicate-db-match-acceptance-test.ts.
import type { Pick as PickRow, Prisma } from "@prisma/client";
import { betTypeLabel } from "@/lib/bet-line";
import { dedupCategory, isComparableBet, isSameBet, type BetIdentity } from "@/lib/duplicate-pick-detection";
import { pickCategory } from "@/server/data/stats";

// Exactly the columns the match below reads - the full row (notes, timestamps,
// grading fields...) used to be fetched for every candidate.
export const EXISTING_PICK_SELECT = {
  id: true,
  capperId: true,
  sportId: true,
  homeTeam: true,
  awayTeam: true,
  gameTime: true,
  period: true,
  betType: true,
  betDetail: true,
  odds: true,
  line: true,
  pickedSide: true,
  mlFavoredSide: true,
  propMarket: true,
  playerName: true,
} as const satisfies Prisma.PickSelect;

export type ExistingPickRow = Pick<PickRow, keyof typeof EXISTING_PICK_SELECT>;

// One pasted pick that resolved to a real game, an existing capper and an
// existing sport - the only kind that can have a logged duplicate.
export type DbDupCandidate = {
  capperId: string;
  sportId: string;
  // The pasted pick's own sport label (what pickCategory needs to tell F5 from
  // a first half) - the existing row is categorized under it, as before.
  sportName: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeMs: number;
  period: string;
  // dedupCategory(...) of the pasted pick. null only for a moneyline with no
  // readable favourite/underdog side, which is compared on pickedSide instead.
  dedupKey: string | null;
  // What isSameBet needs beyond the category (see its comment). Optional: a
  // caller without them gets the category-only comparison.
  sportKey?: string;
  betType?: ExistingPickRow["betType"];
  pickedSide?: "HOME" | "AWAY" | null;
};

// The one WHERE for the whole paste, or null when no pasted pick can have a
// logged duplicate (nothing to read). Deliberately coarse: homeTeam/awayTeam
// and each pick's own time window are applied in dbDuplicateLabel, so the
// statement stays small however many picks are pasted.
export function existingPicksWhere(
  userId: string,
  candidates: Pick<DbDupCandidate, "capperId" | "sportId" | "gameTimeMs">[],
  driftMs: number
): Prisma.PickWhereInput | null {
  if (candidates.length === 0) return null;
  const times = candidates.map((c) => c.gameTimeMs);
  return {
    userId,
    capperId: { in: Array.from(new Set(candidates.map((c) => c.capperId))) },
    sportId: { in: Array.from(new Set(candidates.map((c) => c.sportId))) },
    gameTime: { gte: new Date(Math.min(...times) - driftMs), lte: new Date(Math.max(...times) + driftMs) },
  };
}

// A logged pick as isSameBet sees it. Categorized under the pasted pick's own
// sport label (what pickCategory needs to tell F5 from a first half), as before.
// p.propMarket/p.playerName are the row's own stored columns (set at import
// time) - passed straight through so dedupCategory doesn't re-derive them from
// betDetail; null for any row predating those columns, which it re-parses.
export function existingBetIdentity(p: ExistingPickRow, sportName: string, sportKey?: string): BetIdentity {
  const pCategory = pickCategory({ ...p, sportName });
  const knownPlayerProp = p.propMarket && p.playerName ? { propMarket: p.propMarket, playerName: p.playerName } : null;
  return {
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTimeMs: p.gameTime.getTime(),
    sportKey,
    period: p.period,
    betType: p.betType,
    category: pCategory ? dedupCategory(pCategory, p.betType, p.betDetail, p.pickedSide, knownPlayerProp) : null,
    pickedSide: p.pickedSide,
  };
}

// The first logged pick that is the same bet as `candidate`, or null. `rows`
// may be the whole paste's superset read - capper and sport are re-checked
// here, and isSameBet re-checks the game (team names across feed spellings,
// game-time window), the game segment and the bet.
// Scoped to sportId so "same game" matches what getPicksForGame (picks.ts)
// considers the same game - without that scope, a same-named team in a
// different sport could flag a duplicate the game's own expander never shows.
export function findDbDuplicate(rows: ExistingPickRow[], candidate: DbDupCandidate, driftMs: number): ExistingPickRow | null {
  const wanted: BetIdentity = {
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    gameTimeMs: candidate.gameTimeMs,
    sportKey: candidate.sportKey,
    period: candidate.period,
    betType: candidate.betType,
    category: candidate.dedupKey,
    pickedSide: candidate.pickedSide,
  };
  if (!isComparableBet(wanted)) return null;
  return (
    rows.find((p) => {
      if (p.capperId !== candidate.capperId || p.sportId !== candidate.sportId) return false;
      return isSameBet(existingBetIdentity(p, candidate.sportName, candidate.sportKey), wanted, driftMs);
    }) ?? null
  );
}

export function existingPickLabel(p: Pick<ExistingPickRow, "betDetail" | "betType">): string {
  return p.betDetail || betTypeLabel(p.betType);
}

// The label of the first logged pick that is the same bet as `candidate`, or null.
export function dbDuplicateLabel(rows: ExistingPickRow[], candidate: DbDupCandidate, driftMs: number): string | null {
  const dbDup = findDbDuplicate(rows, candidate, driftMs);
  return dbDup ? existingPickLabel(dbDup) : null;
}

// Sport ids for the paste's sport names, matched case-insensitively as the old
// per-name findFirst did. `sports` is one findMany for all the names, ordered
// by id, so a name with case-variant rows resolves to the same row every time.
export function sportIdsByLowerName(sports: { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sports) {
    const key = s.name.toLowerCase();
    if (!out.has(key)) out.set(key, s.id);
  }
  return out;
}
