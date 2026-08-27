"use client";

import { useState } from "react";
import type { GamePulsePanelRow } from "@/server/data/game-pulse";
import { shortTeamName } from "@/lib/pick-team-group";
import { ChevronIcon } from "@/components/live/game-picks-expander";

// Always renders all 5 rows once expanded (see buildGamePulsePanelRows)
// regardless of data availability - a row with nothing that clears the
// confidence floor shows "Not enough data yet" rather than being omitted,
// so the panel's shape never shifts as a team's sample grows over the
// season. Collapsed by default, same toggle pattern as GamePicksExpander -
// the detail page already leads with the score/odds card and "Your picks on
// this game", so this stays out of the way until a visitor asks for it.
export function GamePulsePanel({
  rows,
  homeTeam,
  awayTeam,
  sportLabel,
}: {
  rows: GamePulsePanelRow[];
  homeTeam: string;
  awayTeam: string;
  sportLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const awayShort = shortTeamName(awayTeam, sportLabel);
  const homeShort = shortTeamName(homeTeam, sportLabel);

  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-muted-foreground"
      >
        <span>Game Pulse &middot; historical situational trends</span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div className="divide-y divide-border-subtle border-t border-border-subtle">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 px-5 py-3">
              <span className="text-sm font-medium text-foreground">{row.title}</span>
              {row.showData ? (
                <span className="whitespace-nowrap text-right text-xs">
                  <TeamRate name={awayShort} winPct={row.away.winPct} highlighted={row.highlightSide === "away"} />
                  <span className="mx-1.5 text-muted-foreground">&middot;</span>
                  <TeamRate name={homeShort} winPct={row.home.winPct} highlighted={row.highlightSide === "home"} />
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Not enough data yet</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The highlighted side is bold + brand-colored (this app's standard accent,
// see e.g. the back link on this same page); the other side stays muted -
// per row, at most one side is ever highlighted (see buildGamePulsePanelRows'
// highlightSide, which is null only when the row is already "Not enough
// data yet" and never reaches here).
function TeamRate({ name, winPct, highlighted }: { name: string; winPct: number; highlighted: boolean }) {
  return (
    <span className={highlighted ? "font-semibold text-brand-600 dark:text-brand-400" : "text-muted-foreground"}>
      {name} {Math.round(winPct)}%
    </span>
  );
}
