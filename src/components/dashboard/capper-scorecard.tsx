import { getRecordColor, type ScorecardBucket } from "@/server/data/stats";

const COLOR_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  red: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400",
};

export function CapperScorecard({
  buckets,
  variant = "grid",
}: {
  buckets: ScorecardBucket[];
  variant?: "grid" | "inline";
}) {
  if (buckets.length === 0) return null;

  if (variant === "inline") {
    return (
      <div className="flex flex-wrap gap-1.5">
        {buckets.map((b) => (
          <span
            key={b.key}
            className={"rounded-full px-2 py-0.5 text-xs font-medium " + COLOR_CLASSES[getRecordColor(b.winPct)]}
          >
            {b.label}: {b.wins}-{b.losses}-{b.pushes} ({Math.round(b.winPct)}%)
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
      {buckets.map((b) => (
        <div key={b.key} className="rounded-card bg-card p-3 shadow-soft">
          <div className="text-xs text-muted-foreground">{b.label}</div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {b.wins}-{b.losses}-{b.pushes}
          </div>
          <span
            className={
              "mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
              COLOR_CLASSES[getRecordColor(b.winPct)]
            }
          >
            {Math.round(b.winPct)}%
          </span>
        </div>
      ))}
    </div>
  );
}
