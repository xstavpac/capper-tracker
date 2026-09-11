// Proof for nfl-live-game-state.ts's normalizers - locks the ESPN response
// shapes (captured live against a real in-progress NFL Week 1 game, SF @
// LAR, ESPN event 401872657, during this build's verification step - see
// the PR description for the raw samples) down to the normalized fields
// nfl-momentum.ts's factors actually read, and confirms malformed/partial
// entries are dropped rather than crashing the poller.
// Run: npx tsx src/server/data/nfl-live-game-state-acceptance-test.ts
import { normalizeWpPoint, normalizeDrive, normalizeBoxscore, normalizeSituation } from "./nfl-live-game-state";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- normalizeWpPoint ----
// Real entry from the summary endpoint's winprobability[] array, captured
// live: {"homeWinPercentage":0.6047,"tiePercentage":0,"playId":"4018726571"}.
// Confirms the field is `homeWinPercentage` (0..1 fraction), NOT MLB's
// `homeTeamWinProbability` (0..100) - the exact trap this build was told to
// verify against, not assume.
{
  const real = { homeWinPercentage: 0.6047, tiePercentage: 0, playId: "4018726571" };
  const point = normalizeWpPoint(real);
  check("a real winprobability entry normalizes successfully", point !== null);
  check("homeWinPercentage passes through as the 0..1 fraction ESPN sends", point?.homeWinPercentage === 0.6047);
  check("tiePercentage passes through", point?.tiePercentage === 0);
  check("playId is captured as a string", point?.playId === "4018726571");

  // Missing WP data - the one field every real entry has.
  check("an entry missing homeWinPercentage is dropped (returns null)", normalizeWpPoint({ tiePercentage: 0 }) === null);
  check("null/undefined input is dropped, not thrown", normalizeWpPoint(null) === null && normalizeWpPoint(undefined) === null);

  // Malformed: wrong type for a field that IS present.
  check(
    "a homeWinPercentage sent as a string (malformed) is dropped, not coerced",
    normalizeWpPoint({ homeWinPercentage: "0.60", tiePercentage: 0 }) === null
  );

  // tiePercentage missing (NFL, unlike MLB, allows ties, but a malformed/old
  // response omitting it should default to 0, not drop the whole point -
  // the win-probability figure is still usable).
  const noTie = normalizeWpPoint({ homeWinPercentage: 0.5, playId: "x" });
  check("a missing tiePercentage defaults to 0 rather than dropping the point", noTie?.tiePercentage === 0);
}

// ---- normalizeDrive ----
// Real drive shape confirmed live (field list: id, description, team,
// start, end, timeElapsed, yards, isScore, offensivePlays, result,
// shortDisplayResult, displayResult, plays) - trimmed to what this file
// reads.
{
  const realDrive = {
    id: "40187265719",
    team: { id: "14", abbreviation: "LAR", displayName: "Los Angeles Rams" },
    result: "PUNT",
    isScore: false,
    yards: 39,
    offensivePlays: 8,
  };
  const drive = normalizeDrive(realDrive);
  check("a real completed drive normalizes successfully", drive !== null);
  check("teamAbbreviation reads from team.abbreviation", drive?.teamAbbreviation === "LAR");
  check("result/yards/offensivePlays pass through", drive?.result === "PUNT" && drive?.yards === 39 && drive?.offensivePlays === 8);

  const scoringDrive = normalizeDrive({ team: { abbreviation: "SF" }, result: "TOUCHDOWN", isScore: true, yards: 75, offensivePlays: 11 });
  check("isScore reads true for a scoring drive", scoringDrive?.isScore === true);

  // drives.current never has a `result` (the drive isn't over yet) - must
  // normalize with result: null, not drop the drive or crash.
  const currentDrive = normalizeDrive({ team: { abbreviation: "LAR" }, isScore: false, yards: 12, offensivePlays: 3 });
  check("a drive with no result field (in-progress) normalizes result to null", currentDrive?.result === null);

  check("a drive missing team.abbreviation is dropped (returns null)", normalizeDrive({ result: "PUNT" }) === null);
  check("null/undefined input is dropped, not thrown", normalizeDrive(null) === null && normalizeDrive(undefined) === null);
}

// ---- normalizeBoxscore ----
// Real per-team statistics captured live, trimmed to the entries this file
// reads (full arrays carry ~25 stats; only these are used):
//   {"name":"turnovers","displayValue":"1"}
//   {"name":"thirdDownEff","displayValue":"7-12","label":"3rd down efficiency"}
//   {"name":"redZoneAttempts","displayValue":"2-3","label":"Red Zone (Made-Att)"}
//   {"name":"totalYards","displayValue":"310"}
//   {"name":"totalDrives","displayValue":"9"}
//   {"name":"possessionTime","displayValue":"33:50"}
{
  const realStats = [
    { name: "turnovers", displayValue: "1" },
    { name: "thirdDownEff", displayValue: "7-12", label: "3rd down efficiency" },
    { name: "redZoneAttempts", displayValue: "2-3", label: "Red Zone (Made-Att)" },
    { name: "totalYards", displayValue: "310" },
    { name: "totalDrives", displayValue: "9" },
    { name: "possessionTime", displayValue: "33:50" },
  ];
  const box = normalizeBoxscore({ statistics: realStats });
  check("a real boxscore team entry normalizes successfully", box !== null);
  check("turnovers parses as a number", box?.turnovers === 1);
  check("thirdDownEff '7-12' parses to made=7, attempted=12", box?.thirdDownMade === 7 && box?.thirdDownAttempted === 12);
  check(
    "redZoneAttempts '2-3' parses to scores=2, attempts=3 (label confirms made-attempted, not attempts-only)",
    box?.redZoneScores === 2 && box?.redZoneAttempts === 3
  );
  check("totalYards/totalDrives parse as numbers", box?.totalYards === 310 && box?.totalDrives === 9);
  check("possessionTime '33:50' parses to 2030 seconds", box?.possessionSeconds === 2030);

  check("a team box with no statistics array normalizes to null", normalizeBoxscore({}) === null);
  check("null/undefined input normalizes to null, not thrown", normalizeBoxscore(null) === null && normalizeBoxscore(undefined) === null);

  // Malformed: a stat present but with a non-numeric/unparseable
  // displayValue must degrade that ONE field to null, not fail the whole
  // boxscore (other stats are still usable).
  const partiallyMalformed = normalizeBoxscore({
    statistics: [
      { name: "turnovers", displayValue: "N/A" },
      { name: "thirdDownEff", displayValue: "garbage" },
      { name: "totalYards", displayValue: "275" },
    ],
  });
  check("an unparseable turnovers value degrades to null, not zero", partiallyMalformed?.turnovers === null);
  check("an unparseable thirdDownEff degrades both made/attempted to null", partiallyMalformed?.thirdDownMade === null && partiallyMalformed?.thirdDownAttempted === null);
  check("a sibling stat that DOES parse is unaffected by the malformed ones", partiallyMalformed?.totalYards === 275);

  // A genuine 0-0 must stay distinguishable from "stat missing entirely".
  const genuineZero = normalizeBoxscore({ statistics: [{ name: "redZoneAttempts", displayValue: "0-0" }] });
  check("a genuine 0-0 red-zone line parses to 0/0, not null", genuineZero?.redZoneScores === 0 && genuineZero?.redZoneAttempts === 0);
  const missingStat = normalizeBoxscore({ statistics: [{ name: "turnovers", displayValue: "0" }] });
  check("a stat ESPN never sent stays null, not fabricated as 0", missingStat?.totalYards === null);
}

// ---- normalizeSituation ----
// Real response from the core API's per-competition situation sub-resource,
// captured live: {"down":0,"yardLine":87,"distance":4,"isRedZone":true,
// "homeTimeouts":2,"awayTimeouts":1} (post-game snapshot - down 0 reflects
// the game having just ended, not a parsing gap).
{
  const real = { down: 1, yardLine: 19, distance: 10, isRedZone: true, homeTimeouts: 2, awayTimeouts: 1 };
  const situation = normalizeSituation(real);
  check("a real situation response normalizes successfully", situation !== null);
  check("down/distance/yardLine pass through", situation?.down === 1 && situation?.distance === 10 && situation?.yardLine === 19);
  check("isRedZone passes through", situation?.isRedZone === true);
  check("timeouts pass through", situation?.homeTimeouts === 2 && situation?.awayTimeouts === 1);

  const notRedZone = normalizeSituation({ down: 2, yardLine: 50, distance: 7, isRedZone: false, homeTimeouts: 3, awayTimeouts: 3 });
  check("isRedZone false passes through as false, not defaulted true", notRedZone?.isRedZone === false);

  // Malformed API response (the whole fetch failing, surfaced by the
  // fetcher as null - see fetchNflSituation's try/catch) must degrade to
  // null, never throw.
  check("a null situation response (failed fetch) normalizes to null", normalizeSituation(null) === null);
  check("an error-shaped object normalizes to null", normalizeSituation({ __status: 404 }) === null);
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
