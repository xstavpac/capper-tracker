// Pure decision for the data-availability note shown under a plotted Charts
// variable (rendered by components/charts/history-note.tsx). Split out from
// the component so the branching - especially "a snapshot metric must NEVER
// be told it's 'building historical depth'" - is unit-testable without a DOM.
//
// No prisma, no React: takes just the four fields it reads off a
// VariableTimeSeriesResult.

export type HistoryNoteState =
  | { kind: "snapshot"; periodLabel?: string }
  | { kind: "has-history"; count: number }
  | { kind: "building" }
  | { kind: "insufficient"; count: number };

export function historyNoteState(input: {
  metricKind?: "daily" | "snapshot";
  periodLabel?: string;
  daysAvailable: number;
  totalSnapshotDays: number;
}): HistoryNoteState {
  // A season snapshot is not a timeline - it is never "building" toward more
  // history, and never "not enough decided games yet". This branch comes
  // first and unconditionally, so no combination of daysAvailable /
  // totalSnapshotDays can route a snapshot into the time-series wording.
  if (input.metricKind === "snapshot") {
    return { kind: "snapshot", periodLabel: input.periodLabel };
  }

  if (input.daysAvailable > 0) return { kind: "has-history", count: input.daysAvailable };
  if (input.totalSnapshotDays === 0) return { kind: "building" };
  return { kind: "insufficient", count: input.totalSnapshotDays };
}
