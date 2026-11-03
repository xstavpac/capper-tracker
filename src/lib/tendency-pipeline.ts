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

import { PICK_GATED_SPORT_KEYS } from "@/lib/final-pick-gate";

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

// Whether one sport takes part in the tendency phase. A pick-gated sport (NCAAB)
// keeps GameResult rows only for games somebody picked, so its tendencies would
// be computed from a sample chosen by what cappers bet on - and each recompute
// re-reads that sport's whole OddsSnapshot history, ~1 MB of posted games a day.
// Neither is worth it, so the phase is off for it whatever the pipeline flag says.
export function tendencyPhaseEnabled(pipelineEnabled: boolean, sportKey: string): boolean {
  return pipelineEnabled && !PICK_GATED_SPORT_KEYS.has(sportKey);
}

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
