import { getOddsForSport, LIVE_SPORTS } from "@/server/data/odds";

export const dynamic = "force-dynamic";

// Vercel Cron hits this once daily, early enough that none of that day's
// games have started yet. This seeds the day's OddsSnapshot cache (see
// getOddsForSport) with pregame lines, instead of letting whoever visits
// /live first - possibly after games are already underway - capture
// in-play pricing that then stays cached for the rest of the day.
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
      const games = await getOddsForSport(sport.key);
      return { sport: sport.key, games: games.length };
    })
  );

  return Response.json({ ok: true, results });
}
