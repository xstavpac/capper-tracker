import { requireUser } from "@/server/auth";
import { matchScoreToGame, LIVE_SPORTS } from "@/server/data/odds";
import { chipSetForLeague, DEFAULT_CHIP_SET } from "@/server/data/stats";
import { getSportCategoryPanelData } from "@/server/data/cappers";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { LiveScoreboard } from "@/components/live/live-scoreboard";
import { GridLiveBoard } from "@/components/live/grid-live-board";
import { orderBoardGames } from "@/components/live/live-scoreboard-ordering";
import { resolveGridLiveSelection } from "@/lib/grid-live-selection";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";
import { easternDateKey } from "@/lib/dates";

function tabClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-red-600 text-white" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

function viewToggleClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1 text-xs font-medium " +
    (isActive ? "bg-foreground text-background" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

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

  // Only sports with categories beyond the universal set (currently just
  // MLB, via F5 ML/NRFI) get their own breakdown panel here - for everything
  // else it'd just duplicate the Dashboard's all-sports one with nothing new
  // to show, so skip the extra query entirely.
  const hasSportSpecificCategories = chipSetForLeague(sportLabel).length > DEFAULT_CHIP_SET.length;

  const [{ odds, scores, expanderPicksByGame }, sportCategoryPanel] = await Promise.all([
    getLiveBoardData(user.id, activeSport, sportLabel),
    hasSportSpecificCategories ? getSportCategoryPanelData(user.id, sportLabel) : Promise.resolve(null),
  ]);
  const sportCategoryBreakdown = sportCategoryPanel?.breakdown ?? [];
  const sportCategoryLeaderboards = sportCategoryPanel?.leaderboards ?? {};

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

  return (
    <>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Live odds and scores</h1>
            <p className="mt-1 text-sm text-muted-foreground">Powered by The Odds API</p>
          </div>
          <ParlaySlipButton />
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {LIVE_SPORTS.map((s) => (
              <a
                key={s.key}
                href={"/live?sport=" + s.key + (isGrid ? "&view=advanced" : "&view=feed")}
                className={tabClass(activeSport === s.key)}
              >
                {s.label}
              </a>
            ))}
          </div>
          <div className="flex gap-1.5 rounded-full bg-muted/60 p-1">
            <a href={"/live?sport=" + activeSport + "&view=feed"} className={viewToggleClass(!isGrid)}>
              Feed
            </a>
            <a href={"/live?sport=" + activeSport + "&view=advanced"} className={viewToggleClass(isGrid)}>
              Grid
            </a>
          </div>
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
      </div>

      {/* Grid Live's board gets its own, wider container instead of living
          inside the max-w-5xl div above - the header/tabs/category panel
          stay put, but the board is the one thing on this page with genuine
          unused margin next to it on larger screens (its game-card list
          column was a fixed, cramped 320px regardless of viewport). Only
          grows past max-w-5xl at xl/2xl - untouched at the in-between
          desktop widths (1024-1279px) where that margin doesn't exist yet.
          Feed's LiveScoreboard is deliberately NOT touched by this - it gets
          its own unchanged max-w-5xl wrapper below. */}
      {odds.length > 0 && isGrid && initialSelection && (
        <div className="mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
          <GridLiveBoard
            key={activeSport}
            activeSport={activeSport}
            sportLabel={sportLabel}
            odds={odds}
            initialScores={scores}
            matchedPicksByGame={expanderPicksByGame}
            initialSelection={initialSelection}
          />
        </div>
      )}

      {odds.length > 0 && !isGrid && (
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
    </>
  );
}

