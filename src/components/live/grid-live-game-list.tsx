import type { OddsGame, ScoreGame } from "@/server/data/odds";
import { LocalGameTime } from "@/components/local-game-time";
import { getTeamColor } from "@/lib/team-colors";
import { TeamColorBar } from "@/components/live/team-color-bar";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { getLiveGameProgress } from "@/lib/live-game-progress";
import { teamScore } from "@/components/live/live-scoreboard-ordering";
import { LiveProgressBar, LiveProgressLabel } from "@/components/live/live-progress-bar";
import { TINTS } from "@/components/dashboard/panel-shell";
import { CalendarIcon } from "@/components/dashboard/cappers-icons";
import { unplayedLabel } from "@/lib/feed-game-status";
import { SeeMoreGamesButton } from "@/components/live/live-list-scope";
import { TargetGameCheckbox } from "@/components/parlay/target-game-checkbox";
import { tileOdds } from "@/lib/grid-tile-odds";

// The compact, one-row-per-game list Grid Live shows instead of Feed
// Live's full accordion cards. Deliberately minimal - just enough to
// identify and select a game (teams, live status/score, pick count, moneyline
// and total) - not the spread / total-price detail the Feed Live card shows. Consumes the
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
  hiddenCount,
  matchedPicksByGame,
  activeSport,
  sportLabel,
  selectedGameId,
  onSelectGame,
  onOpenGame,
}: {
  sortedGames: { game: OddsGame; gameIndex: number; score: ScoreGame | undefined }[];
  // Games the default today-and-live scope hides (the "See more" button's count; 0 = no button).
  hiddenCount: number;
  matchedPicksByGame: ExpanderPick[][];
  activeSport: string;
  // The league's name ("NFL"), for the slip's "Target game".
  sportLabel: string;
  selectedGameId: string | null;
  onSelectGame: (gameId: string) => void;
  // Double-click only - opens Feed Live's full game-card page (head-to-head
  // header, full picks list), which Grid's own in-panel
  // GameDetailPanel doesn't have room for and isn't meant to duplicate.
  // Single click stays a plain in-panel selection (onSelectGame above) - see
  // this file's header comment on why that's a client-state update, not a
  // navigation.
  onOpenGame: (gameId: string) => void;
}) {
  if (sortedGames.length === 0) {
    return (
      <div className={"rounded-[18px] border p-6 text-center " + TINTS.blue.card}>
        <p className="text-[13px] font-medium text-muted-foreground">No games found for this sport right now.</p>
      </div>
    );
  }

  return (
    <section className={"rounded-[18px] border p-3 " + TINTS.blue.card}>
      <div className="mb-2.5 flex items-center gap-3 px-0.5">
        <span className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center " + TINTS.blue.iconWrap}>
          <CalendarIcon className="h-[15px] w-[15px] stroke-[2.2]" />
        </span>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Games</h2>
      </div>
      <div className="space-y-2">
      {sortedGames.map(({ game, gameIndex, score }) => {
        const isSelected = game.id === selectedGameId;
        const isLive = score?.status === "live";
        const unplayed = unplayedLabel(score?.status);
        const odds = tileOdds(game);
        // The odds feed drops events at commence time, so a live game's numbers are
        // the last pregame pull - muted like the Feed card's (#442), style only.
        const staleOdds = isLive ? " opacity-50" : "";
        const pickCount = matchedPicksByGame[gameIndex]?.length ?? 0;
        // Shared by the live and pregame headers so the pill is identical in both.
        const picksPill =
          pickCount > 0 ? (
            <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10.5px] font-semibold leading-none text-white dark:bg-brand-500">
              {pickCount} pick{pickCount === 1 ? "" : "s"}
            </span>
          ) : null;
        // Desktop-only (see the `lg:` gates below) - mobile's collapsed list
        // rows stay pixel-identical whether or not a game is live or
        // selected, per this component's file header on why selecting a
        // game must never move mobile's scroll position; the tapped card's
        // own row is no exception. Mobile's only progress display is inside
        // GameDetailPanel, once a game is tapped (see team-picks-panel.tsx).
        const progress = isLive ? getLiveGameProgress(activeSport, score) : null;

        return (
          <div
            key={game.id}
            className={
              "rounded-xl border bg-white transition-colors dark:bg-card " +
              (isSelected
                ? "border-brand-600 ring-1 ring-brand-600 dark:border-brand-400 dark:ring-brand-400"
                : "border-[#E1E7FA] hover:border-brand-300 dark:border-border dark:hover:border-brand-500/60")
            }
          >
          <button
            type="button"
            onClick={() => onSelectGame(game.id)}
            onDoubleClick={() => onOpenGame(game.id)}
            className="block w-full px-3 py-2.5 text-left"
          >
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-[#5B6275] dark:text-muted-foreground">
              <span>
                <LocalGameTime
                  date={game.commenceTime}
                  options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
                />
              </span>
              {isLive ? (
                <span className="flex items-center gap-1.5">
                  {progress && !isSelected && (
                    <span className="hidden lg:inline">
                      <LiveProgressLabel label={progress.label} />
                    </span>
                  )}
                  <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-red-600 dark:bg-red-500/15 dark:text-red-400">
                    LIVE
                  </span>
                  {picksPill}
                </span>
              ) : unplayed || pickCount > 0 ? (
                <span className="flex items-center gap-1.5">
                  {unplayed && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
                      {unplayed.toUpperCase()}
                    </span>
                  )}
                  {picksPill}
                </span>
              ) : null}
            </div>
            <div className="flex items-stretch gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <TeamColorBar color={getTeamColor(activeSport, game.awayTeam)} />
                    <span className="truncate text-[13px] font-semibold text-foreground">{game.awayTeam}</span>
                  </span>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                    {teamScore(score, game.awayTeam, activeSport) ?? ""}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <TeamColorBar color={getTeamColor(activeSport, game.homeTeam)} />
                    <span className="truncate text-[13px] font-semibold text-foreground">{game.homeTeam}</span>
                  </span>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                    {teamScore(score, game.homeTeam, activeSport) ?? ""}
                  </span>
                </div>
              </div>
              {(odds.away || odds.home) && (
                <div className={"flex shrink-0 flex-col justify-between border-l border-[#E1E7FA] pl-3 text-right text-[13px] tabular-nums text-muted-foreground dark:border-border" + staleOdds}>
                  <span>{odds.away ?? " "}</span>
                  <span className="mt-1">{odds.home ?? " "}</span>
                </div>
              )}
              {odds.total && (
                <div className={"flex w-[72px] shrink-0 flex-col items-center justify-center rounded-lg bg-[#EEF2FF] px-2 py-1 dark:bg-brand-500/10" + staleOdds}>
                  <span className="text-[10px] font-medium leading-none text-muted-foreground">O/U</span>
                  <span className="mt-0.5 text-[15px] font-semibold leading-tight tabular-nums text-foreground">{odds.total}</span>
                </div>
              )}
            </div>
            {isSelected && progress && (
              <div className="hidden lg:block">
                <LiveProgressBar pct={progress.pct} label={progress.label} />
              </div>
            )}
          </button>
          {/* Slip mode only: target this game without opening it (a sibling of the select button, never inside it). */}
          <TargetGameCheckbox
            className="mx-3 mb-1.5 mt-[-4px]"
            game={{
              gameId: game.id,
              gameLabel: matchedPicksByGame[gameIndex]?.[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
              gameTime: game.commenceTime,
              gameStatus: score?.status ?? null,
              leagueName: sportLabel,
            }}
          />
          </div>
        );
      })}
      <SeeMoreGamesButton hiddenCount={hiddenCount} />
      </div>
    </section>
  );
}
