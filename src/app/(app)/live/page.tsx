import { requireUser } from "@/server/auth";
import { matchScoreToGame, LIVE_SPORTS } from "@/server/data/odds";
import { chipSetForLeague, DEFAULT_CHIP_SET, PICK_CATEGORY_LABELS } from "@/server/data/stats";
import { getSportCategoryPanelData } from "@/server/data/pick-aggregates-cappers-adapter";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { LiveScoreboard } from "@/components/live/live-scoreboard";
import { GridLiveBoard } from "@/components/live/grid-live-board";
import { orderBoardGames } from "@/components/live/live-scoreboard-ordering";
import { resolveGridLiveSelection } from "@/lib/grid-live-selection";
import { LiveCategoryPanel } from "@/components/live/live-category-panel";
import { easternDateKey } from "@/lib/dates";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { LiveBanner } from "@/components/live/live-banner";
import { LiveScoresProvider } from "@/components/live/use-live-scores";
import type { LiveCategoryPick } from "@/lib/live-category-picks";

const EMPTY = "rounded-[18px] bg-white p-10 text-center shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none";

export default async function LivePage({
  searchParams,
}: {
  searchParams: { sport?: string; view?: string; gameId?: string };
}) {
  // MLB is currently the only league fully wired up with real data - default
  // there instead of LIVE_SPORTS[0] (NFL), which is otherwise empty most of
  // the year. Tab order/visibility is untouched, this only changes which one
  // is selected when no ?sport= is in the URL.
  const activeSport = searchParams.sport || "baseball_mlb";
  const sportLabel = LIVE_SPORTS.find((s) => s.key === activeSport)?.label ?? activeSport;

  const user = await requireUser();

  // Only sports with categories beyond the universal set (every league tab
  // here has its own chip set today) get the category record query - for
  // anything else it'd just duplicate the Dashboard's all-sports breakdown.
  const leagueChipSet = chipSetForLeague(sportLabel);
  const hasSportSpecificCategories = leagueChipSet.length > DEFAULT_CHIP_SET.length;

  const [{ odds, scores, expanderPicksByGame }, sportCategoryPanel] = await Promise.all([
    getLiveBoardData(user.id, activeSport, sportLabel),
    hasSportSpecificCategories ? getSportCategoryPanelData(user.id, sportLabel) : Promise.resolve(null),
  ]);
  const sportCategoryBreakdown = sportCategoryPanel?.breakdown ?? [];

  // The category panel's slice of the board: just what a one-line pick row and
  // the board's own visibility rule need, not a second copy of every
  // ExpanderPick. gameIndex ties a pick to its card.
  const categoryPanelGames = odds.map((g) => ({ homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime }));
  const categoryPanelPicks: LiveCategoryPick[] = expanderPicksByGame.flatMap((gamePicks, gameIndex) =>
    gamePicks.map((p) => ({
      pickId: p.pickId,
      gameIndex,
      category: p.category,
      betDetail: p.betDetail,
      odds: p.odds,
      capperId: p.capperId,
      capperName: p.capperName,
      status: p.status,
      gameTime: p.gameTime,
    }))
  );

  // Board Pulse's slate is FIXED for the day: every game scheduled for today's
  // Eastern date, whether it's already Final (and thus hidden from the board by
  // orderBoardGames) or hasn't started yet. Taken straight from today's odds
  // snapshot here, never from the board's filtered/rendered list - that
  // coupling made "expected upsets today" shrink through the day as games
  // finalized (see board-pulse.ts and the note in live-scoreboard-ordering.ts).
  // Carried-over still-live games from last night are a different slate and are
  // excluded by the date match.
  const todayKey = easternDateKey(new Date());
  const boardPulseOdds = odds.filter((g) => easternDateKey(new Date(g.commenceTime)) === todayKey);

  // Only ever used to pick which empty-state message to show, never on its
  // own - getOddsForSport can return real cached odds for today even when
  // this is false (a prior successful fetch already populated OddsSnapshot,
  // and cache hits never touch the key at all), so gating the "not
  // configured" banner on this alone showed it right alongside real games.
  const hasApiKey = process.env.ODDS_API_KEY ? true : false;

  // MLB is currently the only sport with pregame odds detailed enough
  // (moneyline favorite + a totals line on every game) for Board Pulse to
  // mean anything - same "MLB-only for now" scoping as F5 ML/NRFI elsewhere
  // on this page.
  const showBoardPulse = activeSport === "baseball_mlb";

  // The view toggle, like the sport tabs, is a plain query param on this
  // same route - not client-router state, and not localStorage/cookie
  // persisted anywhere - per the app-wide convention (sport tabs, the Picks
  // page's filters) of representing selection as a URL a Server Component
  // reads, rather than inventing a new client-only mechanism for this one
  // feature. That also means there's no stored "standard" preference from
  // before this rename to migrate: the old default view was simply the
  // absence of a `view` param, never an explicit value written anywhere.
  // Grid is now the default for a request with no `view` param at all;
  // "advanced" is kept as an explicit alias for Grid (unchanged from
  // before the rename) so existing bookmarked/shared ?view=advanced links
  // keep resolving to Grid, and "feed" is the explicit value for the
  // renamed Standard-now-Feed view. Sport tab links below carry `view`
  // forward so switching sport while on Feed doesn't silently drop back to
  // Grid's new default; they never carry gameId/team forward, which is
  // what "explicitly clears the old selection" means in practice - a fresh
  // nav with no gameId/team simply has nothing for resolveGridLiveSelection
  // to find, so it falls back to the new sport's first game on its own
  // (see grid-live-selection.ts).
  const isGrid = searchParams.view !== "feed";

  // Initial selection for Grid Live, resolved server-side from this
  // request's own searchParams against the same board the client will
  // render (same odds, same orderBoardGames, matched against the initial
  // score snapshot). GridLiveBoard re-runs this exact function
  // client-side on every score poll tick to catch a selection that goes
  // stale after this initial render (e.g. the selected game finishing) -
  // see that component for why it can't be resolved once, here, and left
  // alone.
  const initialSelection = isGrid
    ? resolveGridLiveSelection(
        orderBoardGames(
          odds.map((game) => ({ game, score: matchScoreToGame(scores, game) })),
          todayKey
        ).map(({ game }) => game.id),
        searchParams.gameId ?? null
      )
    : null;

  // The one score poll on the page is mounted exactly when a board is, as
  // before - the category panel reads it through the provider and counts
  // nothing when there is no board to count.
  const showGrid = odds.length > 0 && isGrid && initialSelection !== null;
  const showFeed = odds.length > 0 && !isGrid;

  const categoryPanel = (
    <LiveCategoryPanel
      sportLabel={sportLabel}
      chipSet={leagueChipSet.map((key) => ({ key, label: PICK_CATEGORY_LABELS[key] }))}
      items={sportCategoryBreakdown}
      games={categoryPanelGames}
      picks={categoryPanelPicks}
    />
  );
  const emptyState = odds.length === 0 && hasApiKey && (
    <div className={EMPTY}>
      <p className="text-[13px] font-medium text-muted-foreground">No games found for this sport right now.</p>
    </div>
  );

  return (
    <ThemedPage>
      {/* The banner: league chips (plain links, like the view toggle - see isGrid above), the
          Feed/Grid toggle and the Parlay slip control. */}
      <LiveBanner activeSport={activeSport} isGrid={isGrid} />

      {showGrid || showFeed ? (
        <LiveScoresProvider key={activeSport} activeSport={activeSport} initialScores={scores}>
          {categoryPanel}
          {/* Grid Live's board fills the themed page's width; Feed's LiveScoreboard keeps its own
              max-w-5xl wrapper below. */}
          {showGrid && initialSelection && (
            <GridLiveBoard
              key={activeSport}
              activeSport={activeSport}
              sportLabel={sportLabel}
              odds={odds}
              initialScores={scores}
              matchedPicksByGame={expanderPicksByGame}
              initialSelection={initialSelection}
            />
          )}
          {showFeed && (
            <div className="mx-auto max-w-5xl">
              <LiveScoreboard
                key={activeSport}
                activeSport={activeSport}
                odds={odds}
                boardPulseOdds={boardPulseOdds}
                initialScores={scores}
                matchedPicksByGame={expanderPicksByGame}
                showBoardPulse={showBoardPulse}
              />
            </div>
          )}
        </LiveScoresProvider>
      ) : (
        <>
          {categoryPanel}
          {emptyState}
        </>
      )}
    </ThemedPage>
  );
}

