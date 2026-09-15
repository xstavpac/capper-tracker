"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OddsGame, ScoreGame } from "@/server/data/odds";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";
import { useLiveScores } from "@/components/live/use-live-scores";
import { resolveAdvancedLiveSelection, type AdvancedLiveSelection } from "@/lib/advanced-live-selection";
import { buildAdvancedLiveTeamPanelData } from "@/components/live/advanced-live-team-panel-data";
import { AdvancedLiveGameList } from "@/components/live/advanced-live-game-list";
import { TeamPicksPanel } from "@/components/live/team-picks-panel";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

// Advanced Live's client shell: a compact game list beside a fixed
// single-team picks panel. Data assembly (odds, scores, picks, team-group
// classification) is entirely server-computed in live/page.tsx and passed
// down as props here, unchanged from how LiveScoreboard already receives it
// - this component adds no second data-fetching path, only the live-score
// poll (shared via useLiveScores, the same hook Standard Live now uses) and
// the selection/fallback logic below.
//
// Selection (`gameId`/`team`) is URL state, per the app-wide convention
// (query-param reads, not client-router state) - `initialSelection` is what
// the server already resolved from the request's own searchParams via
// resolveAdvancedLiveSelection. Client state here exists ONLY to react to
// something the URL can't: a live poll tick finalizing the selected game
// out from under the viewer. On every tick this re-runs the SAME shared
// resolver against the freshly-sorted game list; if the previously-selected
// game dropped out, it falls back (first game in the new list) and syncs the
// URL via router.replace so the address bar - and a refresh - stay
// consistent with what's on screen. A user's own game/team clicks never go
// through this state at all; they're plain links to a new URL, exactly like
// Standard Live's sport tabs.
export function AdvancedLiveBoard({
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
  initialSelection: AdvancedLiveSelection;
}) {
  const router = useRouter();
  const scores = useLiveScores(activeSport, initialScores);
  const [selection, setSelection] = useState(initialSelection);

  // Mirrors LiveScoreboard's own `initialScores` resync: a sport switch
  // remounts this component (see live/page.tsx's key={activeSport}), but the
  // effect also covers a same-mount prop change (e.g. a fresh server
  // response after this component's own router.replace below).
  useEffect(() => {
    setSelection(initialSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialSelection is a fresh object every render; compare by its fields instead of identity
  }, [initialSelection.gameId, initialSelection.team]);

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
    const resolved = resolveAdvancedLiveSelection(sortedGameIds, selection.gameId, selection.team);
    if (resolved.gameId === selection.gameId && resolved.team === selection.team) return;

    setSelection(resolved);
    const params = new URLSearchParams({ sport: activeSport, view: "advanced", team: resolved.team });
    if (resolved.gameId) params.set("gameId", resolved.gameId);
    router.replace("/live?" + params.toString(), { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sortedGameIds is the only thing that should re-trigger this check; selection is read, not depended on, to avoid re-running on the very setSelection this effect performs
  }, [sortedGameIds]);

  const selectedIndex = selection.gameId ? sortedGameIds.indexOf(selection.gameId) : -1;
  const selectedEntry = selectedIndex >= 0 ? sortedGames[selectedIndex] : undefined;

  const panelData =
    selectedEntry &&
    buildAdvancedLiveTeamPanelData(
      selection.team,
      selectedEntry.game,
      activeSport,
      sportLabel,
      matchedPicksByGame[selectedEntry.gameIndex] ?? []
    );

  const otherTeamHref = selectedEntry
    ? "/live?sport=" +
      activeSport +
      "&view=advanced&gameId=" +
      selectedEntry.game.id +
      "&team=" +
      (selection.team === "home" ? "away" : "home")
    : "#";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <AdvancedLiveGameList
        sortedGames={sortedGames}
        matchedPicksByGame={matchedPicksByGame}
        activeSport={activeSport}
        selectedGameId={selection.gameId}
        selectedTeam={selection.team}
      />
      {panelData ? (
        <TeamPicksPanel data={panelData} otherTeamHref={otherTeamHref} />
      ) : (
        <div className="rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">No games found for this sport right now.</p>
        </div>
      )}
    </div>
  );
}
