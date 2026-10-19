// Shared odds+picks assembly for any caller that needs the /live board's
// game list paired with its matched, classified picks (ExpanderPick[] per
// game) - currently live/page.tsx (Feed/Grid), the Auto-Generate parlay
// action (parlay-generator.ts), and the pool Auto Hedge/Contrarian action
// (parlay-pool-generator.ts). Split out of live/page.tsx rather than
// duplicated: every caller needs the exact same cutoff-scoped odds slate,
// the same carried-over still-live-from-yesterday games, and the same
// per-pick team-group/color classification, and drift between copies of
// that logic would show up as picks appearing for one caller but not
// another for the same game. The per-pick mapping itself is toExpanderPick
// (expander-pick.ts).
//
// Deliberately excludes anything page-specific: Board Pulse's fixed
// today-only slate, the sport-category breakdown panel, and Grid's
// selection resolution all stay in live/page.tsx, since the other callers
// have no equivalent for any of them.
import {
  getBoardOddsForSport,
  getYesterdayOddsForSport,
  getClientScoresForSport,
  type OddsGame,
  type ScoreGame,
} from "@/server/data/odds";
import { getPicksForGames } from "@/server/data/picks";
import { toExpanderPick } from "@/server/data/expander-pick";
import { type ExpanderPick } from "@/components/live/game-picks-expander";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";
import { dropPhantomCards } from "@/lib/live-board-dedup";

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
    getBoardOddsForSport(activeSport),
    getYesterdayOddsForSport(activeSport),
    // The browser-bound view: `scores` is returned to live/page.tsx, which
    // hands it to client components as props.
    getClientScoresForSport(activeSport),
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
  // Drop phantom cards (an Odds API event with no schedule-feed game, next to a
  // same-teams same-day sibling that has one) BEFORE pick matching and before
  // returning, so picks, Board Pulse and the parlay generators all see the
  // cleaned list. Rule and rationale: lib/live-board-dedup.ts.
  const { games: odds, scheduleGames } = dropPhantomCards(
    [...boardOdds, ...yesterdayOdds.filter((g) => !boardGameIds.has(g.id))],
    scores
  );

  const matchedPicksByGame = await getPicksForGames(
    userId,
    sportLabel,
    odds.map((game, i) => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      commenceTime: new Date(game.commenceTime),
      // MLB doubleheader leg, when the schedule feed assigned this card one;
      // null for a single game ("N") so it can never exclude a card.
      gameNumber: scheduleGames[i]?.doubleHeaderStatus === "N" ? null : (scheduleGames[i]?.gameNumber ?? null),
    }))
  );

  const expanderPicksByGame: ExpanderPick[][] = matchedPicksByGame.map((matchedPicks, gameIndex) =>
    matchedPicks.map((p) => toExpanderPick(p, odds[gameIndex], activeSport, sportLabel))
  );

  return { odds, scores, expanderPicksByGame };
}
