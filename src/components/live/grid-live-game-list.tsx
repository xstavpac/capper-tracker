import type { OddsGame, ScoreGame } from "@/server/data/odds";
import { LocalGameTime } from "@/components/local-game-time";
import { getTeamColor } from "@/lib/team-colors";
import { TeamColorBar } from "@/components/live/team-color-bar";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

// The compact, one-row-per-game list Grid Live shows instead of Feed
// Live's full accordion cards. Deliberately minimal - just enough to
// identify and select a game (teams, live status/score, pick count) - not
// the odds/spread/total detail the Feed Live card shows. Consumes the
// exact same `sortedGames` shape live-scoreboard.tsx already derives
// (game/gameIndex/score triples from orderBoardGames), so selecting which
// games appear and in what order is unchanged, shared logic - nothing here
// re-decides visibility or ordering.
//
// Selecting a game is a plain onClick into the parent's client state, NOT a
// <Link> navigation - a real navigation re-runs live/page.tsx's server data
// fetch (odds/scores/picks) just to switch to a game whose data the board
// already has in memory, which was the cause of a flicker + scroll-to-top on
// every game click. The parent still mirrors the selection into the URL
// (see grid-live-board.tsx) so it stays bookmarkable/shareable.
export function GridLiveGameList({
  sortedGames,
  matchedPicksByGame,
  activeSport,
  selectedGameId,
  onSelectGame,
  onOpenGame,
}: {
  sortedGames: { game: OddsGame; gameIndex: number; score: ScoreGame | undefined }[];
  matchedPicksByGame: ExpanderPick[][];
  activeSport: string;
  selectedGameId: string | null;
  onSelectGame: (gameId: string) => void;
  // Double-click only - opens Feed Live's full game-card page (Momentum/
  // Pace tracking, head-to-head header), which Grid's own in-panel
  // GameDetailPanel doesn't have room for and isn't meant to duplicate.
  // Single click stays a plain in-panel selection (onSelectGame above) - see
  // this file's header comment on why that's a client-state update, not a
  // navigation.
  onOpenGame: (gameId: string) => void;
}) {
  if (sortedGames.length === 0) {
    return (
      <div className="rounded-card bg-card p-6 text-center shadow-soft">
        <p className="text-sm text-muted-foreground">No games found for this sport right now.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {sortedGames.map(({ game, gameIndex, score }) => {
        const isSelected = game.id === selectedGameId;
        const isLive = score?.status === "live";
        const pickCount = matchedPicksByGame[gameIndex]?.length ?? 0;

        return (
          <button
            key={game.id}
            type="button"
            onClick={() => onSelectGame(game.id)}
            onDoubleClick={() => onOpenGame(game.id)}
            className={
              "block w-full rounded-lg border px-3 py-2 text-left transition-colors " +
              (isSelected
                ? "border-brand-300 bg-brand-50 dark:border-brand-700 dark:bg-brand-500/10"
                : "border-border-subtle bg-card hover:bg-muted")
            }
          >
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                <LocalGameTime
                  date={game.commenceTime}
                  options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
                />
              </span>
              {isLive ? (
                <span className="rounded-full bg-red-100 px-1.5 py-0 text-[10px] font-medium text-red-600 dark:bg-red-500/15 dark:text-red-400">
                  LIVE
                </span>
              ) : (
                pickCount > 0 && <span>{pickCount} pick{pickCount === 1 ? "" : "s"}</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <TeamColorBar color={getTeamColor(activeSport, game.awayTeam)} />
                <span className="truncate text-xs font-medium">{game.awayTeam}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {score?.scores?.find((s) => s.name === game.awayTeam)?.score ?? ""}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <TeamColorBar color={getTeamColor(activeSport, game.homeTeam)} />
                <span className="truncate text-xs font-medium">{game.homeTeam}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {score?.scores?.find((s) => s.name === game.homeTeam)?.score ?? ""}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
