import type { VariableTimeSeriesResult } from "@/server/data/historical-variables";
import { historyNoteState } from "@/lib/history-note-state";

// "How much history backs this series" messaging - shared by ChartsWorkspace
// (single-team) and TeamComparisonWorkspace (two-team) so both tools report
// data availability identically rather than each inventing its own wording.
// For a team-tendency variable the note shows the real rate next to its
// actual record and game count ("50% (6-6) as underdog · 12 games") - there
// is no minimum-sample suppression; the game count itself is the reliability
// disclosure. For every other variable it reports how many points of history
// exist, or that the series is still building. The branching itself lives in
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
  // A team-tendency rate is always shown at its real sample size, with the
  // actual record and game count as the honest reliability disclosure - no
  // sample-size floor, no "not enough data" suppression.
  if (state.kind === "tendency") {
    return <span className="text-xs text-muted-foreground">{state.label}</span>;
  }
  if (state.kind === "tendency-empty") {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        No games {state.phrase} in the selected range.
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      Building historical depth — a new point is added after each {noun}.
    </span>
  );
}
