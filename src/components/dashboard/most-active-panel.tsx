import type { ActivityEntry } from "@/server/data/cappers";

// Volume, not win rate - a bar per capper sized relative to whoever posted
// the most picks this week (via datePosted, see getMostActiveThisWeek),
// including still-pending ones.
export function MostActivePanel({ entries }: { entries: ActivityEntry[] }) {
  const max = entries[0]?.pickCount ?? 0;

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <h2 className="mb-3 text-base font-semibold text-foreground">Most active this week</h2>
      {entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No picks logged this week yet.</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const fill = max > 0 ? (entry.pickCount / max) * 100 : 0;
            return (
              <a key={entry.capperId} href={"/cappers/" + entry.capperId} className="block">
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{entry.name}</span>
                  <span className="text-muted-foreground">
                    {entry.pickCount} pick{entry.pickCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand-600" style={{ width: fill + "%" }} />
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
