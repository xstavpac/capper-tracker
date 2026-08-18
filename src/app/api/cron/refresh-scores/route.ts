import { persistFinalScores } from "@/server/data/grading";
import { RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { recomputeTeamTendencies, snapshotTeamTendencies } from "@/server/data/team-tendencies";
import { captureTeamStatSnapshots, capturePitcherStatSnapshots } from "@/server/data/stat-snapshots";
import { syncDecayDeltaPredictions } from "@/server/data/model-engine/decay-delta-predictions";

const MLB_SPORT_KEY = "baseball_mlb";

export const dynamic = "force-dynamic";

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

  const results = await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const persisted = await persistFinalScores(sportKey);
      // Recompute right after this sport's scores are persisted, so a
      // freshly-final game is reflected in tendencies the same run it
      // lands in GameResult, not a day later on the next cron pass.
      const tendencies = await recomputeTeamTendencies(sportKey);
      // Preserves today's cumulative counts as a dated row - pure DB
      // read-then-write of what recomputeTeamTendencies just computed, no
      // extra API calls. Without this, TeamTendency's history is lost the
      // moment tomorrow's recompute overwrites it in place.
      const tendencySnapshots = await snapshotTeamTendencies(sportKey);
      return { sport: sportKey, persisted, tendencies, tendencySnapshots };
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

  // Build Step 7 - piggybacked on this same cron run, right after this
  // sport's scores are persisted above, same reasoning as the tendency
  // recompute: a freshly-graded game gets its DecayDeltaPrediction row (or
  // has its existing pregame row converted) the same run it lands in
  // GameResult, not a day later. MLB-only, matching the Decay Delta fixture
  // itself (decayDeltaModel.sport === "baseball_mlb") - not looped over
  // RESOLVABLE_SPORT_KEYS like the scores/tendencies above.
  const decayDeltaPredictions = await syncDecayDeltaPredictions(MLB_SPORT_KEY);

  return Response.json({
    ok: true,
    results,
    statSnapshots: { sport: MLB_SPORT_KEY, teamSnapshots, pitcherSnapshots, gameStarters: starters },
    decayDeltaPredictions,
  });
}
