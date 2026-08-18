// Build Step 5: Historical Bucket Backtest. Runs the real Decay Delta Model
// Definition (lib/model-engine/fixtures/decay-delta.ts) through orchestration
// once per already-graded historical game, using that game's OWN gameDate as
// asOf - resolveGameObservations' existing gameDate >= asOf exclusion (Build
// Step 2.5) then automatically keeps that game (and anything after it) out
// of its own prediction, with no new lookahead-safety logic needed here.
// Buckets each game's dv_decay_delta using the fixture's own already-
// established bucket definition, then reports actual sample size/win%
// per bucket. Fully read-only - no persistFinalScores() call, no writes to
// any table. Run with:
//   npx tsx src/server/data/model-engine/decay-delta-backtest.ts
import { prisma } from "@/lib/prisma";
import { runModelDefinition } from "./orchestrate";
import { resolveAllGameObservations } from "./observations";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import { actualFavWon, type GradedRow } from "./decay-delta-outcome";

// Stated low-confidence threshold per this step's spec - not a reuse of the
// unrelated capper-leaderboard RANKING_MIN_SAMPLE constant (a different
// domain's own judgment call), just this script's own explicit bar.
const MIN_SAMPLE = 10;

async function main() {
  const sportKey = "baseball_mlb";

  // "Already graded" = a real final-score GameResult row with the ledger
  // fields populated (favTeam/totalLine) - matches the spec's own definition
  // literally, even though this particular model only actually needs
  // favTeam (totalLine only matters for wentOver/isPush, which decay-delta.ts
  // never references).
  const games: GradedRow[] = await prisma.gameResult.findMany({
    where: { sportKey, favTeam: { not: null }, totalLine: { not: null } },
    orderBy: { gameDate: "asc" },
    select: { id: true, favTeam: true, homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
  });

  const rules = decayDeltaModel.buckets[0].rules; // document order, reused verbatim - not re-invented here
  const bucketCounts = new Map<string, { n: number; wins: number }>();
  for (const rule of rules) bucketCounts.set(rule.id, { n: 0, wins: 0 });

  let evaluated = 0;
  let skippedUnavailable = 0;
  let skippedNoActualOutcome = 0;

  const samples: { gameId: string; favTeam: string; dogTeam: string; gameDate: Date; delta: number; ruleId: string; favWon: boolean }[] = [];

  // Fetched + derived ONCE for the whole backtest (Build Step 5 performance
  // fix), then reused for every one of the 832 games below via
  // runModelDefinition's options.allObservations - each call still only ever
  // sees observations strictly before its own gameDate (same
  // filterObservationsBeforeAsOf boundary orchestrate.ts always used), this
  // just avoids re-querying and re-deriving the whole sportKey-scoped
  // GameResult table from scratch on every iteration.
  const fetchStart = Date.now();
  const allObservations = await resolveAllGameObservations(sportKey);
  const fetchMs = Date.now() - fetchStart;
  console.log(`Fetched full ${sportKey} observation history once: ${allObservations.length} observations in ${fetchMs}ms.`);

  const start = Date.now();
  for (const row of games) {
    const won = actualFavWon(row);
    if (won === null) {
      skippedNoActualOutcome++;
      continue;
    }

    const result = await runModelDefinition(decayDeltaModel, { gameResultId: row.id, asOf: row.gameDate }, { allObservations });
    const bucket = result.buckets["bucket_decay_delta"];
    if (!bucket.found || bucket.ruleId === null) {
      skippedUnavailable++;
      continue;
    }

    evaluated++;
    const entry = bucketCounts.get(bucket.ruleId)!;
    entry.n++;
    if (won) entry.wins++;

    samples.push({
      gameId: row.id,
      favTeam: row.favTeam!,
      dogTeam: row.favTeam === row.homeTeam ? row.awayTeam : row.homeTeam,
      gameDate: row.gameDate,
      delta: result.context["dv_decay_delta"] as number,
      ruleId: bucket.ruleId,
      favWon: won,
    });
  }
  const elapsedMs = Date.now() - start;

  console.log(`\nPulled ${games.length} already-graded ${sportKey} GameResult rows (favTeam + totalLine populated).\n`);

  console.log("========== Bucket performance (Decay Delta, bucket_decay_delta) ==========");
  for (const rule of rules) {
    const c = bucketCounts.get(rule.id)!;
    const winPct = c.n > 0 ? ((c.wins / c.n) * 100).toFixed(1) + "%" : "n/a";
    const flag = c.n > 0 && c.n < MIN_SAMPLE ? `  [LOW CONFIDENCE: n < ${MIN_SAMPLE}]` : "";
    console.log(`${rule.id.padEnd(20)} when=${JSON.stringify(rule.when).padEnd(24)} n=${String(c.n).padStart(4)}  wins=${String(c.wins).padStart(4)}  win%=${winPct}${flag}`);
  }

  console.log("\n========== Evaluation summary ==========");
  console.log(`Total already-graded rows pulled: ${games.length}`);
  console.log(`Evaluated (bucket resolved + actual outcome known): ${evaluated}`);
  console.log(`Skipped - unavailableIds (insufficient prior history, e.g. early-season games): ${skippedUnavailable}`);
  console.log(`Skipped - no determinable actual favorite outcome (null favTeam/mismatched team names/tie): ${skippedNoActualOutcome}`);
  console.log(`(games pulled = evaluated + both skip categories: ${evaluated} + ${skippedUnavailable} + ${skippedNoActualOutcome} = ${evaluated + skippedUnavailable + skippedNoActualOutcome})`);

  console.log("\n========== Runtime ==========");
  console.log(`Observation history fetch (once, up front): ${fetchMs}ms.`);
  console.log(`Per-game evaluation loop: ${elapsedMs}ms total for ${games.length} rows (${(elapsedMs / games.length).toFixed(1)}ms/row avg).`);
  console.log(
    "Note: the observation history (the O(N^2) cost in the original run - a full sportKey-scoped GameResult table scan re-run per game) is now fetched/derived once and reused. " +
      "Each row still does its own facts lookup plus 2 fresh resolveVariable snapshot lookups (di_fav_rate/di_dog_rate) - no caching/persistence across rows for those. " +
      "Fine at this row count; would need a persisted/cached bucket result per row (not built here, per the spec) before scaling to a much larger table or a repeated-run workflow."
  );

  console.log("\n========== Spot-check (first / middle / last evaluated game) ==========");
  const spotIndices = [0, Math.floor(samples.length / 2), samples.length - 1];
  for (const i of spotIndices) {
    const s = samples[i];
    if (!s) continue;
    console.log(
      `gameId=${s.gameId}  ${s.gameDate.toISOString().slice(0, 10)}  favTeam="${s.favTeam}" dogTeam="${s.dogTeam}"  ` +
        `dv_decay_delta=${s.delta}  -> bucket=${s.ruleId}  (favorite actually won: ${s.favWon})`
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
