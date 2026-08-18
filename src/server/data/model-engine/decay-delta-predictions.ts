// Build Step 7: Persist & Automate Decay Delta Predictions. Turns Build
// Steps 5 (historical backtest) and 6 (pregame evaluation) into an ongoing,
// growing system - a DecayDeltaPrediction row per real game, computed once
// and never recomputed once it has a real outcome. Reuses Build Step 5's
// own proven graded-row logic (actualFavWon, from the side-effect-free
// decay-delta-outcome.ts - NOT imported from decay-delta-backtest.ts itself,
// which has an unguarded top-level script entry point; see that file's own
// comment) and Build Step 6's pregame path (orchestrate.ts, pregame-facts.ts)
// directly - no separate reimplementation of either.
import { prisma } from "@/lib/prisma";
import { closestByTime, sameEasternDay } from "@/lib/dates";
import { runModelDefinition } from "./orchestrate";
import { getPregameEventFacts } from "./pregame-facts";
import { resolveAllGameObservations, type GameObservation } from "./observations";
import { actualFavWon, type GradedRow } from "./decay-delta-outcome";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import type { OddsGame } from "@/server/data/odds";
import type { DecayDeltaPrediction } from "@prisma/client";

const MODEL_ID = decayDeltaModel.modelId; // "decay-delta-v1" - read off the fixture itself, not hardcoded a second time

// Same wentOver/isPush-adjacent derivation observations.ts already uses
// (Build Step 2.5) - a push or a missing line both collapse to null here,
// since this table has no separate isPush field (not asked for by this
// step's spec; wentOver alone is enough to record "did this game's real
// total result exist and go over/under").
function deriveWentOver(row: { homeScore: number; awayScore: number; totalLine: number | null }): boolean | null {
  if (row.totalLine === null) return null;
  const actualTotal = row.homeScore + row.awayScore;
  if (actualTotal === row.totalLine) return null;
  return actualTotal > row.totalLine;
}

export type GradedComputation = {
  favTeam: string;
  dogTeam: string;
  totalLine: number | null;
  favRate: number;
  dogRate: number;
  delta: number;
  bucket: string;
  favWon: boolean;
  wentOver: boolean | null;
};

// The exact Build Step 5 computation (same runModelDefinition call, same
// asOf = the game's own gameDate, same bucket_decay_delta extraction) -
// returns null under the identical skip conditions decay-delta-backtest.ts
// already established (indeterminate actual outcome, or unavailableIds/no
// bucket matched).
export async function computeGradedDecayDelta(
  row: GradedRow & { totalLine: number | null },
  options?: { allObservations?: GameObservation[] }
): Promise<GradedComputation | null> {
  const favWon = actualFavWon(row);
  if (favWon === null) return null;

  const result = await runModelDefinition(decayDeltaModel, { gameResultId: row.id, asOf: row.gameDate }, options);
  const bucket = result.buckets["bucket_decay_delta"];
  if (!bucket.found || bucket.ruleId === null) return null;

  return {
    favTeam: row.favTeam!,
    dogTeam: row.favTeam === row.homeTeam ? row.awayTeam : row.homeTeam,
    totalLine: row.totalLine,
    favRate: result.context["calc_fav_pct"] as number,
    dogRate: result.context["calc_dog_pct"] as number,
    delta: result.context["dv_decay_delta"] as number,
    bucket: bucket.ruleId,
    favWon,
    wentOver: deriveWentOver(row),
  };
}

// Finds an existing PREGAME row (gameResultId still null) for this same
// real-world game, so grading can update it in place instead of inserting a
// duplicate. GameResult.gameDate (MLB Stats API) and the pregame row's own
// gameDate (originally OddsSnapshot's commenceTime, a DIFFERENT upstream
// API) aren't guaranteed byte-identical, so this can't match on exact
// equality - same repeat-matchup-safe pattern odds.ts's matchScoreToGame
// already uses to reconcile odds-sourced and score-sourced game identity:
// same Eastern calendar day, then closest by time if more than one
// candidate (e.g. a doubleheader's two games against the same opponent).
async function findExistingPregameRow(
  sportKey: string,
  homeTeam: string,
  awayTeam: string,
  referenceDate: Date
): Promise<DecayDeltaPrediction | null> {
  const candidates = await prisma.decayDeltaPrediction.findMany({
    where: { modelId: MODEL_ID, sportKey, homeTeam, awayTeam, gameResultId: null },
  });
  const sameDay = candidates.filter((c) => sameEasternDay(c.gameDate, referenceDate));
  if (sameDay.length === 0) return null;
  if (sameDay.length === 1) return sameDay[0];
  return closestByTime(sameDay, (c) => c.gameDate.getTime(), referenceDate.getTime());
}

export type GradedSyncResult = {
  scanned: number;
  alreadyPersisted: number;
  newlyPersisted: number;
  convertedFromPregame: number;
  skipped: number;
};

// Incremental, not a re-run of the whole history: scans already-graded
// GameResult rows (same criteria decay-delta-backtest.ts uses - favTeam +
// totalLine populated), then processes only the ones that don't already
// have a DecayDeltaPrediction row for this gameResultId. An existing graded
// row is NEVER re-fetched into computation at all - its id is excluded from
// the pending set up front, so runModelDefinition never runs for it again.
export async function persistGradedDecayDeltaGames(sportKey: string): Promise<GradedSyncResult> {
  const games = await prisma.gameResult.findMany({
    where: { sportKey, favTeam: { not: null }, totalLine: { not: null } },
    orderBy: { gameDate: "asc" },
  });

  const existing = await prisma.decayDeltaPrediction.findMany({
    where: { modelId: MODEL_ID, gameResultId: { not: null } },
    select: { gameResultId: true },
  });
  const alreadyPersistedIds = new Set(existing.map((r) => r.gameResultId!));

  const pending = games.filter((row) => !alreadyPersistedIds.has(row.id));

  let newlyPersisted = 0;
  let convertedFromPregame = 0;
  let skipped = 0;

  if (pending.length > 0) {
    // Same Build Step 5 performance fix (fetch/derive the sport's full
    // observation history ONCE, reuse per row) - applies whether this call
    // is a from-scratch backfill (hundreds of pending rows) or a routine
    // incremental cron pass (usually a handful), so the cron never
    // regresses back into per-row O(N^2) table scans either.
    const allObservations = await resolveAllGameObservations(sportKey);

    for (const row of pending) {
      const favWon = actualFavWon(row);
      if (favWon === null) {
        skipped++;
        continue;
      }
      const wentOver = deriveWentOver(row);

      // Check for a pregame row to convert BEFORE running any model math -
      // if one exists, its favRate/dogRate/delta/bucket were already
      // computed (Build Step 6, same-day asOf) and are mathematically
      // identical to what a fresh graded computation would produce (both
      // exclude the same set of prior games via the same Eastern-day
      // boundary) - so this only ever fills in the outcome, never
      // recomputes the prediction itself.
      const pregameRow = await findExistingPregameRow(sportKey, row.homeTeam, row.awayTeam, row.gameDate);
      if (pregameRow) {
        await prisma.decayDeltaPrediction.update({
          where: { id: pregameRow.id },
          data: { gameResultId: row.id, favWon, wentOver, gradedAt: new Date() },
        });
        convertedFromPregame++;
        continue;
      }

      const computation = await computeGradedDecayDelta(row, { allObservations });
      if (!computation) {
        skipped++;
        continue;
      }

      await prisma.decayDeltaPrediction.create({
        data: {
          modelId: MODEL_ID,
          gameResultId: row.id,
          sportKey,
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          gameDate: row.gameDate,
          favTeam: computation.favTeam,
          dogTeam: computation.dogTeam,
          totalLine: computation.totalLine,
          favRate: computation.favRate,
          dogRate: computation.dogRate,
          delta: computation.delta,
          bucket: computation.bucket,
          favWon: computation.favWon,
          wentOver: computation.wentOver,
          gradedAt: new Date(),
        },
      });
      newlyPersisted++;
    }
  }

  return { scanned: games.length, alreadyPersisted: alreadyPersistedIds.size, newlyPersisted, convertedFromPregame, skipped };
}

export type PregameSyncResult = { candidateGames: number; alreadyCovered: number; newlyPersisted: number; skipped: number };

// Today's not-yet-started games (Build Step 6, same OddsSnapshot read path
// as pregame-acceptance-test.ts), each inserted at most once. "Already
// covered" is checked by EXACT gameDate equality against this same game's
// own commenceTime - safe here (unlike findExistingPregameRow above)
// because both sides come from the SAME source (today's cached
// OddsSnapshot row) read on every call, so a real repeat cron run sees the
// identical commenceTime value, while a genuine doubleheader's two games
// against the same opponent have genuinely different commenceTime values
// and correctly get two separate rows.
export async function persistPregameDecayDeltaGames(sportKey: string): Promise<PregameSyncResult> {
  const now = new Date();

  const snapshot = await prisma.oddsSnapshot.findFirst({ where: { sportKey }, orderBy: { fetchDate: "desc" } });
  if (!snapshot) return { candidateGames: 0, alreadyCovered: 0, newlyPersisted: 0, skipped: 0 };

  const games = snapshot.data as unknown as OddsGame[];
  const notStarted = games.filter((g) => new Date(g.commenceTime) > now);

  let alreadyCovered = 0;
  let newlyPersisted = 0;
  let skipped = 0;

  for (const g of notStarted) {
    const commenceTime = new Date(g.commenceTime);

    const candidates = await prisma.decayDeltaPrediction.findMany({
      where: { modelId: MODEL_ID, sportKey, homeTeam: g.homeTeam, awayTeam: g.awayTeam },
      select: { gameDate: true },
    });
    if (candidates.some((c) => c.gameDate.getTime() === commenceTime.getTime())) {
      alreadyCovered++;
      continue;
    }

    const pregame = await getPregameEventFacts(sportKey, g.homeTeam, g.awayTeam);
    if (!pregame || pregame.favTeam === null) {
      skipped++;
      continue;
    }

    const result = await runModelDefinition(decayDeltaModel, { sportKey, homeTeam: g.homeTeam, awayTeam: g.awayTeam, asOf: now });
    const bucket = result.buckets["bucket_decay_delta"];
    if (!bucket.found || bucket.ruleId === null) {
      skipped++;
      continue;
    }

    const dogTeam = pregame.favTeam === g.homeTeam ? g.awayTeam : g.homeTeam;

    await prisma.decayDeltaPrediction.create({
      data: {
        modelId: MODEL_ID,
        gameResultId: null,
        sportKey,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        gameDate: pregame.commenceTime,
        favTeam: pregame.favTeam,
        dogTeam,
        totalLine: pregame.totalLine,
        favRate: result.context["calc_fav_pct"] as number,
        dogRate: result.context["calc_dog_pct"] as number,
        delta: result.context["dv_decay_delta"] as number,
        bucket: bucket.ruleId,
        // favWon/wentOver/gradedAt intentionally omitted - stay null until
        // persistGradedDecayDeltaGames converts this same row later.
      },
    });
    newlyPersisted++;
  }

  return { candidateGames: notStarted.length, alreadyCovered, newlyPersisted, skipped };
}

export async function syncDecayDeltaPredictions(sportKey: string) {
  // Graded first - so any of today's own early games that already finished
  // get their pregame rows converted before the pregame pass below looks at
  // what's left (commenceTime > now already excludes anything finished
  // either way, but this keeps the two passes in the same "settle the past,
  // then look ahead" order the cron itself follows).
  const graded = await persistGradedDecayDeltaGames(sportKey);
  const pregame = await persistPregameDecayDeltaGames(sportKey);
  return { graded, pregame };
}

export type BucketWinRate = { bucket: string; n: number; wins: number; winPct: number | null };

// A live query over the persisted table, not a stored/frozen snapshot -
// grouped and computed fresh on every call, so it improves automatically as
// syncDecayDeltaPredictions adds more graded rows over time, with no
// separate "refresh the stats" step anywhere. Two groupBy calls (total per
// bucket, wins per bucket) rather than one raw SQL aggregate - Prisma's
// groupBy has no filtered-count-within-a-group primitive, and this project
// doesn't use $queryRaw anywhere else.
export async function getDecayDeltaBucketWinRates(sportKey: string): Promise<BucketWinRate[]> {
  const totals = await prisma.decayDeltaPrediction.groupBy({
    by: ["bucket"],
    where: { modelId: MODEL_ID, sportKey, favWon: { not: null } },
    _count: { _all: true },
  });
  const wins = await prisma.decayDeltaPrediction.groupBy({
    by: ["bucket"],
    where: { modelId: MODEL_ID, sportKey, favWon: true },
    _count: { _all: true },
  });

  const totalByBucket = new Map(totals.map((t) => [t.bucket, t._count._all]));
  const winsByBucket = new Map(wins.map((w) => [w.bucket, w._count._all]));

  // Document order (the fixture's own rule list), matching Build Step 5's
  // report ordering - not groupBy's arbitrary return order.
  return decayDeltaModel.buckets[0].rules.map((rule) => {
    const n = totalByBucket.get(rule.id) ?? 0;
    const wins = winsByBucket.get(rule.id) ?? 0;
    return { bucket: rule.id, n, wins, winPct: n > 0 ? (wins / n) * 100 : null };
  });
}
