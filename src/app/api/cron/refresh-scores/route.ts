import { persistFinalScores } from "@/server/data/grading";
import { RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";

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
      return { sport: sportKey, persisted };
    })
  );

  return Response.json({ ok: true, results });
}
