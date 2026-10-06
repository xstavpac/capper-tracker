import { buildFeedTeams, type FeedTeam } from "@/lib/feed-teams";
import { getLiveScoresForSport, getNcaafUpcomingFcsGames } from "@/server/data/odds";

// The teams catalog import can recognize from the game feed alone - today the
// NCAAF score feed (the one import game-matching, /live scores and grading
// read) plus the week-ahead FCS schedule the matcher falls back to, so a team
// recognized here always has a game to match. A feed
// error degrades to "no extra teams": parseCatalog then behaves exactly as it
// does with no feed data.
export async function getImportFeedTeams(): Promise<FeedTeam[]> {
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
