import { backfillOddsForSport, LIVE_SPORTS } from "@/server/data/odds";
import { classifyBackfillOddsRun } from "@/lib/odds-cron-status";

export const dynamic = "force-dynamic";

// Vercel Cron hits this every 4 hours, around the clock. The once-daily seed
// fetch (/api/cron/refresh-odds) runs at 4am ET specifically to lock in
// pregame lines before any game starts - but a game whose sportsbook lines
// simply aren't posted yet at that hour (a doubleheader nightcap, a
// weather-rescheduled game, anything late) is silently skipped, and
// OddsSnapshot's once-daily cache means it then stays missing for the rest
// of the day with no other path to pick it up. This fills in exactly those
// gaps - purely additive (see backfillOddsForSport), never touching a game
// the seed fetch already captured correctly.
//
// Response contract: most runs are `nothing_missing` for every sport - that
// is the healthy steady state, NOT a warning (unlike refresh-odds, where an
// empty result is suspicious). Only a real Odds API failure (fetch_failed /
// no_api_key) is an "error" (HTTP 500). `no_base_row` for an in-season sport
// means today's seed never landed - surfaced as a "warning" here because this
// cron runs hours after the 8am seed and is the only thing that would catch
// a seed that failed after the fact.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== "Bearer " + cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const results = await Promise.all(
    LIVE_SPORTS.map(async (sport) => {
      const { added, status } = await backfillOddsForSport(sport.key);
      return { sport: sport.key, added, status };
    })
  );

  const { ok, status, httpStatus } = classifyBackfillOddsRun(results);

  console.log(
    "[backfill-odds-run]",
    JSON.stringify({
      status,
      failed: results.filter((r) => r.status === "fetch_failed" || r.status === "no_api_key").map((r) => r.sport),
      missingSeed: results.filter((r) => r.status === "no_base_row").map((r) => r.sport),
      results,
    })
  );

  return Response.json({ ok, status, results }, { status: httpStatus });
}
