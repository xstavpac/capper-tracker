import type { VariableTimeSeriesResult } from "@/server/data/historical-variables";

// "How much history backs this series" messaging - shared by ChartsWorkspace
// (single-team) and TeamComparisonWorkspace (two-team) so both tools report
// data availability identically rather than each inventing its own wording.
// Not just cosmetic: daysAvailable vs. totalSnapshotDays tells "no data
// collected yet at all" apart from "data exists but not enough decided games
// to compute this reliably yet" - see VariableTimeSeriesResult's own field
// comments in historical-variables.ts.
//
// The MLB snapshot tables accumulate one row per calendar day; the NFL
// table one row per game. `sport` just swaps the noun ("day" vs "game") so
// the wording is accurate for both - the branching logic is identical.
export function HistoryNote({ result, sport }: { result: VariableTimeSeriesResult; sport: string }) {
  const noun = sport === "americanfootball_nfl" ? "game" : "day";
  const plural = (n: number) => noun + (n === 1 ? "" : "s");

  if (result.daysAvailable > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {result.daysAvailable} {plural(result.daysAvailable)} of history
      </span>
    );
  }
  if (result.totalSnapshotDays === 0) {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        Building historical depth — a new point is added after each {noun}.
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {result.totalSnapshotDays} {plural(result.totalSnapshotDays)} of data so far, but not yet enough decided games to
      calculate this reliably.
    </span>
  );
}
