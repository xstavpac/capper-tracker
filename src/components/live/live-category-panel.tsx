"use client";

import { useState } from "react";
import Link from "next/link";
import { getRecordColor, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import type { CategoryLeaderboardEntry } from "@/components/dashboard/category-breakdown";
import { CategoryCard } from "@/components/dashboard/category-card";
import { GREEN, PanelShell, RED, TINTS } from "@/components/dashboard/panel-shell";
import { TargetIcon } from "@/components/dashboard/cappers-icons";

// /live's "record by category" panel: the league's markets as tinted CategoryCards in one white panel.
// Same behavior as the CategoryBreakdown it replaces here - the cards in `items` order, each one a
// toggle for a "top cappers in this category" list under the grid, one open at a time.
export function LiveCategoryPanel({
  sportLabel,
  items,
  leaderboards,
}: {
  sportLabel: string;
  items: CategoryBreakdownItem[];
  leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>>;
}) {
  const [activeKey, setActiveKey] = useState<PickCategoryKey | null>(null);

  if (items.length === 0) return null;

  const activeItem = items.find((item) => item.key === activeKey);
  const activeLeaderboard = activeItem ? (leaderboards[activeItem.key] ?? []) : [];

  return (
    <PanelShell
      theme={{ ...TINTS.neutral, title: sportLabel + " record by category", subtitle: "All-time, by market", icon: <TargetIcon className="h-[17px] w-[17px] stroke-[2.2]" /> }}
      footer={undefined}
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 min-[1100px]:grid-cols-4 min-[1500px]:grid-cols-6">
        {items.map((item) => (
          <CategoryCard
            key={item.key}
            label={item.label}
            wins={item.wins}
            losses={item.losses}
            pushes={item.pushes}
            winPct={item.winPct}
            tinted
            active={item.key === activeKey}
            onToggle={() => setActiveKey((current) => (current === item.key ? null : item.key))}
          />
        ))}
      </div>

      {activeItem && (
        <div className="mt-3 rounded-[14px] border border-[#E6E8EF] bg-[#FAFBFD] px-3.5 py-3 dark:border-border dark:bg-white/[0.03]">
          <div className="mb-1 text-[13px] font-semibold text-[#5B6275] dark:text-muted-foreground">Top cappers - {activeItem.label}</div>
          {activeLeaderboard.length === 0 ? (
            <p className="py-4 text-center text-[13px] font-medium text-muted-foreground">Not enough picks in this category yet.</p>
          ) : (
            <div className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
              {activeLeaderboard.map((entry) => (
                <div key={entry.capperId} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                  <Link href={"/cappers/" + entry.capperId} className="min-w-0 truncate font-semibold text-foreground hover:underline">
                    {entry.name}
                  </Link>
                  <span className={"shrink-0 font-semibold tabular-nums " + (getRecordColor(entry.winPct) === "green" ? GREEN : RED)}>
                    {entry.wins}-{entry.losses}
                    {entry.pushes > 0 ? "-" + entry.pushes : ""} &middot; {Math.round(entry.winPct)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
}
