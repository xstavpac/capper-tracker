"use client";

// "Target game" on a Live game card - shown only in slip mode, beside the
// cards' pick checkboxes. Targeting a game tells the generator to build from
// it (and the other targeted games, plus your picks' games) instead of the
// full slate - no pick needs checking. A game one of your picks is on shows
// "Targeted via your picks" and can't be unchecked while the pick is there.
// Writes straight into the slip, like the pick checkboxes.
import { useOptionalParlayPool, type SlipGame } from "@/components/parlay/parlay-pool-context";
import type { GameClock } from "@/lib/parlay/game-over";
import { targetCheckboxState } from "@/lib/parlay/select-checkbox-state";

export function TargetGameCheckbox({ game, dark = false, className = "" }: { game: SlipGame & GameClock; dark?: boolean; className?: string }) {
  const slip = useOptionalParlayPool();
  if (!slip || !slip.slipMode) return null;
  const viaPicks = slip.isTargetedViaPicks(game.gameId);
  const targeted = slip.targets.some((t) => t.gameId === game.gameId);
  const { disabled, title, label } = targetCheckboxState(game, targeted, viaPicks, new Date());
  return (
    <label
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={
        "inline-flex min-h-8 shrink-0 items-center gap-1.5 text-xs font-semibold " +
        className +
        " " +
        (disabled && !viaPicks ? "cursor-not-allowed opacity-50 " : "cursor-pointer ") +
        (dark ? "text-white" : "text-foreground")
      }
    >
      <input
        type="checkbox"
        checked={targeted || viaPicks}
        disabled={disabled}
        onChange={() => !disabled && slip.toggleTarget(game)}
        className="h-4 w-4 rounded border-border-subtle accent-brand-600 disabled:cursor-not-allowed"
        aria-label={(viaPicks ? "Targeted via your picks: " : targeted ? "Stop targeting " : "Target ") + game.gameLabel}
      />
      {label}
    </label>
  );
}
