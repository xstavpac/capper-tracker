"use client";

// "Add game": puts a leg's GAME on the Parlay slip - "the best pick from this
// game", chosen when the slip is built (lib/parlay/slip-build.ts) - not the
// pick shown. The light-surface look of the slip's own Parlay slip button
// (parlay-slip-button.tsx), sized to sit in a leg row.
import { useOptionalParlayPool } from "@/components/parlay/parlay-pool-context";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

type GamePick = Pick<ExpanderPick, "gameId" | "gameLabel" | "gameTime" | "leagueName">;

// A pick with no board game (offBoardSlipPick's "pick:" id) has no game to add.
export function hasBoardGame(pick: GamePick): boolean {
  return !pick.gameId.startsWith("pick:");
}

export function AddGameButton({ pick }: { pick: GamePick }) {
  const slip = useOptionalParlayPool();
  if (!slip || !hasBoardGame(pick)) return null;
  const { isGameInSlip, addGame, removeGame } = slip;
  const inSlip = isGameInSlip(pick.gameId);
  return (
    <button
      type="button"
      onClick={() => (inSlip ? removeGame(pick.gameId) : addGame(pick))}
      aria-pressed={inSlip}
      aria-label={(inSlip ? "Remove " : "Add ") + pick.gameLabel + (inSlip ? " from" : " to") + " Parlay slip"}
      title={inSlip ? "This game is in your Parlay slip - click to remove it" : "Add this game to your Parlay slip - its best pick is chosen when you build"}
      className={
        "inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-semibold shadow-soft transition " +
        (inSlip ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-muted")
      }
    >
      {inSlip ? "Game in slip" : "+ Add game"}
    </button>
  );
}
