import { persistFinalScores } from "@/server/data/grading";
import { RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { recomputeTeamTendencies, snapshotTeamTendencies } from "@/server/data/team-tendencies";
import { captureTeamStatSnapshots, capturePitcherStatSnapshots, captureNflTeamStatSnapshots } from "@/server/data/stat-snapshots";
import { syncDecayDeltaPredictions } from "@/server/data/model-engine/decay-delta-predictions";

const MLB_SPORT_KEY = "baseball_mlb";

export const dynamic = "force-dynamic";

// Instrumentation: like grade-picks/route.ts, this route emits one structured
// console.log line tagged "refresh-scores-run" per invocation - total
// wall-clock plus per-sport per-phase durations (persist / tendency recompute
// / snapshot) and the row/blob counts recomputeTeamTendencies scanned. It is
// measurement only: no extra query, no write, no branching on the captured
// values. The per-sport history scan in recomputeTeamTendencies is M9 in the
// scale audit - the calculation is all-captured-history by design, so these
// counts are what tell us when the larger fix is worth its cost. See
// docs/m9-team-tendencies.md.

// Awaits `fn` and returns its value alongside the elapsed milliseconds. Pure
// timing wrapper - preserves the original sequential await order.
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const value = await fn();
  return [value, Date.now() - start];
}

// Vercel Cron hits this once daily. Without it, GameResult only ever gets
// populated as a side effect of someone loading /picks or /live/[gameId] -
// getLiveScoresForSport's yesterday/today/tomorrow window means a finished
// game whose result is never captured within about a day of finishing can
// never be backfilled at all (no historical fetch path exists). This
// guarantees every sport's games get persisted at least once a day
// regardless of site traffic, so findMatchingGameResult (used by both the
// pending-picks triage view and gradePendingPicks) always has something to
// match against once a game is final.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== "Bearer " + cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const runStart = Date.now();

  const results = await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const [persisted, persistMs] = await timed(() => persistFinalScores(sportKey));
      // Recompute right after this sport's scores are persisted, so a
      // freshly-final game is reflected in tendencies the same run it
      // lands in GameResult, not a day later on the next cron pass.
      const [tendencies, tendencyMs] = await timed(() => recomputeTeamTendencies(sportKey));
      // Preserves today's cumulative counts as a dated row - pure DB
      // read-then-write of what recomputeTeamTendencies just computed, no
      // extra API calls. Without this, TeamTendency's history is lost the
      // moment tomorrow's recompute overwrites it in place.
      const [tendencySnapshots, snapshotMs] = await timed(() => snapshotTeamTendencies(sportKey));
      return {
        sport: sportKey,
        persisted,
        tendencies,
        tendencySnapshots,
        timing: {
          persistMs,
          tendencyMs,
          snapshotMs,
          gameResultRows: tendencies.gameResultRows,
          oddsSnapshotRows: tendencies.oddsSnapshotRows,
          oddsGamesFlattened: tendencies.oddsGamesFlattened,
          gamesProcessed: tendencies.gamesProcessed,
          teamsUpdated: tendencies.teamsUpdated,
        },
      };
    })
  );

  // MLB-only, same as first-five/NRFI grading elsewhere in this app - the
  // snapshot fields (team hitting/pitching aggregates, probable-starter
  // lookup) are all sourced from MLB Stats API endpoints with no equivalent
  // wired up for the ESPN-backed sports yet. Piggybacked on this same cron
  // run (not a new schedule entry) per the model builder's provider-registry
  // design - these snapshots are what eventually lets team_stats/
  // pitcher_stats condition backtesting move off "unsupported."
  const teamSnapshots = await captureTeamStatSnapshots();
  const { starters, pitcherSnapshots } = await capturePitcherStatSnapshots();

  // NFL team-stat snapshots from nflverse's static CSV releases (no API key,
  // no rate limit, no credit cost - nothing to throttle, unlike the Odds
  // API). Same piggyback-the-cron pattern as the MLB snapshots above. Runs
  // unconditionally: nflverse has no preseason data and no current-season
  // file until Week 1, and captureNflTeamStatSnapshots returns zero rows
  // without error in that window rather than needing a season gate here.
  const nflTeamSnapshots = await captureNflTeamStatSnapshots();

  // Build Step 7 - piggybacked on this same cron run, right after this
  // sport's scores are persisted above, same reasoning as the tendency
  // recompute: a freshly-graded game gets its DecayDeltaPrediction row (or
  // has its existing pregame row converted) the same run it lands in
  // GameResult, not a day later. MLB-only, matching the Decay Delta fixture
  // itself (decayDeltaModel.sport === "baseball_mlb") - not looped over
  // RESOLVABLE_SPORT_KEYS like the scores/tendencies above.
  const decayDeltaPredictions = await syncDecayDeltaPredictions(MLB_SPORT_KEY);

  // Measurement only (see docs/m9-team-tendencies.md). One line per run so the
  // tendency-recompute scan size and per-phase timing are queryable from
  // Vercel runtime logs without opening each response body.
  console.log(
    JSON.stringify({
      tag: "refresh-scores-run",
      totalMs: Date.now() - runStart,
      sports: results.map((r) => ({ sport: r.sport, ...r.timing })),
    })
  );

  return Response.json({
    ok: true,
    results,
    statSnapshots: { sport: MLB_SPORT_KEY, teamSnapshots, pitcherSnapshots, gameStarters: starters },
    nflTeamSnapshots,
    decayDeltaPredictions,
  });
}
