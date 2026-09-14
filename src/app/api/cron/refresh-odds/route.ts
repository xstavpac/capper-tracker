import { seedOddsSnapshot, LIVE_SPORTS } from "@/server/data/odds";
import { seedNflPropOddsForToday } from "@/server/data/nfl-prop-odds";
import { classifyRefreshOddsRun } from "@/lib/odds-cron-status";

export const dynamic = "force-dynamic";

// Vercel Cron hits this once daily, early enough that none of that day's
// games have started yet. This seeds the day's OddsSnapshot cache (see
// getOddsForSport) with pregame lines, instead of letting whoever visits
// /live first - possibly after games are already underway - capture
// in-play pricing that then stays cached for the rest of the day.
//
// Response contract: `ok`/`status` reflect what actually happened, not a
// blanket success. A real Odds API failure (fetch_failed / no_api_key) is an
// "error" and returns HTTP 500 so a cron/uptime monitor trips on it - this is
// the failure mode that silently blanked the Live/odds board for stretches of
// late 2026. Every in-season sport coming back with zero games and no
// explicit failure is a softer "warning" (usually a real outage, occasionally
// a genuinely gameless day) - ok:false in the body, still HTTP 200.
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== "Bearer " + cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const results = await Promise.all(LIVE_SPORTS.map((sport) => seedOddsSnapshot(sport.key)));

  const { ok, status, httpStatus } = classifyRefreshOddsRun(results);
  const creditsRemaining = results.map((r) => r.creditsRemaining).find((c) => c !== null) ?? null;
  const perSport = results.map((r) => ({ sport: r.sportKey, status: r.status, games: r.games }));

  console.log(
    "[refresh-odds-run]",
    JSON.stringify({
      status,
      creditsRemaining,
      failed: results.filter((r) => r.status === "fetch_failed" || r.status === "no_api_key").map((r) => r.sportKey),
      results: perSport,
    })
  );

  // NFL player-prop odds - a follow-up step on the SAME cron run, not a
  // separate poll cycle. Reads the NFL row the bulk seed above just wrote
  // (no_snapshot/no_games_to_fetch if there's nothing to attach props to -
  // off-season, no API key, or the bulk fetch itself failed, all already
  // reflected in `results` above). Deliberately never affects `ok`/
  // `httpStatus`: this is the lower-priority market by design (see the
  // 95% credit gate in nfl-prop-odds.ts) and its own failure/skip modes are
  // informational, not cron-health signals the way the core game-lines
  // fetch's are.
  const nflProps = await seedNflPropOddsForToday();
  console.log(
    "[refresh-odds-run] nfl-props",
    JSON.stringify({
      status: nflProps.status,
      eventsFetched: nflProps.eventsFetched,
      eventsSkippedCreditGate: nflProps.eventsSkippedCreditGate,
      eventsFailed: nflProps.eventsFailed,
    })
  );

  return Response.json(
    {
      ok,
      status,
      creditsRemaining,
      results: perSport,
      nflProps: {
        status: nflProps.status,
        eventsFetched: nflProps.eventsFetched,
        eventsSkippedCreditGate: nflProps.eventsSkippedCreditGate,
        eventsFailed: nflProps.eventsFailed,
      },
    },
    { status: httpStatus }
  );
}
