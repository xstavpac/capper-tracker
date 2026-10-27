// One switch for the nightly team-tendency pipeline in the refresh-scores cron:
// recomputeTeamTendencies + snapshotTeamTendencies (all sports) AND the MLB
// Decay Delta sync (syncDecayDeltaPredictions), which reads the tendency
// snapshots those steps write. They are paused together on purpose: with the
// snapshots frozen, Decay Delta would keep persisting predictions from stale
// rates. Nothing is deleted - tables, data, code and tests all stay.
//
// OFF unless TENDENCY_PIPELINE_ENABLED is exactly "true".
//
// To turn it back on (e.g. before the next MLB season): set
// TENDENCY_PIPELINE_ENABLED=true in the Vercel production env and redeploy.
// Days that ran while paused are NOT backfilled: the tendency snapshot series
// has a gap, and no Decay Delta rows are written for those days.

export const TENDENCY_PIPELINE_ENV = "TENDENCY_PIPELINE_ENABLED";

export const TENDENCY_PIPELINE_SKIPPED_STEPS = ["recomputeTeamTendencies", "snapshotTeamTendencies", "syncDecayDeltaPredictions"] as const;

export function isTendencyPipelineEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TENDENCY_PIPELINE_ENV] === "true";
}

// The one log line a paused run emits (queryable by tag in runtime logs).
export function tendencyPipelineSkippedLog(): string {
  return JSON.stringify({
    tag: "refresh-scores-tendency-pipeline-skipped",
    reason: `${TENDENCY_PIPELINE_ENV} is not "true"`,
    skipped: TENDENCY_PIPELINE_SKIPPED_STEPS,
  });
}

// Runs one sport's tendency recompute then snapshot when enabled; when paused
// calls neither. `timed` is the cron's timing wrapper, passed in so this stays
// free of the data layer.
export type TendencyPhase<T> = { tendencies: T | null; tendencySnapshots: number; tendencyMs: number; snapshotMs: number };

export async function runTendencyPhase<T, S extends number>(
  enabled: boolean,
  recompute: () => Promise<T>,
  snapshot: () => Promise<S>,
  timed: <V>(fn: () => Promise<V>) => Promise<[V, number]>
): Promise<TendencyPhase<T>> {
  if (!enabled) return { tendencies: null, tendencySnapshots: 0, tendencyMs: 0, snapshotMs: 0 };
  const [tendencies, tendencyMs] = await timed(recompute);
  const [tendencySnapshots, snapshotMs] = await timed(snapshot);
  return { tendencies, tendencySnapshots, tendencyMs, snapshotMs };
}

// The Zone Model page's muted banner while paused.
export function tendencyPausedNote(lastSnapshotDate: string | null): string {
  return lastSnapshotDate ? `Data paused (last updated ${lastSnapshotDate})` : "Data paused";
}
