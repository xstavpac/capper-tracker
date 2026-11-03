import { getClientScoresForSport, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { isTickerSportKey } from "@/lib/global-surface-sports";

export const dynamic = "force-dynamic";

// Public twin of /api/live/scores, for the logged-out marketing page's live
// ticker (see components/marketing/live-ticker.tsx) - same
// getLiveScoresForSport call, same response shape, deliberately WITHOUT the
// requireUser() gate: the whole point of the ticker is showing real live
// activity to a visitor who hasn't signed up yet, so this has to be
// reachable with no session. Score data was never the sensitive part of
// that endpoint's auth gate (its own comment says as much) - this just
// carves out the one sport-agnostic read the public page needs, rather than
// loosening the real app's endpoint. Must be listed in middleware.ts's
// PUBLIC_ROUTES or every poll 302s to /sign-in instead of returning scores.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sportKey = searchParams.get("sport");
  // NCAAB is a resolvable sport but not a ticker one (global-surface-sports.ts): this public route
  // answers it like any unknown sport.
  if (!sportKey || !RESOLVABLE_SPORT_KEYS.includes(sportKey) || !isTickerSportKey(sportKey)) {
    return Response.json({ error: "unknown sport" }, { status: 400 });
  }

  const scores = await getClientScoresForSport(sportKey);
  return Response.json({ scores });
}
