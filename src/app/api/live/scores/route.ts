import { getClientScoresForSport } from "@/server/data/odds";
import { requireSession } from "@/server/auth-session";
import { liveScoresResponse } from "@/server/live-scores-response";

export const dynamic = "force-dynamic";

// Polled client-side (use-live-scores.ts) every 25 s, only while the tab is
// visible, to keep scores, LIVE/FINAL badges, innings and the Board Pulse panel
// live instead of frozen at the last full page load. See liveScoresResponse for
// the auth gate.
export async function GET(request: Request) {
  return liveScoresResponse(request, { requireSession, getScores: getClientScoresForSport });
}
