"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OddsGame, ScoreGame } from "@/server/data/odds";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";
import { useLiveScores } from "@/components/live/use-live-scores";
import { resolveGridLiveSelection, type GridLiveSelection } from "@/lib/grid-live-selection";
import { buildGridLiveGamePanelData } from "@/components/live/grid-live-team-panel-data";
import { GridLiveGameList } from "@/components/live/grid-live-game-list";
import { GameDetailPanel } from "@/components/live/team-picks-panel";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

// Grid Live's client shell: a compact game list beside a fixed
// game-detail picks panel. Data assembly (odds, scores, picks, team-group
// classification) is entirely server-computed in live/page.tsx and passed
// down as props here, unchanged from how LiveScoreboard already receives it
// - this component adds no second data-fetching path, only the live-score
// poll (shared via useLiveScores, the same hook Feed Live now uses) and
// the selection/fallback logic below.
//
// Selection (`gameId`) is mirrored into the URL (per the app-wide convention
// of representing selection as a query param a Server Component can read on
// refresh/share) but is driven by CLIENT state, not by navigating to a new
// URL: `initialSelection` seeds that state from what the server resolved on
// this request's own searchParams via resolveGridLiveSelection, and a
// game click (GridLiveGameList's onSelectGame) updates the state
// directly, then calls router.replace only to keep the address bar in sync -
// it does NOT wait on or remount from that navigation. Every game's odds/
// score/picks are already present in this component's props (the whole
// board's worth, not just the selected game's), so switching games never
// needs a server round-trip; doing it as a real <Link> navigation instead
// (the previous implementation) re-ran live/page.tsx's full data fetch on
// every click, which was the cause of a flicker + scroll-to-top there.
//
// The poll-tick effect below still exists to react to something the URL/
// clicks can't: a live poll tick finalizing the selected game out from under
// the viewer. On every tick it re-runs the SAME shared resolver against the
// freshly-sorted game list; if the previously-selected game dropped out, it
// falls back (first game in the new list) and syncs both client state and
// the URL.
export function GridLiveBoard({
  activeSport,
  sportLabel,
  odds,
  initialScores,
  matchedPicksByGame,
  initialSelection,
}: {
  activeSport: string;
  sportLabel: string;
  odds: OddsGame[];
  initialScores: ScoreGame[];
  matchedPicksByGame: ExpanderPick[][];
  initialSelection: GridLiveSelection;
}) {
  const router = useRouter();
  const scores = useLiveScores(activeSport, initialScores);
  const [selection, setSelection] = useState(initialSelection);

  // Mobile stacks the panel below the game list (see this component's
  // grid-cols-1/lg:grid-cols-[...] below), so a click there leaves the panel
  // off-screen until the user manually scrolls. Desktop already shows both
  // side by side, so it must never scroll here - same counter-triggered
  // pattern as bulk-import-form.tsx's resultsRef (a plain ref + an effect
  // gated on `scrollTrigger > 0` so it can't fire on mount), but ALSO gated
  // on the live lg: breakpoint check so desktop is untouched even though the
  // counter still bumps there. The counter is only ever bumped from
  // handleSelectGame - a deliberate click - never from the poll-tick
  // auto-fallback effect below, so a game auto-finalizing out from under the
  // viewer can't yank their scroll position.
  const panelRef = useRef<HTMLDivElement>(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  useEffect(() => {
    if (scrollTrigger === 0) return;
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollTrigger]);

  // Mirrors LiveScoreboard's own `initialScores` resync: a sport switch
  // remounts this component (see live/page.tsx's key={activeSport}), but the
  // effect also covers a same-mount prop change (e.g. a fresh server
  // response after this component's own router.replace below).
  useEffect(() => {
    setSelection(initialSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialSelection is a fresh object every render; compare by its fields instead of identity
  }, [initialSelection.gameId]);

  const gamesWithScores = useMemo(
    () =>
      odds.map((game, gameIndex) => ({
        game,
        gameIndex,
        score: matchScoreToGame(scores, game),
      })),
    [odds, scores]
  );
  const sortedGames = useMemo(
    () => orderBoardGames(gamesWithScores, easternDateKey(new Date())),
    [gamesWithScores]
  );
  const sortedGameIds = useMemo(() => sortedGames.map(({ game }) => game.id), [sortedGames]);

  // Re-check the current selection against the live-updated game list on
  // every poll tick. Reads/writes React state from inside an effect (not
  // during render) specifically to catch the "selected game just went
  // Final and fell out of sortedGameIds" case - see the file header.
  useEffect(() => {
    const resolved = resolveGridLiveSelection(sortedGameIds, selection.gameId);
    if (resolved.gameId === selection.gameId) return;

    setSelection(resolved);
    // `view=advanced` is the query-param value for this toggle, kept
    // unchanged from before the Grid rename to avoid breaking bookmarked/
    // shared links - see live/page.tsx's isGrid.
    const params = new URLSearchParams({ sport: activeSport, view: "advanced" });
    if (resolved.gameId) params.set("gameId", resolved.gameId);
    router.replace("/live?" + params.toString(), { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sortedGameIds is the only thing that should re-trigger this check; selection is read, not depended on, to avoid re-running on the very setSelection this effect performs
  }, [sortedGameIds]);

  // A game click updates the client state directly (no remount, no data
  // refetch - see the file header) and mirrors the choice into the URL via
  // replace so a refresh/share lands back on the same game; `scroll: false`
  // keeps this from also fighting the "don't jump the page" fix with its own
  // scroll reset.
  function handleSelectGame(gameId: string) {
    setSelection({ gameId });
    router.replace("/live?sport=" + activeSport + "&view=advanced&gameId=" + gameId, { scroll: false });
    setScrollTrigger((t) => t + 1);
  }

  // Double-click only - a real navigation (router.push, not the replace()
  // above) to Feed Live's own game-card page. Deliberately not folded
  // into handleSelectGame: that one exists specifically to AVOID a
  // navigation on every game click (see file header), while this is opening
  // a genuinely different view (Momentum/Pace, head-to-head header) that
  // Grid's in-panel GameDetailPanel has no equivalent for.
  function handleOpenGame(gameId: string) {
    router.push("/live/" + gameId + "?sport=" + activeSport);
  }

  const selectedIndex = selection.gameId ? sortedGameIds.indexOf(selection.gameId) : -1;
  const selectedEntry = selectedIndex >= 0 ? sortedGames[selectedIndex] : undefined;

  const panelData =
    selectedEntry &&
    buildGridLiveGamePanelData(selectedEntry.game, activeSport, sportLabel, matchedPicksByGame[selectedEntry.gameIndex] ?? []);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <GridLiveGameList
        sortedGames={sortedGames}
        matchedPicksByGame={matchedPicksByGame}
        activeSport={activeSport}
        selectedGameId={selection.gameId}
        onSelectGame={handleSelectGame}
        onOpenGame={handleOpenGame}
      />
      <div ref={panelRef}>
        {panelData ? (
          <GameDetailPanel data={panelData} />
        ) : (
          <div className="rounded-card bg-card p-10 text-center shadow-soft">
            <p className="text-sm text-muted-foreground">No games found for this sport right now.</p>
          </div>
        )}
      </div>
    </div>
  );
}
