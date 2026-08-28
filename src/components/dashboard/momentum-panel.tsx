import {
  RANKING_MIN_SAMPLE,
  getRecordColor,
  type MomentumBreakdown,
  type MomentumRow,
  type MomentumStreakLength,
} from "@/server/data/stats";

const LENGTH_LABEL: Record<MomentumStreakLength, string> = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4+": "4+",
};

// Whether `row` is the bucket the capper's actual current streak falls
// into - e.g. currently on a 5-game loss streak highlights the "After 4+L"
// row (5 collapses into the same 4+ bucket the row itself represents), not
// a nonexistent "After 5L" row. Only ever true for one row across all 8,
// and never true at all when currentStreak.type is "NONE" (no decided
// picks yet).
function isCurrentStreakRow(
  section: "LOSS" | "WIN",
  length: MomentumStreakLength,
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number }
): boolean {
  if (currentStreak.type !== section || currentStreak.count === 0) return false;
  return length === (currentStreak.count >= 4 ? "4+" : String(currentStreak.count));
}

function MomentumRowView({
  row,
  suffix,
  highlighted,
}: {
  row: MomentumRow;
  suffix: "L" | "W";
  highlighted: boolean;
}) {
  const enoughData = row.sampleSize >= RANKING_MIN_SAMPLE;
  return (
    <div
      className={
        "flex items-center justify-between gap-4 px-5 py-3" +
        (highlighted ? " bg-brand-50 dark:bg-brand-500/10" : "")
      }
    >
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        After {LENGTH_LABEL[row.length]}
        {suffix}
        {highlighted && (
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
            Current
          </span>
        )}
      </span>

      {enoughData ? (
        <span className="flex items-center gap-4 text-xs">
          <span className="text-muted-foreground">
            {row.wins}-{row.losses}
          </span>
          <span
            className={
              "font-medium " +
              (getRecordColor(row.winPct) === "green"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400")
            }
          >
            {Math.round(row.winPct)}%
          </span>
          <span
            className={
              "font-medium " +
              (row.netUnits >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")
            }
          >
            {row.netUnits >= 0 ? "+" : ""}
            {row.netUnits}u
          </span>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Not enough data</span>
      )}
    </div>
  );
}

// Historical record on the pick immediately following a losing/winning
// streak of each length - always all 8 rows (both directions x all 4 length
// buckets), never filtered down to just the capper's current situation (see
// computeMomentum in server/data/stats.ts). The row matching their actual
// current streak is highlighted so "what does history say about right now"
// reads at a glance against the full picture around it.
export function MomentumPanel({
  breakdown,
  currentStreak,
}: {
  breakdown: MomentumBreakdown;
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number };
}) {
  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
        Momentum
      </div>

      <div className="border-b border-border-subtle px-5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        After a losing streak
      </div>
      <div className="divide-y divide-border-subtle">
        {breakdown.afterLoss.map((row) => (
          <MomentumRowView
            key={row.length}
            row={row}
            suffix="L"
            highlighted={isCurrentStreakRow("LOSS", row.length, currentStreak)}
          />
        ))}
      </div>

      <div className="border-b border-t border-border-subtle px-5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        After a winning streak
      </div>
      <div className="divide-y divide-border-subtle">
        {breakdown.afterWin.map((row) => (
          <MomentumRowView
            key={row.length}
            row={row}
            suffix="W"
            highlighted={isCurrentStreakRow("WIN", row.length, currentStreak)}
          />
        ))}
      </div>
    </div>
  );
}
