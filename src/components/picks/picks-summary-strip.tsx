import type { PicksSummary } from "@/server/data/picks-summary";

function signedUnits(n: number): string {
  return (n > 0 ? "+" : "") + n.toFixed(2) + "u";
}

function tone(n: number): string {
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : n < 0 ? "text-red-600 dark:text-red-400" : "text-foreground";
}

function Card({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-card bg-card px-4 py-3 shadow-soft">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={"mt-1 text-xl font-semibold tabular-nums " + (valueClass ?? "text-foreground")}>{value}</div>
    </div>
  );
}

// Four metric cards for the current filter set: 4-up on desktop, 2x2 on phones.
// `pending` is the Upcoming section's count (see pendingCount): game not started.
export function PicksSummaryStrip({ summary, pending }: { summary: PicksSummary; pending: number }) {
  const decided = summary.wins + summary.losses + summary.pushes;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card label="Record" value={summary.wins + "-" + summary.losses + "-" + summary.pushes} />
      <Card label="Units" value={signedUnits(summary.netUnits)} valueClass={tone(summary.netUnits)} />
      <Card
        label="ROI"
        value={decided > 0 ? (summary.roi > 0 ? "+" : "") + summary.roi.toFixed(1) + "%" : "-"}
        valueClass={decided > 0 ? tone(summary.roi) : undefined}
      />
      <Card label="Pending" value={String(pending)} />
    </div>
  );
}
