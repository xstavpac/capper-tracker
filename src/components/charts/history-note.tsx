import type { VariableTimeSeriesResult } from "@/server/data/historical-variables";
import { historyNoteState } from "@/lib/history-note-state";

// "How much history backs this series" messaging - shared by ChartsWorkspace
// (single-team) and TeamComparisonWorkspace (two-team) so both tools report
// data availability identically rather than each inventing its own wording.
// Not just cosmetic: daysAvailable vs. totalSnapshotDays tells "no data
// collected yet at all" apart from "data exists but not enough decided games
// to compute this reliably yet" - see VariableTimeSeriesResult's own field
// comments in historical-variables.ts. The branching itself lives in
// lib/history-note-state.ts so it can be tested without a DOM.
//
// The MLB snapshot tables accumulate one row per calendar day; the NFL
// table one row per game. `sport` just swaps the noun ("day" vs "game") so
// the wording is accurate for both - the branching logic is identical.
//
// A season-snapshot custom metric is not a time series at all: it gets its
// own "N teams · <period>" line and is structurally prevented (see
// historyNoteState) from ever showing "Building historical depth".
export function HistoryNote({ result, sport }: { result: VariableTimeSeriesResult; sport: string }) {
  const noun = sport === "americanfootball_nfl" ? "game" : "day";
  const plural = (n: number) => noun + (n === 1 ? "" : "s");

  const state = historyNoteState(result);

  if (state.kind === "snapshot") {
    return (
      <span className="text-xs text-muted-foreground">
        {result.daysAvailable} {result.daysAvailable === 1 ? "team" : "teams"}
        {state.periodLabel ? ` · ${state.periodLabel}` : ""}
      </span>
    );
  }

  if (state.kind === "has-history") {
    return (
      <span className="text-xs text-muted-foreground">
        {state.count} {plural(state.count)} of history
      </span>
    );
  }
  if (state.kind === "building") {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        Building historical depth — a new point is added after each {noun}.
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {state.count} {plural(state.count)} of data so far, but not yet enough decided games to calculate this reliably.
    </span>
  );
}
