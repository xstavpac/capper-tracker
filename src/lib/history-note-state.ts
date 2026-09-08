// Pure decision for the data-availability note shown under a plotted Charts
// variable (rendered by components/charts/history-note.tsx). Split out from
// the component so the branching - especially "a snapshot metric must NEVER
// be told it's 'building historical depth'" - is unit-testable without a DOM.
//
// No prisma, no React: takes just the fields it reads off a
// VariableTimeSeriesResult.

export type TendencySampleInput = {
  phrase: string;
  wins: number;
  losses: number;
  pushes: number;
  games: number;
  pct: number | null;
};

export type HistoryNoteState =
  | { kind: "snapshot"; periodLabel?: string }
  | { kind: "has-history"; count: number }
  | { kind: "building" }
  // A team-tendency variable, always shown at its real sample size: the
  // rounded rate next to its actual record and game count. `label` is the
  // finished string, e.g. "50% (6-6) as underdog · 12 games".
  | { kind: "tendency"; label: string }
  // A tendency variable whose split has zero games in range (nothing to show
  // a rate for). Reports the real absence, not a snapshot-day count.
  | { kind: "tendency-empty"; phrase: string };

// "6-6", or "6-6-1" when there are pushes - matches the capper record-card
// record format (game-card-record-line.ts).
export function formatTendencyRecord(wins: number, losses: number, pushes: number): string {
  return pushes > 0 ? `${wins}-${losses}-${pushes}` : `${wins}-${losses}`;
}

function tendencyNoteState(s: TendencySampleInput): HistoryNoteState {
  if (s.games <= 0 || s.pct === null) return { kind: "tendency-empty", phrase: s.phrase };
  const pct = Math.round(s.pct * 100);
  const record = formatTendencyRecord(s.wins, s.losses, s.pushes);
  const games = `${s.games} game${s.games === 1 ? "" : "s"}`;
  return { kind: "tendency", label: `${pct}% (${record}) ${s.phrase} · ${games}` };
}

export function historyNoteState(input: {
  metricKind?: "daily" | "snapshot";
  periodLabel?: string;
  daysAvailable: number;
  totalSnapshotDays: number;
  tendencySample?: TendencySampleInput;
}): HistoryNoteState {
  // A season snapshot is not a timeline - it is never "building" toward more
  // history. This branch comes first and unconditionally, so no combination
  // of daysAvailable / totalSnapshotDays can route a snapshot into the
  // time-series wording.
  if (input.metricKind === "snapshot") {
    return { kind: "snapshot", periodLabel: input.periodLabel };
  }

  // A team-tendency variable: show the real rate + record + count. Only the
  // "no snapshots collected at all yet" case (totalSnapshotDays 0) still falls
  // through to "building" below - once any snapshot row exists there is always
  // either a real rate or an honest "no games in this role" to report.
  if (input.tendencySample && input.totalSnapshotDays > 0) {
    return tendencyNoteState(input.tendencySample);
  }

  if (input.daysAvailable > 0) return { kind: "has-history", count: input.daysAvailable };
  return { kind: "building" };
}
