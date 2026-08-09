import { getLiveScoresForSport } from "@/server/data/odds";
import { requireUser } from "@/server/auth";

export const dynamic = "force-dynamic";

// Polled client-side (LiveScoreboard) every LIVE_POLL_INTERVAL_MS to keep
// scores, LIVE/FINAL badges, innings, and the Board Pulse panel genuinely
// live instead of frozen at whatever was true on the last full page load.
// Behind requireUser() for consistency with the rest of the app - the
// underlying score data isn't sensitive, but this is a new externally-
// pollable endpoint and every other data path here already requires a
// session.
export async function GET(request: Request) {
  try {
    await requireUser();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sportKey = searchParams.get("sport");
  if (!sportKey) {
    return Response.json({ error: "missing sport" }, { status: 400 });
  }

  const scores = await getLiveScoresForSport(sportKey);
  return Response.json({ scores });
}
