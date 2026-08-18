"use client";

import { useState } from "react";
import Link from "next/link";
import { getRecordColor, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import { EnergyCountUp, EnergyRecordCountUp } from "@/components/dashboard/energy-surge";

export type CategoryLeaderboardEntry = {
  capperId: string;
  name: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
};

const CARD_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "bg-emerald-100 dark:bg-emerald-500/20",
  red: "bg-red-100 dark:bg-red-500/20",
};
const TEXT_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "text-emerald-700 dark:text-emerald-300",
  red: "text-red-700 dark:text-red-300",
};
// EnergySurge's tone drives its flash/ring color, not this panel's own
// green/red tint - mapped from the same getRecordColor result rather than
// introducing a second win/loss color scheme. getRecordColor never returns
// anything else, so "neutral" is unused here (kept only because the prop
// itself is a three-way union shared with the hero stats).
const RECORD_COLOR_TONE: Record<ReturnType<typeof getRecordColor>, "up" | "down"> = {
  green: "up",
  red: "down",
};

// All-time record by pick category (favorite/underdog, over/under, spread,
// F5 ML, NRFI) - answers "am I better off following favorites or dogs,
// overs or unders" at a glance. Filled tint background (not a left-edge
// accent) so the win/loss lean reads at a glance without a legend.
//
// `leaderboards` is optional and opt-in: pass it (Live page) to make tiles
// clickable, expanding a "top cappers in this category" panel below the
// grid; omit it (Dashboard, capper detail page) and tiles stay the plain,
// non-interactive cards they've always been. Keeps this one component
// reusable everywhere the breakdown shows up without forcing interactivity
// where "top cappers" wouldn't make sense (e.g. on a single capper's own
// page).
//
// `animateIn` is the same kind of opt-in, for the Dashboard specifically:
// when true, each tile's record/win% counts up via the same EnergyCountUp/
// EnergyRecordCountUp the hero stats already use (ring pulses + lightning-
// bolt flash, then the count-up), so this panel joins their synchronized
// load-in beat instead of rendering static. Omit it (Live page, capper
// detail page) and tiles render exactly as they always have - plain
// numbers, no animation.
export function CategoryBreakdown({
  items,
  leaderboards,
  animateIn = false,
}: {
  items: CategoryBreakdownItem[];
  leaderboards?: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>>;
  animateIn?: boolean;
}) {
  const [activeKey, setActiveKey] = useState<PickCategoryKey | null>(null);

  if (items.length === 0) return null;

  const clickable = !!leaderboards;
  const activeItem = clickable ? items.find((item) => item.key === activeKey) : undefined;
  const activeLeaderboard = activeItem ? (leaderboards?.[activeItem.key] ?? []) : [];

  function toggle(key: PickCategoryKey) {
    setActiveKey((current) => (current === key ? null : key));
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-fr sm:grid-rows-2">
        {items.map((item) => {
          const color = getRecordColor(item.winPct);
          const isActive = clickable && item.key === activeKey;
          return (
            <div
              key={item.key}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => toggle(item.key) : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(item.key);
                      }
                    }
                  : undefined
              }
              className={
                "rounded-card p-3 " +
                CARD_CLASSES[color] +
                (isActive ? " ring-2 ring-blue-400 dark:ring-blue-300" : "") +
                (clickable ? " cursor-pointer select-none transition hover:opacity-90" : "")
              }
            >
              <div className={"text-xs " + TEXT_CLASSES[color]}>{item.label}</div>
              {animateIn ? (
                <>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    <EnergyRecordCountUp
                      wins={item.wins}
                      losses={item.losses}
                      pushes={item.pushes > 0 ? item.pushes : undefined}
                      tone={RECORD_COLOR_TONE[color]}
                    />
                  </div>
                  <div className={"mt-0.5 text-sm font-semibold " + TEXT_CLASSES[color]}>
                    <EnergyCountUp value={item.winPct} suffix="%" tone={RECORD_COLOR_TONE[color]} />
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    {item.wins}-{item.losses}
                    {item.pushes > 0 ? "-" + item.pushes : ""}
                  </div>
                  <div className={"mt-0.5 text-sm font-semibold " + TEXT_CLASSES[color]}>
                    {Math.round(item.winPct)}%
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {activeItem && (
        <div className="mt-3 rounded-card bg-card p-4 shadow-soft">
          <div className="mb-2 text-sm font-medium text-muted-foreground">Top cappers - {activeItem.label}</div>
          {activeLeaderboard.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Not enough picks in this category yet.</p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {activeLeaderboard.map((entry) => {
                const color = getRecordColor(entry.winPct);
                return (
                  <div key={entry.capperId} className="flex items-center justify-between py-2 text-sm">
                    <Link href={"/cappers/" + entry.capperId} className="font-medium text-foreground hover:underline">
                      {entry.name}
                    </Link>
                    <span className={TEXT_CLASSES[color]}>
                      {entry.wins}-{entry.losses}
                      {entry.pushes > 0 ? "-" + entry.pushes : ""} &middot; {Math.round(entry.winPct)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
