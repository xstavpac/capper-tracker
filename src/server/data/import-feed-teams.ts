import { buildFeedTeams, type FeedTeam } from "@/lib/feed-teams";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { getLiveScoresForSport, getNcaafUpcomingFcsGames } from "@/server/data/odds";

// The teams catalog import can recognize beyond the hand-kept lists, per college
// sport:
//   - NCAAF, from the feed: the score feed (the one import game-matching, /live
//     scores and grading read) plus the week-ahead FCS schedule the matcher falls
//     back to, so a team recognized here always has a game to match. A feed error
//     degrades to "no extra football teams".
//   - NCAAB, from the generated Division I list: no fetch and no DB read, so it is
//     there whether or not the feed answers.
export async function getImportFeedTeams(): Promise<FeedTeam[]> {
  return [...(await ncaafFeedTeams()), ...NCAAB_LISTED_TEAMS];
}

async function ncaafFeedTeams(): Promise<FeedTeam[]> {
  try {
    const [scores, upcoming] = await Promise.all([
      getLiveScoresForSport("americanfootball_ncaaf"),
      getNcaafUpcomingFcsGames().catch(() => []),
    ]);
    return buildFeedTeams("NCAAF", [...scores, ...upcoming]);
  } catch (err) {
    console.error("[getImportFeedTeams] score feed read failed", err instanceof Error ? err.message : err);
    return [];
  }
}
