// TENDENCY_PIPELINE_ENABLED: one flag pauses the tendency recompute, the
// tendency snapshot and the MLB Decay Delta sync in the refresh-scores cron,
// and nothing else in it. Pure, no DB. Run with:
//   npx tsx src/lib/tendency-pipeline-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTendencyPipelineEnabled,
  runTendencyPhase,
  tendencyPausedNote,
  tendencyPipelineSkippedLog,
  TENDENCY_PIPELINE_SKIPPED_STEPS,
} from "@/lib/tendency-pipeline";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

// ---- 1. Off by default; only the exact string "true" turns it on ----
{
  expect("unset -> paused", isTendencyPipelineEnabled({}), false);
  expect("'true' -> enabled", isTendencyPipelineEnabled({ TENDENCY_PIPELINE_ENABLED: "true" }), true);
  expect("'1' / 'TRUE' / '' -> paused", ["1", "TRUE", "", "false"].map((v) => isTendencyPipelineEnabled({ TENDENCY_PIPELINE_ENABLED: v })), [false, false, false, false]);
}

// ---- 2. The phase runs both steps when enabled, neither when paused ----
async function main() {
  const timed = async <V>(fn: () => Promise<V>): Promise<[V, number]> => [await fn(), 7];
  const calls: string[] = [];
  const recompute = async () => (calls.push("recompute"), { teamsUpdated: 30 });
  const snapshot = async () => (calls.push("snapshot"), 30);

  const on = await runTendencyPhase(true, recompute, snapshot, timed);
  expect("enabled: recompute then snapshot, in order", calls, ["recompute", "snapshot"]);
  expect("enabled: results and timings pass through", on, { tendencies: { teamsUpdated: 30 }, tendencySnapshots: 30, tendencyMs: 7, snapshotMs: 7 });

  calls.length = 0;
  const off = await runTendencyPhase(false, recompute, snapshot, timed);
  expect("paused: neither step is called", calls, []);
  expect("paused: empty result, zero timings", off, { tendencies: null, tendencySnapshots: 0, tendencyMs: 0, snapshotMs: 0 });

  // ---- 3. Log line and Zone Model note ----
  const log = JSON.parse(tendencyPipelineSkippedLog());
  expect("skip log: tagged, names the flag and all three skipped steps", [log.tag, /TENDENCY_PIPELINE_ENABLED/.test(log.reason), log.skipped], [
    "refresh-scores-tendency-pipeline-skipped",
    true,
    ["recomputeTeamTendencies", "snapshotTeamTendencies", "syncDecayDeltaPredictions"],
  ]);
  expect("skipped steps list is exactly those three", [...TENDENCY_PIPELINE_SKIPPED_STEPS].length, 3);
  expect("note with a date", tendencyPausedNote("2026-10-26"), "Data paused (last updated 2026-10-26)");
  expect("note with no snapshots", tendencyPausedNote(null), "Data paused");

  // ---- 4. Wiring in the cron route: only the three steps are gated ----
  const route = src("src/app/api/cron/refresh-scores/route.ts");
  expect("route: flag read once per run, skip line logged when off", [/const pipelineEnabled = isTendencyPipelineEnabled\(\);/.test(route), /if \(!pipelineEnabled\) console\.log\(tendencyPipelineSkippedLog\(\)\);/.test(route)], [true, true]);
  expect("route: Decay Delta sync gated on the flag", /pipelineEnabled \? await syncDecayDeltaPredictions\(MLB_SPORT_KEY\) : null/.test(route), true);
  expect("route: tendency steps only run through runTendencyPhase", [/runTendencyPhase\(\s*pipelineEnabled,/.test(route), /await timed\(\(\) => (recompute|snapshot)TeamTendencies/.test(route)], [true, false]);
  const ungated = [
    "persistFinalScores(sportKey, gameResultChanges)",
    "await captureTeamStatSnapshots()",
    "await capturePitcherStatSnapshots()",
    "await reconcileGameStarters(MLB_SPORT_KEY)",
    "await captureNflTeamStatSnapshots()",
    "await captureTeamRecordSnapshots(NFL_SPORT_KEY)",
    "await captureSituationalRateSnapshots()",
  ];
  expect("route: final scores and every other step stay unconditional", ungated.map((s) => route.includes(s) && !new RegExp(`pipelineEnabled[^\n]*${s.replace(/[()]/g, "\$&")}`).test(route)), ungated.map(() => true));
  expect("route: response reports pipeline state", /tendencyPipeline: pipelineEnabled \? "enabled" : "paused"/.test(route), true);

  // ---- 5. Zone Model page / view ----
  const page = src("src/app/(app)/zone-model/page.tsx");
  expect("zone page: note only while paused, from the latest snapshot date", [/const paused = !isTendencyPipelineEnabled\(\);/.test(page), /paused \? getLatestTendencySnapshotDate\(MLB_SPORT_KEY\)/.test(page), /pausedNote=\{paused \? tendencyPausedNote\(lastSnapshotDate\) : null\}/.test(page)], [true, true, true]);
  expect("zone view: muted note rendered when set", /\{pausedNote && <p className="mt-1 text-xs text-muted-foreground">\{pausedNote\}<\/p>\}/.test(src("src/components/zone-model/zone-model-view.tsx")), true);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nTendency pipeline flag checks passed.");
}
main();
