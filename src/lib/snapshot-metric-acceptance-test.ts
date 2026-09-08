// Snapshot (season-aggregate) custom metrics - pure assertions, no DB, no DOM.
// Run with:  npx tsx src/lib/snapshot-metric-acceptance-test.ts
//
// Covers the three things the feature has to get right:
//   1. a CSV with no date column routes to Snapshot mode instead of blocking
//   2. a snapshot NEVER shows the "Building historical depth" time-series note
//   3. dated daily metrics / imports are completely unaffected by the change
//
// Exits non-zero if any assertion fails.
import {
  parseCsv,
  detectDateColumn,
  detectTeamColumn,
  detectValueCandidates,
  buildImportRows,
  buildSnapshotRows,
  findDuplicateTeams,
  resolveDuplicateTeams,
} from "@/lib/csv-metric-import";
import { historyNoteState } from "@/lib/history-note-state";
import {
  metricKindOf,
  groupCustomMetrics,
  pickerDisabledReason,
} from "@/lib/custom-metric-picker";
import type { ModelVariableDef } from "@/lib/model-builder";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
function expectTrue(label: string, actual: boolean) {
  expect(label, actual, true);
}

// ---------------------------------------------------------------------------
// 1. No-date CSV -> Snapshot mode, not a blocked daily import
// ---------------------------------------------------------------------------

const SNAPSHOT_CSV = "team,off_rating,def_rating\nYankees,4.21,3.90\nRed Sox,4.05,4.10\nRays,3.88,3.72\n";
const snap = parseCsv(SNAPSHOT_CSV);

expect("no date column is detected in a season-aggregate CSV", detectDateColumn(snap.headers), null);
expect("team column still detected", detectTeamColumn(snap.headers), "team");
expect(
  "both numeric columns are value candidates",
  detectValueCandidates(snap, null, "team"),
  ["off_rating", "def_rating"]
);

// The OLD behavior on this file: every row fails date parsing -> import blocked.
const asDaily = buildImportRows(snap, { dateColumn: "team", teamColumn: null, valueColumns: ["off_rating"] });
expectTrue(
  "forcing this file through the daily importer produces only invalid_date errors (the dead end snapshot mode avoids)",
  asDaily.rows.length === 0 && asDaily.errors.length === 3 && asDaily.errors.every((e) => e.reason === "invalid_date")
);

// The NEW behavior: snapshot builder yields one clean row per team, no dates.
const built = buildSnapshotRows(snap, { teamColumn: "team", valueColumns: ["off_rating", "def_rating"] });
expect("snapshot build has no errors", built.errors, []);
expect("snapshot build yields one row per team", built.rows.map((r) => r.team), ["Yankees", "Red Sox", "Rays"]);
expect("snapshot row carries per-column values", built.rows[0].values, { off_rating: 4.21, def_rating: 3.9 });
expectTrue("snapshot rows have no date field", !("date" in built.rows[0]));

// blank team cell is a real error; blank value cell is allowed (not reported)
const messy = parseCsv("team,rating\n,5.0\nMets,\nMets,6.0\n");
const messyBuilt = buildSnapshotRows(messy, { teamColumn: "team", valueColumns: ["rating"] });
expectTrue("blank team cell -> invalid_value error", messyBuilt.errors.some((e) => e.reason === "invalid_value" && e.column === "team"));
expect("blank value cell is kept as null, not an error", messyBuilt.rows.find((r) => r.team === "Mets" && r.values.rating === null) !== undefined, true);

// snapshot duplicate handling keys on team alone
const dupRows = buildSnapshotRows(parseCsv("team,rating\nA,1\nB,2\nA,3\n"), { teamColumn: "team", valueColumns: ["rating"] }).rows;
expect("duplicate team detected", findDuplicateTeams(dupRows).map((d) => d.team), ["A"]);
expect("resolveDuplicateTeams first keeps earliest", resolveDuplicateTeams(dupRows, "first").map((r) => r.values.rating), [1, 2]);
// "last" keeps each team's latest value but in original file position (same
// stable-order rule as the daily resolveDuplicates).
expect("resolveDuplicateTeams last keeps latest value in original order", resolveDuplicateTeams(dupRows, "last").map((r) => r.values.rating), [2, 3]);

// ---------------------------------------------------------------------------
// 2. A snapshot NEVER shows "Building historical depth"
// ---------------------------------------------------------------------------

// The exact field combo that yields "building" for a daily metric:
expect(
  "daily metric with no data yet -> building",
  historyNoteState({ daysAvailable: 0, totalSnapshotDays: 0 }).kind,
  "building"
);
// Same numbers, but it's a snapshot -> snapshot state, never "building".
expect(
  "snapshot with the same 0/0 numbers -> snapshot state, not building",
  historyNoteState({ metricKind: "snapshot", periodLabel: "2026 Season", daysAvailable: 0, totalSnapshotDays: 0 }),
  { kind: "snapshot", periodLabel: "2026 Season" }
);
// And with real per-team counts it's still "snapshot", not "has-history" / "building".
for (const [d, t] of [[2, 2], [0, 5], [30, 30]] as [number, number][]) {
  expect(
    `snapshot stays "snapshot" for daysAvailable=${d} totalSnapshotDays=${t}`,
    historyNoteState({ metricKind: "snapshot", daysAvailable: d, totalSnapshotDays: t }).kind,
    "snapshot"
  );
}

// ---------------------------------------------------------------------------
// 3. Daily metrics / imports are unaffected
// ---------------------------------------------------------------------------

const DAILY_CSV = "date,team,era\n2026-04-01,Yankees,3.10\n2026-04-02,Yankees,3.05\n4/3/2026,Yankees,2.98\n";
const day = parseCsv(DAILY_CSV);
expect("daily CSV: date column still detected", detectDateColumn(day.headers), "date");
const dailyBuilt = buildImportRows(day, { dateColumn: "date", teamColumn: "team", valueColumns: ["era"] });
expect("daily import unchanged: 3 rows, 0 errors", [dailyBuilt.rows.length, dailyBuilt.errors.length], [3, 0]);
expect("daily import unchanged: M/D/YYYY still normalized", dailyBuilt.rows[2].date, "2026-04-03");

expect("daily history states unchanged: has-history", historyNoteState({ daysAvailable: 7, totalSnapshotDays: 10 }), { kind: "has-history", count: 7 });
// A non-tendency series with rows but no non-null values (an edge that no
// real built-in / custom metric actually hits) is just "building" now - the
// old "insufficient / not enough decided games" wording was tendency-only and
// showed a snapshot-day count mislabeled as a game count; it was removed.
expect("no non-null points but rows exist -> building", historyNoteState({ daysAvailable: 0, totalSnapshotDays: 4 }), { kind: "building" });

// metricKind helper: undefined (every built-in, every legacy metric) == daily
expect("metricKindOf undefined -> daily", metricKindOf({}), "daily");
expect("metricKindOf explicit daily -> daily", metricKindOf({ metricKind: "daily" }), "daily");
expect("metricKindOf snapshot -> snapshot", metricKindOf({ metricKind: "snapshot" }), "snapshot");

// ---------------------------------------------------------------------------
// 4. Variable-picker grouping + eligibility rules
// ---------------------------------------------------------------------------

function customMetric(id: string, kind: "daily" | "snapshot"): ModelVariableDef {
  return {
    id,
    label: id,
    category: "custom_metric",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "",
    sourceId: "user_upload",
    dataScope: "per_user",
    metricKind: kind,
  };
}
const builtIn: ModelVariableDef = {
  id: "team_era",
  label: "Team ERA",
  category: "team_stats",
  sport: "baseball_mlb",
  scope: "team",
  unit: "decimal",
  description: "",
  sourceId: "mlb_team_stats_api",
  dataScope: "global",
};

const dailyM = customMetric("cm_daily", "daily");
const snapM = customMetric("cm_snap", "snapshot");
const snapM2 = customMetric("cm_snap2", "snapshot");

const groups = groupCustomMetrics([dailyM, snapM, snapM2]);
expect("groupCustomMetrics splits by kind", [groups.daily.map((v) => v.id), groups.snapshot.map((v) => v.id)], [["cm_daily"], ["cm_snap", "cm_snap2"]]);

// built-in in a normal daily context -> never disabled (built-ins unaffected)
expect(
  "built-in daily variable is never disabled",
  pickerDisabledReason(builtIn, { mode: "single", plottedKinds: [], plottedVariableIds: [] }),
  null
);
expect(
  "built-in daily variable not disabled in compare either",
  pickerDisabledReason(builtIn, { mode: "compare", plottedKinds: ["daily"], plottedVariableIds: ["x"] }),
  null
);

// single (Team Stats) mode: snapshots can't be plotted at all
expectTrue(
  "snapshot disabled in single mode",
  pickerDisabledReason(snapM, { mode: "single", plottedKinds: [], plottedVariableIds: [] }) !== null
);
expect(
  "daily custom metric fine in single mode",
  pickerDisabledReason(dailyM, { mode: "single", plottedKinds: [], plottedVariableIds: [] }),
  null
);

// compare mode: the two kinds are mutually exclusive on one chart
expectTrue(
  "snapshot disabled while a daily is plotted (compare)",
  pickerDisabledReason(snapM, { mode: "compare", plottedKinds: ["daily"], plottedVariableIds: ["cm_daily"] }) !== null
);
expectTrue(
  "daily disabled while a snapshot is plotted (compare)",
  pickerDisabledReason(builtIn, { mode: "compare", plottedKinds: ["snapshot"], plottedVariableIds: ["cm_snap"] }) !== null
);
// several snapshots CAN be compared together (small multiples) - a second
// one is NOT disabled while one is already plotted
expect(
  "a second snapshot is allowed while one is plotted (compare)",
  pickerDisabledReason(snapM2, { mode: "compare", plottedKinds: ["snapshot"], plottedVariableIds: ["cm_snap"] }),
  null
);
expect(
  "a third snapshot is still allowed with two plotted",
  pickerDisabledReason(customMetric("cm_snap3", "snapshot"), {
    mode: "compare",
    plottedKinds: ["snapshot", "snapshot"],
    plottedVariableIds: ["cm_snap", "cm_snap2"],
  }),
  null
);
// the snapshot that IS plotted stays clickable (so it can be removed)
expect(
  "the plotted snapshot itself is not disabled",
  pickerDisabledReason(snapM, { mode: "compare", plottedKinds: ["snapshot"], plottedVariableIds: ["cm_snap"] }),
  null
);
// nothing plotted yet -> everything allowed in compare
expect(
  "snapshot allowed in compare when nothing plotted",
  pickerDisabledReason(snapM, { mode: "compare", plottedKinds: [], plottedVariableIds: [] }),
  null
);

// disabled result carries an always-visible short badge + a full hover tooltip
const singleModeDisabled = pickerDisabledReason(snapM, { mode: "single", plottedKinds: [], plottedVariableIds: [] });
expect("single-mode snapshot badge is the short inline label", singleModeDisabled?.badge, "Team Comparison only");
expectTrue("single-mode snapshot tooltip is a fuller sentence", (singleModeDisabled?.tooltip.length ?? 0) > (singleModeDisabled?.badge.length ?? 0));
expect(
  "compare-mode daily-blocked-by-snapshot badge",
  pickerDisabledReason(builtIn, { mode: "compare", plottedKinds: ["snapshot"], plottedVariableIds: ["cm_snap"] })?.badge,
  "Snapshot active"
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
