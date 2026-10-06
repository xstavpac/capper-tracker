import { RANKING_MIN_SAMPLE, getRecordColor, type MomentumBreakdown, type MomentumRow } from "@/server/data/stats";

// The bucket the capper's actual current streak falls into - e.g. currently on
// a 5-game loss streak is the "After 4+ L" row (5 collapses into the same 4+
// bucket the row itself represents). Undefined when currentStreak.type is
// "NONE" (no decided picks yet).
function currentStreakRow(
  breakdown: MomentumBreakdown,
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number }
): MomentumRow | undefined {
  if (currentStreak.type === "NONE" || currentStreak.count === 0) return undefined;
  const length = currentStreak.count >= 4 ? "4+" : String(currentStreak.count);
  return (currentStreak.type === "WIN" ? breakdown.afterWin : breakdown.afterLoss).find((row) => row.length === length);
}

// "What does history say about right now": the capper's record on the pick
// immediately following a streak like the one they are on (see computeMomentum
// in server/data/stats.ts) - that one bucket only. Always all sports, all time.
export function MomentumPanel({
  breakdown,
  currentStreak,
}: {
  breakdown: MomentumBreakdown;
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number };
}) {
  const row = currentStreakRow(breakdown, currentStreak);
  const enoughData = row !== undefined && row.sampleSize >= RANKING_MIN_SAMPLE;

  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
        <span>Momentum</span>
        <span className="text-xs font-normal">All sports · All time</span>
      </div>

      {row && enoughData ? (
        <div className="flex items-center justify-between gap-4 rounded-b-card bg-brand-50 px-5 py-3 dark:bg-brand-500/10">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            After {row.length} {currentStreak.type === "WIN" ? "W" : "L"}
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
              Current
            </span>
          </span>
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
        </div>
      ) : (
        <p className="px-5 py-3 text-sm text-muted-foreground">Not enough history yet</p>
      )}
    </div>
  );
}
