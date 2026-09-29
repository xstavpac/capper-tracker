// Response builder for /api/public/ticker-scores, split out of the route file
// so the cache headers are testable without importing the data layer.

// s-maxage matches LIVE_SCORES_TTL_SECONDS (15s) - the CDN can't serve data
// meaningfully older than the origin's own cache would.
export const TICKER_SCORES_CACHE_CONTROL = "public, s-maxage=15, stale-while-revalidate=30";

export function buildTickerScoresResponse(result: {
  scoresBySport: Record<string, unknown[]>;
  failed: string[];
}): Response {
  return Response.json(
    { scoresBySport: result.scoresBySport },
    {
      headers: {
        // A partial response (some sport's upstream threw) must not be pinned
        // in the CDN for up to 45s - let the next poll retry immediately.
        "Cache-Control": result.failed.length === 0 ? TICKER_SCORES_CACHE_CONTROL : "no-store",
      },
    }
  );
}
