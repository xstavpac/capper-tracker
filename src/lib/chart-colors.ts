// The app's categorical chart palette and the Team Comparison encoding rules.
// Pure (no React, no prisma) so the "which colour, which line style" decisions
// are unit-testable without a DOM - same client-safety convention as
// lib/custom-metric-picker.ts and lib/snapshot-chart.ts.
//
// Encoding, shared by the Team Comparison Overlay chart AND its Split panels:
//   - METRIC  -> colour  (metricColor below - the same metric is the same
//                colour in both views, and keeps that colour no matter what
//                else is plotted; colour follows the metric, never its
//                position in the list)
//   - TEAM    -> line style  (TEAM_LINE_DASH - solid for A, real dashes for B)
// Keeping the two channels orthogonal is the point: a reader never has to work
// out "which blue line is Team A" when solid-vs-dashed answers that instantly,
// and never has to tell metrics apart by dash pattern when distinct hues do it.

// Eight distinguishable hues (Tailwind ~600 steps), the palette this app has
// used for categorical chart series since the single-team Charts view shipped.
// Assign in order; nothing in this app plots more than a handful of series at
// once, so the "9th series folds into Other" cap never bites here.
export const CHART_SERIES_PALETTE = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
] as const;

// The four team-tendency metrics the comparison tool is built around, each
// pinned to a hue from the palette above. Blue / pink / amber / green are
// mutually distinct for normal vision (worst pair ΔE ~20) and clear the
// dataviz method's adjacent-pair CVD gate in this order; the one 6-8 "floor
// band" pair (amber vs green under protanopia) is covered by the secondary
// encoding this view always carries - the per-team line style, the legend, and
// the named swatches in the Plotted-variables panel. NFL's equivalents reuse
// the mapping so a metric is one colour across both sports.
const METRIC_COLOR: Record<string, string> = {
  tendency_fav_win_pct: "#2563eb", // blue
  nfl_tendency_fav_win_pct: "#2563eb",
  tendency_dog_win_pct: "#db2777", // pink
  nfl_tendency_dog_win_pct: "#db2777",
  tendency_over_rate: "#d97706", // amber
  nfl_tendency_over_rate: "#d97706",
  tendency_under_rate: "#16a34a", // green
  nfl_tendency_under_rate: "#16a34a",
};

// Hues left for metrics with no pinned slot (a team stat, a custom metric):
// the palette minus the four reserved above, so a fallback colour can never
// collide with a tendency metric's colour (which would put four same-coloured
// lines on one Overlay chart).
const FALLBACK_HUES = CHART_SERIES_PALETTE.filter((hex) => !Object.values(METRIC_COLOR).includes(hex));

// A stable, order-independent colour for one metric. Pinned metrics get their
// fixed hue; anything else gets a deterministic hash into FALLBACK_HUES, so
// adding or removing another metric never repaints this one. Two unpinned
// metrics can still collide onto one hue - rare, and the Plotted-variables
// panel names every series - but a pinned metric never does.
export function metricColor(variableId: string): string {
  const pinned = METRIC_COLOR[variableId];
  if (pinned) return pinned;
  let hash = 0;
  for (let i = 0; i < variableId.length; i++) {
    hash = (hash * 31 + variableId.charCodeAt(i)) | 0;
  }
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length];
}

// Team Comparison line style: Team A solid, Team B a real dash ("6 4" = 6px on,
// 4px off, a Recharts strokeDasharray). Real dashes, not dots - dots disappear
// at small sizes and when a dense chart is zoomed. Deliberately only these two
// states: there are only ever two teams, so dotted / dash-dot / long-dash would
// be noise for no gain.
export const TEAM_B_DASH = "6 4";
export const TEAM_LINE_DASH: Record<"A" | "B", string | undefined> = {
  A: undefined,
  B: TEAM_B_DASH,
};
