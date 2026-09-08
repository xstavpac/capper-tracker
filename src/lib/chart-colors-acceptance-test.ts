// The Team Comparison encoding contract (lib/chart-colors.ts): a metric is a
// stable colour, a team is a line style, and the two channels never interfere.
//
// Pure - run with:  npx tsx src/lib/chart-colors-acceptance-test.ts
import { CHART_SERIES_PALETTE, metricColor, TEAM_LINE_DASH, TEAM_B_DASH } from "@/lib/chart-colors";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function expectTrue(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
}

// ---- palette ----
expect("palette is the 8 documented hues", [...CHART_SERIES_PALETTE], [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d",
]);
expectTrue("every palette entry is a 6-digit hex", CHART_SERIES_PALETTE.every((h) => /^#[0-9a-f]{6}$/.test(h)));

// ---- the four pinned metrics, both sports, same colour ----
const PINNED: Record<string, string> = {
  tendency_fav_win_pct: "#2563eb", // blue
  tendency_dog_win_pct: "#db2777", // pink
  tendency_over_rate: "#d97706", // amber
  tendency_under_rate: "#16a34a", // green
};
for (const [id, hex] of Object.entries(PINNED)) {
  expect(`${id} -> ${hex}`, metricColor(id), hex);
  expect(`nfl_${id} -> same hue as MLB`, metricColor(`nfl_${id}`), hex);
}
expectTrue(
  "the four pinned metrics are four distinct hues",
  new Set(Object.keys(PINNED).map(metricColor)).size === 4
);

// ---- unpinned metrics: deterministic, and never a pinned hue ----
const reserved = new Set(Object.values(PINNED));
const unpinned = ["team_era", "team_win_pct", "team_run_differential", "team_ops", "cmXYZ_custom", "team_bullpen_era"];
for (const id of unpinned) {
  expect(`${id} is deterministic across calls`, metricColor(id), metricColor(id));
  expectTrue(`${id} never collides with a pinned metric's hue`, !reserved.has(metricColor(id)));
  expectTrue(`${id} is drawn from the shared palette`, (CHART_SERIES_PALETTE as readonly string[]).includes(metricColor(id)));
}

// Removing a metric from a plot must not repaint the others: metricColor
// depends only on the id, never on call order or what else exists.
expect(
  "order independence: team_era's colour is the same before and after other lookups",
  (() => { const first = metricColor("team_era"); metricColor("team_ops"); metricColor("tendency_over_rate"); return metricColor("team_era") === first; })(),
  true
);

// ---- team channel: solid A, real dash B, nothing else ----
expect("Team A line is solid (no dash array)", TEAM_LINE_DASH.A, undefined);
expect("Team B line is a real dash", TEAM_LINE_DASH.B, "6 4");
expect("TEAM_B_DASH matches the map", TEAM_LINE_DASH.B, TEAM_B_DASH);
expectTrue("only two team styles exist", Object.keys(TEAM_LINE_DASH).length === 2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
