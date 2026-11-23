// The compact line under a started game's pick on the Parlay page - the slip's
// "Your picks", a generated leg, a Swap row: "Started · Q2 4:12 · 45-41", then
// what its (pregame) price is. Nothing for a game that hasn't started or is over.
import type { GameClock } from "@/lib/parlay/game-over";
import { isStarted, startedPriceKind, startedPriceLabel, startedStateLine, type GameLiveState } from "@/lib/parlay/game-progress";

export type StartedGame = GameClock & { leagueName: string; liveState?: GameLiveState | null };

export function StartedLine({ game, now = new Date(), className = "" }: { game: StartedGame; now?: Date; className?: string }) {
  if (!isStarted(game, now)) return null;
  const changed = startedPriceKind(game) === "changed";
  return (
    <p data-started-line className={"text-xs font-medium " + className}>
      <span className="font-semibold text-red-700 dark:text-red-300">{startedStateLine(game.leagueName, game.liveState)}</span>
      <span className="text-muted-foreground"> · </span>
      <span data-price-label className={changed ? "text-amber-700/90 dark:text-amber-400/90" : "text-muted-foreground"}>
        {startedPriceLabel(game)}
      </span>
    </p>
  );
}
