import Link from "next/link";
import type { LeaderboardEntry } from "@/server/data/cappers";
import type { CapperSparkline as Series } from "@/server/data/cappers-page-aggregates";
import { Avatar } from "@/components/dashboard/capper-panels";
import { CapperSparkline } from "@/components/dashboard/capper-sparkline";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";

export function formatRecord(s: LeaderboardEntry["stats"]) {
  return s.wins + "-" + s.losses + (s.pushes > 0 ? "-" + s.pushes : "");
}

export function TopCappers({ entries, sparklines }: { entries: LeaderboardEntry[]; sparklines: Map<string, Series> }) {
  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-foreground">Top cappers</h2>
      {entries.length === 0 ? (
        <p className="rounded-card bg-card p-5 text-center text-sm text-muted-foreground shadow-soft">
          No cappers meet the minimum picks for this period.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {entries.map((e) => {
            const { roi, netUnits } = e.stats;
            const color = roi >= 0 ? GREEN : RED;
            return (
              <Link key={e.capperId} href={"/cappers/" + e.capperId} className="block rounded-card bg-card p-4 shadow-soft transition hover:bg-muted">
                <div className="flex items-center gap-2.5">
                  <Avatar name={e.name} colorTag={e.colorTag} size={32} />
                  <span className="truncate text-sm font-semibold text-foreground">{e.name}</span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {formatRecord(e.stats)} &middot; {Math.round(e.stats.winPct)}%
                </p>
                <p className={"mt-0.5 text-sm font-semibold " + color}>
                  {(roi >= 0 ? "+" : "−") + Math.abs(roi)}% &middot; {(netUnits >= 0 ? "+" : "−") + Math.abs(netUnits)}u
                </p>
                <CapperSparkline series={sparklines.get(e.capperId)} height={32} className="mt-3 block w-full" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
