import { requireUser } from "@/server/auth";
import { getOddsForSport, getLiveScoresForSport, LIVE_SPORTS } from "@/server/data/odds";
import { getPicksForGames } from "@/server/data/picks";
import { pickCategory, betTypeLabel, chipSetForLeague, DEFAULT_CHIP_SET } from "@/server/data/stats";
import { getSportCategoryPanelData } from "@/server/data/cappers";
import { classifyPickTeamGroup, shortTeamName } from "@/lib/pick-team-group";
import { type ExpanderPick } from "@/components/live/game-picks-expander";
import { LiveScoreboard } from "@/components/live/live-scoreboard";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";

function tabClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-red-600 text-white" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

export default async function LivePage({
  searchParams,
}: {
  searchParams: { sport?: string };
}) {
  // MLB is currently the only league fully wired up with real data - default
  // there instead of LIVE_SPORTS[0] (NFL), which is otherwise empty most of
  // the year. Tab order/visibility is untouched, this only changes which one
  // is selected when no ?sport= is in the URL.
  const activeSport = searchParams.sport || "baseball_mlb";
  const sportLabel = LIVE_SPORTS.find((s) => s.key === activeSport)?.label ?? activeSport;

  const user = await requireUser();

  // Only sports with categories beyond the universal set (currently just
  // MLB, via F5 ML/NRFI) get their own breakdown panel here - for everything
  // else it'd just duplicate the Dashboard's all-sports one with nothing new
  // to show, so skip the extra query entirely.
  const hasSportSpecificCategories = chipSetForLeague(sportLabel).length > DEFAULT_CHIP_SET.length;

  const [allOdds, scores, sportCategoryPanel] = await Promise.all([
    getOddsForSport(activeSport),
    getLiveScoresForSport(activeSport),
    hasSportSpecificCategories ? getSportCategoryPanelData(user.id, sportLabel) : Promise.resolve(null),
  ]);
  const sportCategoryBreakdown = sportCategoryPanel?.breakdown ?? [];
  const sportCategoryLeaderboards = sportCategoryPanel?.leaderboards ?? {};

  // This is the odds BOARD, not the ticker - it's meant to show the full
  // window the Odds API has actually posted lines for (a full week at once
  // for NFL), not just today. A same-day filter briefly lived here (copied
  // from getLiveTickerGames' "what's happening today" ticker filter, which
  // is a genuinely different, narrower purpose - see live-ticker.ts), but it
  // pruned this page's own game list down to nothing on any day the active
  // sport had no game today, which for NFL/WNBA is most days. getOddsForSport
  // already excludes started games and gates by season, so allOdds here is
  // already the right board contents with no extra filtering needed.
  const odds = allOdds;

  // Only ever used to pick which empty-state message to show, never on its
  // own - getOddsForSport can return real cached odds for today even when
  // this is false (a prior successful fetch already populated OddsSnapshot,
  // and cache hits never touch the key at all), so gating the "not
  // configured" banner on this alone showed it right alongside real games.
  const hasApiKey = process.env.ODDS_API_KEY ? true : false;

  // The matched-picks list itself is cheap (one indexed query per game,
  // already used on the game-detail page) - fetch it eagerly for every game
  // so the "N picks on this game" badge and its count are accurate on load.
  // The expensive part - each capper's historical record for their specific
  // pick's category - is NOT computed here; that's deferred to expand-time
  // (see GamePicksExpander), since it requires pulling a capper's full pick
  // history and would be wasteful to do for every capper on every game.
  const matchedPicksByGame = await getPicksForGames(
    user.id,
    sportLabel,
    odds.map((game) => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      commenceTime: new Date(game.commenceTime),
    }))
  );

  // pickCategory/betTypeLabel touch server/data/stats.ts, which has a
  // module-level prisma import - mapped here (Server Component) rather than
  // inside LiveScoreboard (client) so that import never has to cross into
  // the client bundle at all. teamGroup/teamLabel are computed here for the
  // same reason - classifyPickTeamGroup/shortTeamName are pure and client-
  // safe on their own, but doing the mapping here keeps every game's
  // homeTeam/awayTeam (needed to classify each pick) in one place instead of
  // threading it down through LiveScoreboard as well.
  const expanderPicksByGame: ExpanderPick[][] = matchedPicksByGame.map((matchedPicks, gameIndex) => {
    const game = odds[gameIndex];
    return matchedPicks.map((p) => {
      const teamGroup = classifyPickTeamGroup(p, game, sportLabel);
      return {
        pickId: p.id,
        capperId: p.capperId,
        capperName: p.capper.name,
        capperColorTag: p.capper.colorTag,
        category: pickCategory({ ...p, sportName: sportLabel }),
        betDetail: p.betDetail || betTypeLabel(p.betType),
        odds: p.odds,
        units: p.units,
        status: p.status,
        teamGroup,
        teamLabel:
          teamGroup === "AWAY"
            ? shortTeamName(game.awayTeam, sportLabel)
            : teamGroup === "HOME"
              ? shortTeamName(game.homeTeam, sportLabel)
              : "",
      };
    });
  });

  // MLB is currently the only sport with pregame odds detailed enough
  // (moneyline favorite + a totals line on every game) for Board Pulse to
  // mean anything - same "MLB-only for now" scoping as F5 ML/NRFI elsewhere
  // on this page.
  const showBoardPulse = activeSport === "baseball_mlb";

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Live odds and scores</h1>
        <p className="mt-1 text-sm text-muted-foreground">Powered by The Odds API</p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {LIVE_SPORTS.map((s) => (
          <a key={s.key} href={"/live?sport=" + s.key} className={tabClass(activeSport === s.key)}>{s.label}</a>
        ))}
      </div>

      {sportCategoryBreakdown.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-foreground">{sportLabel} record by category</h2>
          <CategoryBreakdown items={sportCategoryBreakdown} leaderboards={sportCategoryLeaderboards} />
        </div>
      )}

      {odds.length === 0 && hasApiKey && (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No games found for this sport right now.</p>
        </div>
      )}

      {odds.length > 0 && (
        <LiveScoreboard
          key={activeSport}
          activeSport={activeSport}
          odds={odds}
          initialScores={scores}
          matchedPicksByGame={expanderPicksByGame}
          showBoardPulse={showBoardPulse}
        />
      )}
    </div>
  );
}

