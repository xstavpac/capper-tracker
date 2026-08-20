"use client";

import { useState } from "react";
import type { GamePulseResult } from "@/server/data/game-pulse";
import { ChevronIcon } from "@/components/live/game-picks-expander";

// Duplicated rather than imported from grading.ts's identical helper - that
// module has a module-level prisma import, which a "use client" component
// must never pull in even transitively (same reasoning as
// live-scoreboard.tsx's own matchScoreToGame duplication).
function teamNickname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toUpperCase();
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path d="M3 12h4l2 8 4-16 2 8h6" />
    </svg>
  );
}

// Sits below the tile's Link wrapper, same slot/pattern as
// GamePicksExpander - a small toggle that reveals up to 4 evidence lines
// without navigating the tile (stopPropagation, same as GamePicksExpander's
// own toggle). Renders nothing when there's no clear lean - "too close to
// call" is silence, not a weak indicator (see computeGamePulseFromRates,
// which returns null in exactly that case).
export function GamePulseBadge({ pulse }: { pulse: GamePulseResult | null }) {
  const [open, setOpen] = useState(false);

  if (!pulse) return null;

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  }

  return (
    <div onClick={(e) => e.preventDefault()} className="mt-2">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 transition hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:hover:bg-amber-500/25"
      >
        <PulseIcon />
        LEANING {teamNickname(pulse.leaningTeam)}
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-border-subtle bg-muted/40 p-2.5">
          {pulse.evidence.map((e) => (
            <div key={e.questionKey} className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">{e.subjectTeam}</span> historically win{" "}
              <span className={"font-medium " + (e.winPct >= 50 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{e.winPct}%</span>{" "}
              ({e.sampleSize} games) when they {e.label}.
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
