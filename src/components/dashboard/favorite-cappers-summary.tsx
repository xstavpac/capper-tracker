"use client";

import { useState } from "react";
import type { FavoriteCappersSummary as FavoriteCappersSummaryData } from "@/server/data/cappers";
import { getRecordColor, SCORECARD_WINDOWS, SCORECARD_WINDOW_LABELS, type ScorecardWindow } from "@/server/data/stats";
import { Avatar, StreakBadge } from "@/components/dashboard/capper-panels";

function windowChipClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1.5 text-sm font-medium " +
    (isActive ? "bg-brand-600 text-white" : "bg-card text-muted-foreground shadow-soft hover:bg-muted")
  );
}

// Same tile shape as the capper detail page's StatCard, duplicated rather
// than imported since that one's a private, unexported piece of that page -
// visually identical (rounded-card/shadow-soft/text-2xl), just sized down
// (p-3/text-xl) to read as a secondary summary, not the main stat block on
// the page.
function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass =
    tone === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";
  return (
    <div className="rounded-card bg-card p-3 shadow-soft">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={"mt-0.5 whitespace-nowrap text-xl font-semibold " + toneClass}>{value}</div>
    </div>
  );
}

// All 5 windows pre-fetched up front (same "toggle is instant, no reload"
// pattern the leaderboard table already uses) - the window state here is
// deliberately independent of the leaderboard table's own window toggle
// below it; nothing links the two, each remembers its own selection.
export function FavoriteCappersSummary({
  summaryByWindow,
}: {
  summaryByWindow: Record<ScorecardWindow, FavoriteCappersSummaryData>;
}) {
  const [window, setWindow] = useState<ScorecardWindow>("ALL");
  const summary = summaryByWindow[window];
  const { collectiveStats, entries } = summary;

  return (
    <div className="mb-6 rounded-card bg-card p-5 shadow-soft">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          <span className="text-amber-400" aria-hidden="true">
            &#9733;
          </span>
          Favorites
        </div>
        <div className="flex flex-wrap gap-2">
          {SCORECARD_WINDOWS.map((w) => (
            <button key={w} type="button" onClick={() => setWindow(w)} className={windowChipClass(window === w)}>
              {SCORECARD_WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
      </div>

      {/* Collective summary - Record/ROI/Net units pooled across every
          favorited capper's picks. Deliberately no streak here (see
          getFavoriteCappersSummary/computeStats callers elsewhere) - a
          streak is a chronological consecutive-result count and has no
          coherent meaning pooled across multiple independent cappers'
          interleaved results. Each capper's own real streak is still shown
          per-row below instead. */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryStat label="Record" value={collectiveStats.wins + "-" + collectiveStats.losses + "-" + collectiveStats.pushes} />
        <SummaryStat
          label="ROI"
          value={(collectiveStats.roi >= 0 ? "+" : "") + collectiveStats.roi + "%"}
          tone={collectiveStats.roi >= 0 ? "up" : "down"}
        />
        <SummaryStat
          label="Net units"
          value={(collectiveStats.netUnits >= 0 ? "+" : "") + collectiveStats.netUnits + "u"}
          tone={collectiveStats.netUnits >= 0 ? "up" : "down"}
        />
      </div>

      <div className="space-y-1">
        {entries.map((entry) => {
          const color = getRecordColor(entry.stats.winPct);
          return (
            <a
              key={entry.capperId}
              href={"/cappers/" + entry.capperId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-muted"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Avatar name={entry.name} colorTag={entry.colorTag} size={26} />
                <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
                <StreakBadge streak={entry.stats.currentStreak} compact />
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                <span className="text-muted-foreground">
                  {entry.stats.wins}-{entry.stats.losses}
                  {entry.stats.pushes > 0 ? "-" + entry.stats.pushes : ""}
                </span>
                <span className={"font-medium " + (color === "green" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                  {entry.stats.roi >= 0 ? "+" : ""}
                  {entry.stats.roi}%
                </span>
                <span className={"font-medium " + (entry.stats.netUnits >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                  {entry.stats.netUnits >= 0 ? "+" : ""}
                  {entry.stats.netUnits}u
                </span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
