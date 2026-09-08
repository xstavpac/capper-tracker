// Team-identifier resolution for Charts Custom Metrics - pure, no DB.
// Run with:  npx tsx src/server/data/chart-team-name-acceptance-test.ts
//
// Regression for the bug where a season-snapshot CSV keyed by Baseball
// Savant codes ("AZ", "ATH", "BAL") imported fine but showed "0 teams / No
// value" when charted: the codes were stored verbatim and never matched the
// full names ("Arizona Diamondbacks") the Team Comparison selector queries
// with. normalizeMlbTeamName + chartTeamsMatch are what bridge the two, on
// both the import and the lookup side.
//
// Exits non-zero if any assertion fails.
import { normalizeMlbTeamName, getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { getAllNflTeamNames } from "@/server/data/nfl-team-stats";
import { resolveChartTeamName, chartTeamsMatch, sportLabel } from "@/server/data/chart-team-name";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
function expectTrue(label: string, actual: boolean) {
  expect(label, actual, true);
}

const MLB = "baseball_mlb";
const NFL = "americanfootball_nfl";

// ---------------------------------------------------------------------------
// 1. The exact codes from the bug report
// ---------------------------------------------------------------------------

expect("normalizeMlbTeamName('AZ')", normalizeMlbTeamName("AZ"), "Arizona Diamondbacks");
expect("normalizeMlbTeamName('ATH')", normalizeMlbTeamName("ATH"), "Athletics");
expect("normalizeMlbTeamName('BAL')", normalizeMlbTeamName("BAL"), "Baltimore Orioles");

// Savant vs Baseball-Reference vs Retrosheet spellings all land on one team
for (const [code, name] of [
  ["ARI", "Arizona Diamondbacks"],
  ["OAK", "Athletics"],
  ["CWS", "Chicago White Sox"],
  ["CHW", "Chicago White Sox"],
  ["WSH", "Washington Nationals"],
  ["WSN", "Washington Nationals"],
  ["SD", "San Diego Padres"],
  ["SDP", "San Diego Padres"],
  ["SF", "San Francisco Giants"],
  ["KC", "Kansas City Royals"],
  ["TB", "Tampa Bay Rays"],
  ["NYY", "New York Yankees"],
  ["NYM", "New York Mets"],
  ["CHC", "Chicago Cubs"],
  ["STL", "St. Louis Cardinals"],
  ["SLN", "St. Louis Cardinals"],
] as [string, string][]) {
  expect(`normalizeMlbTeamName('${code}') -> ${name}`, normalizeMlbTeamName(code), name);
}

// every abbreviation resolves to a real entry in the canonical list
const canonical = new Set(getAllMlbTeamNames());
for (const code of ["AZ", "ATH", "BAL", "BOS", "CHC", "CWS", "CIN", "CLE", "COL", "DET", "HOU", "KC", "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY", "PHI", "PIT", "SD", "SEA", "SF", "STL", "TB", "TEX", "TOR", "WSH", "ATL"]) {
  const resolved = normalizeMlbTeamName(code);
  expectTrue(`'${code}' resolves to a canonical MLB name (${resolved})`, resolved !== null && canonical.has(resolved));
}

// ---------------------------------------------------------------------------
// 2. Passthrough + rejection
// ---------------------------------------------------------------------------

expect("full canonical name passes through unchanged", normalizeMlbTeamName("Arizona Diamondbacks"), "Arizona Diamondbacks");
expect("cosmetic fold: lower-case + missing period", normalizeMlbTeamName("st louis cardinals"), "St. Louis Cardinals");
expect("case-insensitive code", normalizeMlbTeamName("az"), "Arizona Diamondbacks");
expect("whitespace trimmed", normalizeMlbTeamName("  BAL  "), "Baltimore Orioles");

// genuinely ambiguous bare codes are refused, not guessed
expect("ambiguous 'LA' -> null (Angels vs Dodgers)", normalizeMlbTeamName("LA"), null);
expect("ambiguous 'NY' -> null", normalizeMlbTeamName("NY"), null);
expect("ambiguous 'CHI' -> null", normalizeMlbTeamName("CHI"), null);
expect("nonsense -> null", normalizeMlbTeamName("Sharks"), null);

// ---------------------------------------------------------------------------
// 3. resolveChartTeamName dispatch + NFL
// ---------------------------------------------------------------------------

expect("resolveChartTeamName MLB code", resolveChartTeamName(MLB, "AZ"), "Arizona Diamondbacks");
expect("resolveChartTeamName NFL code", resolveChartTeamName(NFL, "KC"), "Kansas City Chiefs");
expect("resolveChartTeamName NFL full name passes through", resolveChartTeamName(NFL, "Kansas City Chiefs"), "Kansas City Chiefs");
expect("resolveChartTeamName unknown sport -> null", resolveChartTeamName("icehockey_nhl", "BOS"), null);
expect("resolveChartTeamName blank -> null", resolveChartTeamName(MLB, "   "), null);
expectTrue("every NFL abbr in the selector list resolves", getAllNflTeamNames().every((n) => resolveChartTeamName(NFL, n) === n));

expect("sportLabel mlb", sportLabel(MLB), "MLB");
expect("sportLabel nfl", sportLabel(NFL), "NFL");

// ---------------------------------------------------------------------------
// 4. chartTeamsMatch - the lookup-side bridge (fixes already-imported data)
// ---------------------------------------------------------------------------

// stored short code  vs  selector full name
expectTrue("stored 'AZ' matches selected 'Arizona Diamondbacks'", chartTeamsMatch(MLB, "AZ", "Arizona Diamondbacks"));
expectTrue("stored 'ATH' matches selected 'Athletics'", chartTeamsMatch(MLB, "ATH", "Athletics"));
expectTrue("order doesn't matter", chartTeamsMatch(MLB, "Baltimore Orioles", "BAL"));
expectTrue("two codes for the same team match", chartTeamsMatch(MLB, "OAK", "ATH"));
expectTrue("identical strings match", chartTeamsMatch(MLB, "Arizona Diamondbacks", "Arizona Diamondbacks"));

expect("different teams don't match", chartTeamsMatch(MLB, "AZ", "Baltimore Orioles"), false);
expect("unresolvable stored value doesn't false-match", chartTeamsMatch(MLB, "LA", "Los Angeles Dodgers"), false);
expectTrue("NFL: stored 'SF' matches 'San Francisco 49ers'", chartTeamsMatch(NFL, "SF", "San Francisco 49ers"));

// ---------------------------------------------------------------------------
// 5. End-to-end shape: import stores canonical, lookup finds it
// ---------------------------------------------------------------------------

// what createSnapshotMetric does with a Savant CSV team column:
const csvTeams = ["ATH", "AZ", "BAL"];
const stored = csvTeams.map((t) => resolveChartTeamName(MLB, t));
expect("import canonicalizes the CSV codes", stored, ["Athletics", "Arizona Diamondbacks", "Baltimore Orioles"]);

// what customMetricProvider does when the user picks "Arizona Diamondbacks":
// (works whether the stored rows are canonical OR legacy short codes)
for (const storedRows of [stored as string[], csvTeams]) {
  const hit = storedRows.find((tn) => chartTeamsMatch(MLB, tn, "Arizona Diamondbacks"));
  expectTrue(`lookup finds the Arizona row among ${JSON.stringify(storedRows)}`, hit !== undefined);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
