// A score feed's game status, held to the game's scheduled start. Feeds flip
// to "live" before first pitch/kickoff - MLB StatsAPI reports Warmup (statusCode
// "PW", ~20 min early) as abstractGameState "Live" - so "live" is believed only
// once now >= commenceTime; before that the game stays "preview". Applied at
// each feed's mapping point in server/data/odds.ts so every consumer (LIVE
// badge, Grid, game detail, board ordering, ticker) sees the same status.
//
// "postponed" and "cancelled" are games the feed says won't be played at their
// scheduled time. They behave identically (see isUnplayed): never final, never
// scored, never an import target. Only the label differs.
//
// Pure and client-safe.
export type FeedGameStatus = "preview" | "live" | "final" | "postponed" | "cancelled";

export function isUnplayed(status: string | null | undefined): status is "postponed" | "cancelled" {
  return status === "postponed" || status === "cancelled";
}

// The label for an unplayed game, or null for any other status.
export function unplayedLabel(status: string | null | undefined): "Postponed" | "Cancelled" | null {
  return status === "postponed" ? "Postponed" : status === "cancelled" ? "Cancelled" : null;
}

export function resolveFeedStatus(feedStatus: FeedGameStatus, commenceTime: string, now: Date): FeedGameStatus {
  if (feedStatus !== "live") return feedStatus;
  const start = new Date(commenceTime).getTime();
  // No usable start time: nothing to hold the feed to, so trust it.
  if (!Number.isFinite(start)) return feedStatus;
  return now.getTime() >= start ? "live" : "preview";
}

// MLB StatsAPI: Warmup is pre-game (codedGameState "P") even though its
// abstractGameState is "Live" - always scheduled, whatever the clock says.
// abstractGameState "Final" also covers games that were never played:
// Postponed (codedGameState "D") and Cancelled ("C") come back as Final with
// no scores, and a postponed game's makeup reuses its gamePk. Only "F" (Final,
// including Completed Early) and "O" (Game Over) are real finals; D is
// "postponed" and C "cancelled", so no 0-0 result is ever persisted for them.
export function mlbFeedStatus(
  status: { abstractGameState?: string; codedGameState?: string; statusCode?: string } | undefined,
  commenceTime: string,
  now: Date
): FeedGameStatus {
  const state = status?.abstractGameState;
  if (status?.statusCode === "PW") return "preview";
  if (state === "Final") {
    const coded = status?.codedGameState;
    if (coded === "F" || coded === "O") return "final";
    return coded === "D" ? "postponed" : coded === "C" ? "cancelled" : "preview";
  }
  return resolveFeedStatus(state === "Live" ? "live" : "preview", commenceTime, now);
}

// ESPN scoreboard: state "post" covers postponed and canceled games too
// (STATUS_POSTPONED is state "post", completed false, scored 0-0). A game is
// final only when ESPN also marks it completed; "post" without that is
// "cancelled" for STATUS_CANCELED and "postponed" for anything else.
export function espnFeedStatus(
  type: { name?: string; state?: string; completed?: boolean } | undefined,
  commenceTime: string,
  now: Date
): FeedGameStatus {
  const state = type?.state;
  if (state === "post") {
    if (type?.completed === true) return "final";
    return type?.name === "STATUS_CANCELED" ? "cancelled" : "postponed";
  }
  return resolveFeedStatus(state === "in" ? "live" : "preview", commenceTime, now);
}
