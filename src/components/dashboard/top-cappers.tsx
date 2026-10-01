import Link from "next/link";
import type { LeaderboardEntry } from "@/server/data/cappers";
import type { CapperSparkline as Series } from "@/server/data/cappers-page-aggregates";
import { Avatar } from "@/components/dashboard/capper-panels";
import { SPARKLINE_MIN_PICKS } from "@/server/data/cappers-page-aggregates";
import { CapperSparkline } from "@/components/dashboard/capper-sparkline";
import { ChevronRightIcon, TrophyIcon } from "@/components/dashboard/cappers-icons";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";
// A streak badge only shows from this many in a row.
const STREAK_BADGE_MIN = 3;

export function formatRecord(s: LeaderboardEntry["stats"]) {
  return s.wins + "-" + s.losses + (s.pushes > 0 ? "-" + s.pushes : "");
}

// The top performers of the page's current time tab (the same ranking as before, now framed as a
// section). Each card carries a sparkline of the selected window (hidden below the sparkline minimum).
export function TopCappers({ entries, sparklines }: { entries: LeaderboardEntry[]; sparklines: Map<string, Series> }) {
  return (
    <section className="rounded-card border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
            <TrophyIcon />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Standout Cappers</h2>
            <p className="text-xs text-muted-foreground">Top performers based on current timeframe</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Changes with your time filter</p>
      </div>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No standout cappers for this timeframe yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {entries.map((e) => {
            const { roi, netUnits, currentStreak: streak } = e.stats;
            const series = sparklines.get(e.capperId);
            const color = roi >= 0 ? GREEN : RED;
            const showStreak = streak.type !== "NONE" && streak.count >= STREAK_BADGE_MIN;
            return (
              <Link key={e.capperId} href={"/cappers/" + e.capperId} className="block rounded-card border border-border p-4 transition hover:bg-muted">
                <div className="flex items-center gap-2.5">
                  <Avatar name={e.name} colorTag={e.colorTag} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{e.name}</p>
                    {showStreak && (
                      <span
                        className={
                          "mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (streak.type === "WIN" ? "bg-emerald-500/10 " + GREEN : "bg-red-500/10 " + RED)
                        }
                      >
                        {streak.count + (streak.type === "WIN" ? " win streak" : " loss streak")}
                      </span>
                    )}
                  </div>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {formatRecord(e.stats)} &middot; {Math.round(e.stats.winPct)}%
                </p>
                <p className={"mt-0.5 text-sm font-semibold " + color}>
                  {(netUnits >= 0 ? "+" : "−") + Math.abs(netUnits)}u &middot; {(roi >= 0 ? "+" : "−") + Math.abs(roi)}%
                </p>
                {series && series.n >= SPARKLINE_MIN_PICKS && (
                  <CapperSparkline series={series} height={32} className="mt-3 block w-full" label="Units over the selected timeframe" />
                )}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
