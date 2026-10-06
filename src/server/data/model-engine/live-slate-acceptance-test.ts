// Build Step 4 - proof that the engine (Build Steps 1-3c) runs end-to-end
// against today's REAL, LIVE data, not just historical seed data through
// acceptance-test fixtures. A script, not a UI/API route/production
// feature. Run with
// `npx tsx src/server/data/model-engine/live-slate-acceptance-test.ts`.
//
// A real seam surfaced while building this, worth stating up front:
// runModelDefinition requires a persisted GameResult row (via
// getEvaluationEventFacts), but GameResult is only populated once a game
// goes FINAL (persistFinalScores, normally called by the daily cron or when
// someone loads /picks or /live/[gameId]). The live odds slate
// (getOddsForSport) by design only lists games that haven't started yet at
// cache time. So "today's slate" and "what the engine can evaluate" are on
// different population schedules - a game still pregame or in progress has
// no GameResult row yet, and no fake one is created here. PART A below
// calls the SAME already-in-production persistFinalScores() the app
// already relies on (not new code, not synthetic data - it only writes a
// real final score for a genuinely finished game) so today's slate is
// checked against the freshest real data available at run time, then
// reports "not available" (not a crash, not a guess) for any game still in
// progress or not yet started.
import { prisma } from "@/lib/prisma";
import { getOddsForSport, type OddsGame } from "@/server/data/odds";
import { persistFinalScores } from "@/server/data/grading";
import { runModelDefinition, type OrchestrationResult } from "./orchestrate";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import { easternDateKey, closestByTime, sameEasternDay } from "@/lib/dates";
import type { GameResult } from "@prisma/client";

const SPORT_KEY = "baseball_mlb";

// Same matching approach the app's own resolveOddsGame/matchScoreToGame
// (src/server/data/odds.ts) already use elsewhere - team pair, then closest
// time if more than one candidate. Critically, this is scoped to the SAME
// Eastern calendar day as the odds game's own commenceTime first - an
// unscoped team-pair-only match would happily match today's still-in-
// progress game to a PAST game between the same two teams (MLB series are
// often 3-4 games against the same opponent on consecutive days), silently
// substituting a stale result for a live one. Caught exactly this bug
// empirically on the first run of this script (today's slate came back
// identical to yesterday's PART B numbers) before adding this filter.
async function findGameResultForOddsGame(g: OddsGame): Promise<GameResult | null> {
  const candidates = await prisma.gameResult.findMany({
    where: { sportKey: SPORT_KEY, homeTeam: g.homeTeam, awayTeam: g.awayTeam },
  });
  const commenceDate = new Date(g.commenceTime);
  const sameDay = candidates.filter((r) => sameEasternDay(r.gameDate, commenceDate));
  if (sameDay.length === 0) return null;
  if (sameDay.length === 1) return sameDay[0];
  return closestByTime(sameDay, (r) => r.gameDate.getTime(), commenceDate.getTime());
}

function printOrchestrationResult(label: string, favTeam: string, dogTeam: string, result: OrchestrationResult) {
  console.log(`\n--- ${label} ---`);
  console.log(`favTeam=${favTeam}, dogTeam=${dogTeam}`);
  console.log("calc_fav_weighted (raw fav rate):", result.context["calc_fav_weighted"]);
  console.log("calc_dog_weighted (raw dog rate):", result.context["calc_dog_weighted"]);
  console.log("calc_fav_pct (rounded fav %):", result.context["calc_fav_pct"]);
  console.log("calc_dog_pct (rounded dog %):", result.context["calc_dog_pct"]);
  console.log("dv_decay_delta (final delta):", result.context["dv_decay_delta"]);
  console.log("outcome_edge:", result.outcomes["outcome_edge"]);
  console.log("bucket_decay_delta:", result.buckets["bucket_decay_delta"]);
  console.log("unavailableIds:", [...result.unavailableIds]);
}

async function runForGameResult(label: string, row: GameResult, asOf: Date): Promise<void> {
  if (!row.favTeam) {
    console.log(`\n--- ${label} ---`);
    console.log(
      "SKIPPED: this GameResult row has no favTeam (no odds ledger data was matched at grading time) - Decay Delta needs a favorite/underdog to evaluate, so there's nothing to run."
    );
    return;
  }
  const dogTeam = row.favTeam === row.homeTeam ? row.awayTeam : row.homeTeam;
  const result = await runModelDefinition(decayDeltaModel, { gameResultId: row.id, asOf });
  printOrchestrationResult(label, row.favTeam, dogTeam, result);
}

async function main() {
  const now = new Date();
  console.log(`Build Step 4 live-slate proof - run at ${now.toISOString()}`);

  console.log("\n########## PART A: today's REAL live odds slate ##########");
  // Refresh against the freshest real data available right now - the same
  // already-in-production function the cron/`/picks`/`/live/[gameId]` pages
  // already call (see header comment) - so any of today's games that have
  // actually finished by the moment this script runs get a real GameResult
  // row before checking.
  const persisted = await persistFinalScores(SPORT_KEY);
  console.log(`persistFinalScores("${SPORT_KEY}") persisted/updated ${persisted} row(s) (today's and any other still-uncaptured recent finals)`);

  const slate = await getOddsForSport(SPORT_KEY);
  console.log(`getOddsForSport("${SPORT_KEY}") returned ${slate.length} real games on today's slate:`);

  let availableCount = 0;
  for (const g of slate) {
    const label = `${g.awayTeam} @ ${g.homeTeam} (commence ${g.commenceTime})`;
    const row = await findGameResultForOddsGame(g);
    if (!row) {
      console.log(`\n--- ${label} ---`);
      console.log(
        "NOT AVAILABLE: no GameResult row exists for this game yet - it hasn't finished/been graded at this moment. Expected, not a crash: runModelDefinition requires a persisted GameResult (via getEvaluationEventFacts), which is only written once a game goes final."
      );
      continue;
    }
    await runForGameResult(label, row, now);
    availableCount++;
  }
  console.log(
    `\nPART A summary: ${availableCount} of ${slate.length} real slate games were runnable through the engine at this exact moment (the rest correctly reported not available - still pregame/in-progress right now).`
  );

  console.log("\n\n########## PART B: real, live-pipeline-sourced completed games (sanity check) ##########");
  // PART A may legitimately show few or zero of today's slate finished yet
  // (see header comment). This runs the SAME real engine against real games
  // the exact same live pipeline (getLiveScoresForSport -> persistFinalScores,
  // called above) already captured as final - genuine live-sourced data, not
  // the historical seed fixtures 3c's own acceptance test used, just not
  // necessarily from today's specific slate if nothing on it has finished
  // yet at run time.
  const recentRows = await prisma.gameResult.findMany({
    where: { sportKey: SPORT_KEY, favTeam: { not: null } },
    orderBy: { gameDate: "desc" },
    take: 6,
  });
  for (const row of recentRows) {
    await runForGameResult(`${row.awayTeam} @ ${row.homeTeam}, ${easternDateKey(row.gameDate)}`, row, now);
  }

  await prisma.$disconnect();
}

main();
