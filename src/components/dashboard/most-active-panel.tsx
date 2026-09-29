import Link from "next/link";
import type { ActivityEntry } from "@/server/data/cappers";

// Volume, not win rate - a bar per capper sized relative to whoever posted the most
// picks this week (via datePosted, see getMostActiveThisWeek), including still-pending ones.
export function MostActivePanel({ entries }: { entries: ActivityEntry[] }) {
  const max = entries[0]?.pickCount ?? 0;

  return (
    <div className="h-full rounded-card bg-card p-5 shadow-soft">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-foreground">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-orange-500" aria-hidden="true">
          <path d="M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z" />
        </svg>
        Most active this week
      </h2>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No picks logged this week yet.</p>
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
                <span className="block h-full rounded-full bg-brand-600" style={{ width: (max > 0 ? (entry.pickCount / max) * 100 : 0) + "%" }} />
              </span>
              <span className="text-right text-muted-foreground">
                {entry.pickCount} pick{entry.pickCount === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
