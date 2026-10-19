import { seedNhlGoalScorerOddsForToday } from "@/server/data/nhl-goal-scorer-odds";
import { runCronLogged } from "@/server/data/cron-runs";

export const dynamic = "force-dynamic";

// Vercel Cron hits this once daily at 16:30 UTC - 12:30 PM ET in summer (EDT),
// 11:30 AM ET in winter (EST), ahead of the earliest matinee starts. It is the
// second run of the day for the NHL event-level markets (anytime goal scorer
// and the 3-way moneyline; the path keeps its original name): the refresh-odds cron already ran the
// same step just after midnight ET, and a game whose books hadn't posted the
// market by then came back without it. This asks again, only for today's games
// still missing one and only for the market each is missing (see
// nhlGamesNeedingGoalScorerOdds), so nothing bought at midnight is bought
// twice and a market that still isn't posted costs nothing. Same 95%
// credit gate and odds_api_usage_log row per call as the midnight run.
//
// Informational like the refresh-odds step it repeats: a skip, a credit-gate
// stop or a failed event is reported in the body with HTTP 200. Only a throw
// (e.g. the database is unreachable) is a 500.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== "Bearer " + cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }
  return runCronLogged("nhl-goal-scorer-odds", run);
}

// The run itself, logged to cron_runs (start, end, status, rows touched) by
// runCronLogged - only after the auth check above passes.
async function run(): Promise<Response> {
  try {
    const seeded = await seedNhlGoalScorerOddsForToday();
    const result = {
      status: seeded.status,
      eventsFetched: seeded.eventsFetched,
      eventsSkippedCreditGate: seeded.eventsSkippedCreditGate,
      eventsFailed: seeded.eventsFailed,
    };
    console.log("[nhl-goal-scorer-odds-run]", JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[nhl-goal-scorer-odds-run] threw", JSON.stringify({ error }));
    return Response.json({ ok: false, status: "error", error }, { status: 500 });
  }
}
