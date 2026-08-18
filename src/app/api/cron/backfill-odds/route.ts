import { backfillOddsForSport, LIVE_SPORTS } from "@/server/data/odds";

export const dynamic = "force-dynamic";

// Vercel Cron hits this every 2 hours, around the clock. The once-daily seed
// fetch (/api/cron/refresh-odds) runs at 4am ET specifically to lock in
// pregame lines before any game starts - but a game whose sportsbook lines
// simply aren't posted yet at that hour (a doubleheader nightcap, a
// weather-rescheduled game, anything late) is silently skipped, and
// OddsSnapshot's once-daily cache means it then stays missing for the rest
// of the day with no other path to pick it up. This fills in exactly those
// gaps - purely additive (see backfillOddsForSport), never touching a game
// the seed fetch already captured correctly. A 2-hour cadence means a
// late-posted line shows up the same day within a couple hours worst case,
// without needing 15-minute-grading-cron urgency - a game missing from the
// board for an hour or two is a display gap, not a correctness problem the
// way an ungraded pick is.
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
      const { added } = await backfillOddsForSport(sport.key);
      return { sport: sport.key, added };
    })
  );

  return Response.json({ ok: true, results });
}
