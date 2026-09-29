import Link from "next/link";
import type { HottestEntry } from "@/server/data/cappers-page-aggregates";

// Net units over the same 7 days as Most active, graded picks only (see the "hot" CTE in
// cappers-page-aggregates.ts). Only winners appear, so the bar is sized against the #1 capper.
export function HottestPanel({ entries }: { entries: HottestEntry[] }) {
  const max = entries[0]?.netUnits ?? 0;

  return (
    <div className="h-full rounded-card bg-card p-5 shadow-soft">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-foreground">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true">
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
        Hottest this week
      </h2>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No winning cappers yet this week</p>
      ) : (
        <div className="space-y-2.5">
          {entries.map((entry) => (
            <Link
              key={entry.capperId}
              href={"/cappers/" + entry.capperId}
              className="grid grid-cols-[6.5rem_1fr_3.75rem] items-center gap-3 text-sm hover:opacity-80 sm:grid-cols-[minmax(7rem,12rem)_1fr_4.5rem] sm:gap-4"
            >
              <span className="truncate font-medium text-foreground">{entry.name}</span>
              <span className="h-2 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-emerald-500" style={{ width: (max > 0 ? (entry.netUnits / max) * 100 : 0) + "%" }} />
              </span>
              <span className="text-right font-medium text-emerald-600 dark:text-emerald-400">{"+" + entry.netUnits.toFixed(1) + "u"}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
