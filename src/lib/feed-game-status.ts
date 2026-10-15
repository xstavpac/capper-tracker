// A score feed's game status, held to the game's scheduled start. Feeds flip
// to "live" before first pitch/kickoff - MLB StatsAPI reports Warmup (statusCode
// "PW", ~20 min early) as abstractGameState "Live" - so "live" is believed only
// once now >= commenceTime; before that the game stays "preview". Applied at
// each feed's mapping point in server/data/odds.ts so every consumer (LIVE
// badge, Grid, game detail, board ordering, ticker) sees the same status.
//
// Pure and client-safe.
export type FeedGameStatus = "preview" | "live" | "final";

export function resolveFeedStatus(feedStatus: FeedGameStatus, commenceTime: string, now: Date): FeedGameStatus {
  if (feedStatus !== "live") return feedStatus;
  const start = new Date(commenceTime).getTime();
  // No usable start time: nothing to hold the feed to, so trust it.
  if (!Number.isFinite(start)) return feedStatus;
  return now.getTime() >= start ? "live" : "preview";
}

// MLB StatsAPI: Warmup is pre-game (codedGameState "P") even though its
// abstractGameState is "Live" - always scheduled, whatever the clock says.
export function mlbFeedStatus(status: { abstractGameState?: string; statusCode?: string } | undefined, commenceTime: string, now: Date): FeedGameStatus {
  const state = status?.abstractGameState;
  if (status?.statusCode === "PW") return "preview";
  return resolveFeedStatus(state === "Final" ? "final" : state === "Live" ? "live" : "preview", commenceTime, now);
}
