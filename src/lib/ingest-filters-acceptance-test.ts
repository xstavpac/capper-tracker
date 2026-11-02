// Telegram ingest filters (lib/ingest-filters.ts): combined-bet detection and the league allowlist.
// Pure, no database. Run with: npx tsx src/lib/ingest-filters-acceptance-test.ts
import {
  isCombinedBetLine,
  dropCombinedBetLines,
  parseAllowedLeagues,
  filterPicksByLeague,
  narrowAmbiguousByLeague,
  DEFAULT_INGEST_ALLOWED_LEAGUES,
} from "@/lib/ingest-filters";
import { parseCatalog, type ParsedPick } from "@/lib/parse-catalog";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

// ---- combined: must be skipped ----
for (const line of [
  "Bears + Cubs MLP",
  "Bears / Cubs / Lions",
  "Bears/Cubs",
  "Bears ML & Cubs ML",
  "Bears ML + Cubs ML",
  "Bears ML and Cubs ML",
  "Bears -3 + Cubs -1.5",
  "Lions parlay",
  "Lions ML parly",
  "2-team Lions Bears",
  "3 team teaser Lions",
]) {
  expect(`combined: ${line}`, isCombinedBetLine(line), true);
}

// ---- single bets: must NOT be skipped ("+" is a line or odds sign) ----
for (const line of [
  "Cubs +1.5",
  "Cubs ML +120",
  "Bears +3 -110",
  "Over 8.5 +105",
  "Cubs +1.5 -120",
  "Bears ML",
  "Chiefs -3.5",
  "Over 44.5 Lions/Bears", // a total on a matchup: "/" is the game, not two bets
  "Lions/Bears o47",
  "Under 8.5 (Cubs/Cardinals)",
]) {
  expect(`single: ${line}`, isCombinedBetLine(line), false);
}

// ---- headers are never combined ----
for (const header of ["Sharp & Co", "Fade and Win", "Big Dave / Dave's Picks", "Parity Pete"]) {
  expect(`header kept: ${header}`, isCombinedBetLine(header), false);
}

// ---- dropCombinedBetLines: capper is the block's first line, blank lines survive ----
{
  const text = ["Alpha", "Bears ML", "Bears + Cubs MLP", "Cubs +1.5", "", "Beta", "Bears / Cubs / Lions", "Over 8.5 +105"].join("\n");
  const r = dropCombinedBetLines(text);
  expect("drop: kept text", r.text, ["Alpha", "Bears ML", "Cubs +1.5", "", "Beta", "Over 8.5 +105"].join("\n"));
  expect(
    "drop: skipped entries",
    r.skipped.map((s) => [s.stage, s.capperName, s.rawText]),
    [
      ["COMBINED_BET", "Alpha", "Bears + Cubs MLP"],
      ["COMBINED_BET", "Beta", "Bears / Cubs / Lions"],
    ]
  );
}

// ---- allowlist parsing ----
expect("default allowlist excludes NCAAB", DEFAULT_INGEST_ALLOWED_LEAGUES.split(",").includes("NCAAB"), false);
expect("unset -> default set", [...parseAllowedLeagues(undefined)].sort(), ["MLB", "NBA", "NCAAF", "NFL", "NHL", "WNBA"]);
expect("blank -> default set", parseAllowedLeagues("  ").size, 6);
expect("custom list, trimmed and upper-cased", [...parseAllowedLeagues(" nba , nfl ")].sort(), ["NBA", "NFL"]);

// ---- league filter on real parsed picks ----
{
  const allowed = parseAllowedLeagues(undefined);
  const parsed = parseCatalog(["Gamma", "Lakers ML", "Chiefs ML", "Doosan Bears ML"].join("\n"), []);
  const f = filterPicksByLeague(allowed, parsed.picks.filter((p) => !p.ambiguous));
  expect("league: NBA and NFL kept", f.keep.map((p) => p.sportName).sort(), ["NBA", "NFL"]);
  expect("league: the rest skipped as LEAGUE_NOT_ALLOWED", f.skipped.every((s) => s.stage === "LEAGUE_NOT_ALLOWED"), true);
}
{
  const allowed = parseAllowedLeagues("NBA,NFL");
  const fake = { capperName: "X", sportName: "KBO", raw: "Doosan ML" } as ParsedPick;
  const f = filterPicksByLeague(allowed, [fake]);
  expect("league: KBO skipped with the sport recorded", [f.keep.length, f.skipped[0]?.stage, f.skipped[0]?.guessedSport], [0, "LEAGUE_NOT_ALLOWED", "KBO"]);
  const none = filterPicksByLeague(allowed, [{ ...fake, sportName: "" } as ParsedPick]);
  expect("league: no league read -> skipped", none.skipped.length, 1);
}

// ---- ambiguity preference: allowed league wins ----
{
  const parsed = parseCatalog(["Delta", "Bears ML"].join("\n"), []);
  const bears = parsed.picks.find((p) => p.ambiguous);
  expect("bears is ambiguous in the parser", Boolean(bears), true);
  if (bears) {
    const sports = (bears.ambiguous ?? []).map((o) => o.sport);
    const allowedOnlyNfl = parseAllowedLeagues("NFL");
    const r = narrowAmbiguousByLeague(allowedOnlyNfl, [bears]);
    expect(`bears options (${sports.join("/")}) -> NFL only resolves silently`, [r.keep.length, r.keep[0]?.sportName, r.keep[0]?.ambiguous], [1, "NFL", undefined]);
    const none = narrowAmbiguousByLeague(parseAllowedLeagues("NBA"), [bears]);
    expect("no candidate allowed -> LEAGUE_NOT_ALLOWED", [none.keep.length, none.skipped[0]?.stage], [0, "LEAGUE_NOT_ALLOWED"]);
    const all = narrowAmbiguousByLeague(parseAllowedLeagues(sports.join(",")), [bears]);
    expect("all candidates allowed -> untouched, still a question", [all.keep.length, all.keep[0]?.ambiguous?.length], [1, sports.length]);
  }
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
