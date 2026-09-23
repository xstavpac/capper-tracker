// Shared odds+picks assembly for any page that needs the /live board's game
// list paired with its matched, classified picks (ExpanderPick[] per game) -
// currently live/page.tsx (Feed/Grid) and the Parlay tab's "browse and add"
// section. Split out of live/page.tsx rather than duplicated: both callers
// need the exact same cutoff-scoped odds slate, the same carried-over
// still-live-from-yesterday games, and the same per-pick team-group/color
// classification, and drift between two copies of that logic would show up
// as picks appearing on one tab but not the other for the same game.
//
// Deliberately excludes anything page-specific: Board Pulse's fixed
// today-only slate, the sport-category breakdown panel, and Grid's
// selection resolution all stay in live/page.tsx, since the Parlay tab has
// no equivalent for any of them.
import {
  getOddsForSport,
  getYesterdayOddsForSport,
  getLiveScoresForSport,
  type OddsGame,
  type ScoreGame,
} from "@/server/data/odds";
import { getPicksForGames } from "@/server/data/picks";
import { pickCategory, betTypeLabel } from "@/server/data/stats";
import { classifyPickTeamGroup, shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";
import { formatPickLabel } from "@/lib/bet-line";
import { type ExpanderPick } from "@/components/live/game-picks-expander";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";

export type LiveBoardData = {
  odds: OddsGame[];
  scores: ScoreGame[];
  expanderPicksByGame: ExpanderPick[][];
};

export async function getLiveBoardData(
  userId: string,
  activeSport: string,
  sportLabel: string
): Promise<LiveBoardData> {
  const [allOdds, yesterdayOdds, scores] = await Promise.all([
    getOddsForSport(activeSport),
    getYesterdayOddsForSport(activeSport),
    getLiveScoresForSport(activeSport),
  ]);

  // Same board-slate scoping as live/page.tsx: the next slate (today plus a
  // few lookahead days), plus any still-live carry-over from yesterday's
  // snapshot. See that file's comment for the full rationale.
  const todayKey = easternDateKey(new Date());
  const cutoffKey = slateCutoffKey(
    allOdds.map((g) => g.commenceTime),
    todayKey
  );
  const boardOdds = allOdds.filter((g) => easternDateKey(new Date(g.commenceTime)) <= cutoffKey);
  const boardGameIds = new Set(boardOdds.map((g) => g.id));
  const odds = [...boardOdds, ...yesterdayOdds.filter((g) => !boardGameIds.has(g.id))];

  const matchedPicksByGame = await getPicksForGames(
    userId,
    sportLabel,
    odds.map((game) => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      commenceTime: new Date(game.commenceTime),
    }))
  );

  const expanderPicksByGame: ExpanderPick[][] = matchedPicksByGame.map((matchedPicks, gameIndex) => {
    const game = odds[gameIndex];
    // "Away @ Home" using the same short names the pick card's team-group
    // header already shows - the Parlay Pool's only use for this is a
    // human-readable label next to a pooled pick, not a lookup key (pickId
    // already is one).
    const gameLabel = shortTeamName(game.awayTeam, sportLabel) + " @ " + shortTeamName(game.homeTeam, sportLabel);
    return matchedPicks.map((p) => {
      const teamGroup = classifyPickTeamGroup(p, game, sportLabel);
      return {
        pickId: p.id,
        capperId: p.capperId,
        capperName: p.capper.name,
        capperColorTag: p.capper.colorTag,
        capperIsFavorite: p.capper.isFavorite,
        category: pickCategory({ ...p, sportName: sportLabel }),
        leagueName: sportLabel,
        gameId: game.id,
        gameLabel,
        betDetail: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
        odds: p.odds,
        units: p.units,
        status: p.status,
        betType: p.betType,
        period: p.period,
        rawBetDetail: p.betDetail,
        line: p.line,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        gameTime: game.commenceTime,
        teamGroup,
        teamLabel:
          teamGroup === "AWAY"
            ? shortTeamName(game.awayTeam, sportLabel)
            : teamGroup === "HOME"
              ? shortTeamName(game.homeTeam, sportLabel)
              : "",
        teamColor:
          teamGroup === "AWAY"
            ? getTeamColor(activeSport, game.awayTeam)
            : teamGroup === "HOME"
              ? getTeamColor(activeSport, game.homeTeam)
              : null,
        datePosted: p.datePosted.toISOString(),
      };
    });
  });

  return { odds, scores, expanderPicksByGame };
}
