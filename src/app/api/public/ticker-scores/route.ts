import { getAllLiveScores } from "@/server/data/live-ticker";
import { buildTickerScoresResponse } from "@/lib/ticker-scores-response";

export const dynamic = "force-dynamic";

// Combined live-score feed for the ticker (components/marketing/live-ticker.tsx):
// every sport's scores in one response, replacing the ticker's old one-request-
// per-sport polling of /api/public/live-scores.
//
// CDN-cacheable ON PURPOSE, and safe only because the payload is identical for
// every caller: it is getLiveScoresForSport's public ESPN / MLB-StatsAPI game
// data (teams, scores, status, innings) with no picks, favorites, or user
// fields, and this handler never reads the session. middleware.ts skips its
// Supabase session step for /api/public/ so no Set-Cookie can ride along on a
// shared cached response either. Do NOT add anything per-user to this payload
// without dropping the public cache header (see lib/ticker-scores-response.ts).
export async function GET() {
  return buildTickerScoresResponse(await getAllLiveScores());
}
