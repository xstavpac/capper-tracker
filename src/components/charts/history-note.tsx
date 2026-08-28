import type { VariableTimeSeriesResult } from "@/server/data/historical-variables";

// "How much history backs this series" messaging - shared by ChartsWorkspace
// (single-team) and TeamComparisonWorkspace (two-team) so both tools report
// data availability identically rather than each inventing its own wording.
// Not just cosmetic: daysAvailable vs. totalSnapshotDays tells "no snapshots
// collected yet at all" apart from "snapshots exist but not enough decided
// games to compute this reliably yet" - see VariableTimeSeriesResult's own
// field comments in historical-variables.ts.
export function HistoryNote({ result }: { result: VariableTimeSeriesResult }) {
  if (result.daysAvailable > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {result.daysAvailable} day{result.daysAvailable === 1 ? "" : "s"} of history
      </span>
    );
  }
  if (result.totalSnapshotDays === 0) {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        Building historical depth — daily snapshots are collected automatically, more history will appear here each day.
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {result.totalSnapshotDays} day{result.totalSnapshotDays === 1 ? "" : "s"} of snapshots collected so far, but not yet
      enough decided games to calculate this reliably.
    </span>
  );
}
