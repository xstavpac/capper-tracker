// Proof that MLB/NHL player-prop lines (no markets/grading exist for them yet)
// are never dropped, misclassified, or claimed by tennis - run with:
//   npx tsx src/lib/mlb-nhl-prop-line-safety-acceptance-test.ts
//
// Before this change:
//   - "Ivan Demidov 2+ shots on goal" failed looksLikePick and was eaten as a
//     capper-name header (0 picks AND 0 unresolved - a silent drop);
//   - "MLB Chris Sale over 5.5 K" imported as a game TOTAL, and "NHL ... 2+
//     shots on goal" as a MONEYLINE;
//   - "Heliot Ramos / Dustin Wolf / Nick Paul over N ..." imported as ATP
//     tennis picks (surname collisions with KNOWN_TENNIS_PLAYERS).
// Now every one of them lands in `unresolved` with a distinct reason, and the
// controls below prove team bets, NFL props, tennis and capper headers are
// untouched.
import { parseCatalog, detectUnsupportedPropLine } from "@/lib/parse-catalog";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { parsePlayerProp, parsePlayerPropLine, parseTouchdownProp, normalizeNPlusPlayerProp } from "@/lib/bet-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const MLB = UNSUPPORTED_PROP_REASONS.MLB;
const NHL = UNSUPPORTED_PROP_REASONS.NHL;

// Asserts a single line parses to exactly one unresolved entry with the given
// reason, zero picks/parlays (so never ATP / TOTAL / MONEYLINE), and
// attributed to `capper`.
function expectUnsupported(line: string, reason: string, capper = "Krash") {
  const r = parseCatalog(capper + "\n" + line);
  check(`unresolved: "${line}"`, r.unresolved, [line]);
  check(`  no picks/parlays: "${line}"`, [r.picks.length, r.parlays.length], [0, 0]);
  check(`  attributed to ${capper}: "${line}"`, r.unresolvedCapperNames, [capper]);
  check(`  reason: "${line}"`, detectUnsupportedPropLine(line)?.reason, reason);
}

// NHL player props are SUPPORTED now (nhl-prop.ts), so an NHL market line is no
// longer "unsupported". Two shapes, both still guaranteed never to be dropped,
// a game TOTAL/MONEYLINE, or an ATP pick:
//  - sport named ("NHL Ivan Demidov 2+ shots on goal"): imports as an NHL PLAYER_PROP;
//  - sport-less ("Ivan Demidov 2+ shots on goal"): parked in `unresolved` (attributed
//    to its capper) for the NHL-roster recovery pass (recover-unresolved-lines.ts).
function expectNhlPick(line: string, capper = "Krash") {
  const r = parseCatalog([capper, line].join("\n"));
  check(`NHL pick imported: "${line}"`, r.picks.map((p) => [p.capperName, p.sportName, p.betType]), [[capper, "NHL", "PLAYER_PROP"]]);
  check(`  nothing unresolved: "${line}"`, [r.unresolved.length, r.parlays.length], [0, 0]);
  check(`  no longer flagged unsupported: "${line}"`, detectUnsupportedPropLine(line), null);
}
function expectNhlAwaitingRoster(line: string, capper = "Krash") {
  const r = parseCatalog([capper, line].join("\n"));
  check(`NHL line awaits roster recovery: "${line}"`, r.unresolved, [line]);
  check(`  no picks/parlays: "${line}"`, [r.picks.length, r.parlays.length], [0, 0]);
  check(`  attributed to ${capper}: "${line}"`, r.unresolvedCapperNames, [capper]);
  check(`  no longer flagged unsupported: "${line}"`, detectUnsupportedPropLine(line), null);
}

function main() {
  // --- Probe lines from the discovery report ------------------------------
  expectUnsupported("Schlittler over 17.5 outs", MLB);
  expectUnsupported("Chris Sale over 5.5 K", MLB);
  expectUnsupported("Tolle over 4.5 K", MLB);
  expectUnsupported("MLB Chris Sale over 5.5 K", MLB);
  expectUnsupported("MLB Yankees vs Red Sox Schlittler over 17.5 outs", MLB);
  expectNhlPick("NHL Ivan Demidov 2+ shots on goal");
  expectNhlPick("NHL William Nylander anytime goal scorer");
  // Tennis-surname collisions (ramos / wolf / paul are all in KNOWN_TENNIS_PLAYERS).
  expectUnsupported("Heliot Ramos over 1.5 total bases", MLB);
  expectNhlAwaitingRoster("Dustin Wolf over 24.5 saves");
  expectNhlAwaitingRoster("Nick Paul over 2.5 shots on goal");
  // An NHL market this app still cannot grade keeps the NHL reason (#152).
  expectUnsupported("NHL Brady Tkachuk over 3.5 hits", NHL);

  // --- Other shapes from the ask ------------------------------------------
  expectNhlAwaitingRoster("Ivan Demidov 2+ shots on goal");
  expectNhlAwaitingRoster("Cole Caufield 3+ shots on goal");
  expectUnsupported("Sale 3+ Ks", MLB);
  expectNhlAwaitingRoster("Leon Draisaitl first goal scorer");
  expectUnsupported("Leon Draisaitl over 1.5 points", UNSUPPORTED_PROP_REASONS.GENERIC);
  expectNhlPick("NHL Leon Draisaitl over 1.5 points");
  expectNhlPick("NHL Connor McDavid o1.5 assists");
  expectUnsupported("Aaron Judge to hit a home run", MLB);
  expectUnsupported("Aaron Judge over 0.5 HR", MLB);
  expectUnsupported("Juan Soto over 1.5 RBIs", MLB);
  expectUnsupported("Bobby Witt over 0.5 stolen bases", MLB);
  expectUnsupported("Mookie Betts over 1.5 hits", MLB);
  expectUnsupported("Mookie Betts over 0.5 runs", MLB);
  expectUnsupported("Garrett Crochet over 6.5 strikeouts", MLB);

  // --- The full KRASH / RBS NHL paste -------------------------------------
  {
    const paste = [
      "KRASH",
      "Ivan Demidov 2+ shots on goal",
      "Darren Raddysh 2+ shots on goal",
      "Cole Caufield 3+ shots on goal",
      "RBS",
      "William Nylander anytime goal scorer",
      "Mika Zibanejad anytime goal scorer",
      "Leon Draisaitl anytime goal scorer",
    ].join("\n");
    const r = parseCatalog(paste);
    check("KRASH/RBS paste: 0 picks", r.picks.length, 0);
    check("KRASH/RBS paste: 0 parlays", r.parlays.length, 0);
    check("KRASH/RBS paste: 6 unresolved", r.unresolved.length, 6);
    check("KRASH/RBS paste: capper attribution", r.unresolvedCapperNames, [
      "KRASH",
      "KRASH",
      "KRASH",
      "RBS",
      "RBS",
      "RBS",
    ]);
    check(
      "KRASH/RBS paste: no line eaten as a capper name (every unresolved is a prop line, headers stay headers)",
      r.unresolved.every((l) => !["KRASH", "RBS"].includes(l)),
      true
    );
    check(
      "KRASH/RBS paste: no line is flagged unsupported any more (they go to NHL-roster recovery)",
      r.unresolved.map((l) => detectUnsupportedPropLine(l)),
      Array(6).fill(null)
    );
  }

  // Inline "Capper: line" form (a saved capper's name on the same line).
  {
    const r = parseCatalog("Krash Ivan Demidov 2+ shots on goal", ["Krash"]);
    check("inline saved-capper form: unresolved, not dropped", r.unresolved, ["Krash Ivan Demidov 2+ shots on goal"]);
    check("inline saved-capper form: attributed to Krash", r.unresolvedCapperNames, ["Krash"]);
    check("inline saved-capper form: no picks", r.picks.length, 0);
  }

  // A prop line mixed with real picks: the real picks still import and the
  // header after the prop line is still read as a header.
  {
    const r = parseCatalog(["Krash", "MLB Yankees ML", "Chris Sale over 5.5 K", "Hoop Dealer", "NBA Nuggets ML"].join("\n"));
    check("mixed paste: 2 real picks imported", r.picks.map((p) => [p.capperName, p.sportName, p.betType]), [
      ["Krash", "MLB", "MONEYLINE"],
      ["Hoop Dealer", "NBA", "MONEYLINE"],
    ]);
    check("mixed paste: prop line unresolved under Krash", [r.unresolved, r.unresolvedCapperNames], [
      ["Chris Sale over 5.5 K"],
      ["Krash"],
    ]);
  }

  // --- Controls: nothing else changes ---------------------------------------
  // Capper headers that share vocabulary with a prop keep parsing as headers.
  for (const header of ["KRASH", "RBS", "HOOP DEALER", "HR Kings", "Hits Only", "Points Guru", "Saves Sam", "Total Bases Tom"]) {
    const r = parseCatalog(header + "\nMLB Yankees ML");
    check(`header stays a capper name: "${header}"`, [r.picks.map((p) => p.capperName), r.unresolved.length], [[header], 0]);
  }
  // A capper's own record tagline is not a prop.
  {
    const r = parseCatalog("Bambino 8-1 HR heater\nMLB Yankees ML");
    check("record tagline '8-1 HR heater' is not a prop line", r.unresolved.length, 0);
  }

  // MLB/NHL team bets, F5, team totals, NRFI keep their classification.
  const teamBets: [string, string, string][] = [
    ["MLB Yankees ML", "MLB", "MONEYLINE"],
    ["MLB Yankees -1.5", "MLB", "SPREAD"],
    ["MLB Yankees vs Red Sox over 8.5 runs", "MLB", "TOTAL"],
    ["MLB Yankees vs Red Sox under 8.5", "MLB", "TOTAL"],
    ["MLB Yankees F5 -0.5", "MLB", "SPREAD"],
    ["MLB Yankees F5 ML", "MLB", "MONEYLINE"],
    ["MLB Yankees NRFI", "MLB", "NRFI"],
    ["MLB Yankees team total over 4.5 runs", "MLB", "TEAM_TOTAL"],
    ["NHL Oilers ML", "NHL", "MONEYLINE"],
    ["NHL Oilers puck line -1.5", "NHL", "SPREAD"],
    ["NHL Oilers vs Flames over 6.5", "NHL", "TOTAL"],
    ["NHL Oilers over 3.5 goals", "NHL", "TOTAL"], // pre-existing classification, unchanged
    ["NBA Lakers over 220.5 points", "NBA", "TOTAL"],
    ["NBA Lakers vs Nuggets over 220.5 pts", "NBA", "TOTAL"],
    ["NBA Lakers team total over 112.5", "NBA", "TEAM_TOTAL"],
    ["Lakers over 220.5 points", "NBA", "TOTAL"],
    ["Lakers team total over 112.5", "NBA", "TEAM_TOTAL"],
  ];
  for (const [line, sport, betType] of teamBets) {
    const r = parseCatalog("Krash\n" + line);
    check(`unchanged: "${line}"`, [r.picks.map((p) => [p.sportName, p.betType]), r.unresolved.length], [[[sport, betType]], 0]);
  }

  // NFL props still classify PLAYER_PROP; tennis still resolves to ATP.
  {
    const r = parseCatalog("Krash\nNFL Gibbs Over 65.5 Rushing Yards");
    check("NFL prop still PLAYER_PROP", r.picks.map((p) => [p.sportName, p.betType]), [["NFL", "PLAYER_PROP"]]);
    const t = parseCatalog("Krash\nSinner ML");
    check("tennis 'Sinner ML' still ATP", t.picks.map((p) => [p.sportName, p.betType]), [["ATP", "MONEYLINE"]]);
    check("NFL prop is not flagged by the MLB/NHL detector", detectUnsupportedPropLine("Puka Nacua Anytime TD"), null);
    check("NFL prop is not flagged by the MLB/NHL detector (yards)", detectUnsupportedPropLine("Josh Allen Over 275.5 Passing Yards"), null);
  }

  // --- A. NBA / WNBA player props ---------------------------------------------
  // Before: "NBA LeBron James over 25.5 points" imported as a game TOTAL (wrong
  // data). Now unresolved, never TOTAL. Sport is named only when a code says so.
  expectUnsupported("NBA LeBron James over 25.5 points", UNSUPPORTED_PROP_REASONS.NBA);
  expectUnsupported("WNBA A'ja Wilson over 9.5 rebounds", UNSUPPORTED_PROP_REASONS.WNBA);
  expectUnsupported("A'ja Wilson over 9.5 rebounds", UNSUPPORTED_PROP_REASONS.GENERIC);
  expectUnsupported("NBA Nikola Jokic over 10.5 assists", UNSUPPORTED_PROP_REASONS.NBA);
  expectUnsupported("NBA Stephen Curry over 4.5 threes", UNSUPPORTED_PROP_REASONS.NBA);
  expectUnsupported("Jalen Brunson over 40.5 PRA", UNSUPPORTED_PROP_REASONS.GENERIC);
  expectUnsupported("Nikola Jokic over 45.5 pts+reb+ast", UNSUPPORTED_PROP_REASONS.GENERIC);
  expectUnsupported("NBA Victor Wembanyama over 3.5 blocks", UNSUPPORTED_PROP_REASONS.NBA);
  expectUnsupported("NBA Shai Gilgeous-Alexander over 1.5 steals", UNSUPPORTED_PROP_REASONS.NBA);
  expectUnsupported("WNBA Caitlin Clark 25+ points", UNSUPPORTED_PROP_REASONS.WNBA);
  {
    const r = parseCatalog("Krash\nNBA LeBron James over 25.5 points");
    check("NBA prop is never a TOTAL (no picks at all)", r.picks.map((p) => p.betType), []);
  }

  // --- Team NON-scoring stat totals ----------------------------------------------
  // "Lakers over 45.5 rebounds" used to import as a game TOTAL (graded on
  // points). Now unresolved, "Team stat totals aren't supported yet".
  const TEAM_STAT = UNSUPPORTED_PROP_REASONS.TEAM_STAT;
  for (const line of [
    "Lakers over 45.5 rebounds",
    "NBA Lakers over 45.5 rebounds",
    "NBA Celtics over 25.5 assists",
    "Warriors over 13.5 threes",
    "Heat under 8.5 steals",
    "Bucks over 5.5 blocks",
    "Lakers over 14.5 turnovers",
    "Yankees over 8.5 hits",
    "Oilers over 30.5 shots on goal",
  ]) {
    const r = parseCatalog("Krash\n" + line);
    check(`team stat -> unresolved, never TOTAL: "${line}"`, [r.picks.length, r.parlays.length, r.unresolved], [0, 0, [line]]);
    check(`  reason: "${line}"`, detectUnsupportedPropLine(line)?.reason, TEAM_STAT);
  }
  // Scoring totals / team totals are never touched (points, pts, runs, goals).
  for (const line of [
    "Lakers over 220.5 points",
    "Lakers team total over 112.5",
    "NBA Lakers vs Nuggets over 220.5 pts",
    "Yankees over 4.5 runs",
    "MLB Yankees vs Red Sox over 8.5 runs",
    "Oilers over 3.5 goals",
  ]) {
    check(`scoring total untouched: "${line}"`, detectUnsupportedPropLine(line), null);
  }
  // A PLAYER with the same word is still the player-prop reason, not team-stat.
  check(
    "person + rebounds stays the player-prop reason",
    detectUnsupportedPropLine("NBA Nikola Jokic over 12.5 rebounds")?.reason,
    UNSUPPORTED_PROP_REASONS.NBA
  );

  // --- Matchup ("X vs Y" / "X @ Y") + non-scoring stat --------------------------
  // Game stat totals: never TOTAL, "Game stat totals aren't supported yet".
  const GAME_STAT = UNSUPPORTED_PROP_REASONS.GAME_STAT;
  for (const line of [
    "Yankees vs Red Sox over 20.5 hits",
    "MLB Yankees vs Red Sox over 20.5 hits",
    "Yankees @ Red Sox over 20.5 hits",
    "NBA Lakers vs Nuggets over 90.5 rebounds",
    "NBA Lakers @ Nuggets over 90.5 rebounds",
    "Lakers vs Nuggets over 45.5 assists",
    "Lakers vs Nuggets over 25.5 threes",
    "Lakers vs Nuggets over 15.5 steals",
    "Lakers vs Nuggets over 10.5 blocks",
    "Lakers vs Nuggets over 30.5 turnovers",
    "Lakers vs Nuggets over 40.5 fouls",
    "Oilers vs Flames over 60.5 shots on goal",
    "Los Angeles Lakers vs Boston Celtics over 90.5 rebounds",
  ]) {
    const r = parseCatalog("Krash\n" + line);
    check(`matchup stat -> unresolved, never TOTAL: "${line}"`, [r.picks.length, r.parlays.length, r.unresolved], [0, 0, [line]]);
    check(`  reason: "${line}"`, detectUnsupportedPropLine(line)?.reason, GAME_STAT);
  }
  // A player's name after the matchup keeps the PLAYER-prop reason.
  check(
    "matchup + pitcher name keeps MLB player-prop reason (Schlittler)",
    detectUnsupportedPropLine("MLB Yankees vs Red Sox Schlittler over 17.5 outs")?.reason,
    UNSUPPORTED_PROP_REASONS.MLB
  );
  check(
    "matchup + player name + ambiguous word keeps NBA player-prop reason",
    detectUnsupportedPropLine("NBA Lakers vs Nuggets LeBron James over 25.5 rebounds")?.reason,
    UNSUPPORTED_PROP_REASONS.NBA
  );
  // Matchup lines with scoring words stay ordinary totals, still importing as before.
  for (const [line, sport] of [
    ["Yankees vs Red Sox over 8.5 runs", "MLB"],
    ["Lakers vs Nuggets over 220.5 points", "NBA"],
    ["Lakers vs Nuggets over 220.5 pts", "NBA"],
    ["NBA Lakers vs Nuggets over 220.5", "NBA"],
    ["Oilers vs Flames over 6.5 goals", "NHL"],
    ["MLB Yankees @ Red Sox total over 8.5 runs", "MLB"],
  ] as [string, string][]) {
    check(`matchup scoring total untouched: "${line}"`, detectUnsupportedPropLine(line), null);
    const r = parseCatalog("Krash\n" + line);
    check(`  still imports as a TOTAL pick: "${line}"`, [r.picks.length, r.picks[0]?.betType, r.unresolved.length], [1, "TOTAL", 0]);
    void sport;
  }

  // --- B. NFL N+ props ----------------------------------------------------------
  // The exact production block: "Zach Ertz 3+ receptions" was eaten as a capper
  // name and the next pick credited to that fake capper.
  {
    const rosterFixture = [
      { playerName: "DeVonta Smith", firstName: "DeVonta", lastName: "Smith", team: "Philadelphia Eagles", position: "WR", externalPlayerId: "1" },
      { playerName: "Zach Ertz", firstName: "Zach", lastName: "Ertz", team: "Washington Commanders", position: "TE", externalPlayerId: "2" },
      { playerName: "Rome Odunze", firstName: "Rome", lastName: "Odunze", team: "Chicago Bears", position: "WR", externalPlayerId: "3" },
    ];
    const block = ["CHEESE", "DeVonta Smith Over 4.5 receptions", "Zach Ertz 3+ receptions", "Rome Odunze Anytime Touchdown"].join("\n");
    const parsed = parseCatalog(block, []);
    check("CHEESE block: no fake capper (no picks credited to a player name)", parsed.picks.map((p) => p.capperName), []);
    check("CHEESE block: all three lines reach unresolved, all under CHEESE", parsed.unresolvedCapperNames, ["CHEESE", "CHEESE", "CHEESE"]);
    const rec = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, [], rosterFixture);
    check("CHEESE block: nothing left unresolved after roster recovery", rec.stillUnresolved, []);
    check(
      "CHEESE block: all three picks attributed to CHEESE",
      rec.recovered.map((p) => p.capperName),
      ["CHEESE", "CHEESE", "CHEESE"]
    );
    check(
      "CHEESE block: all three are NFL PLAYER_PROP",
      rec.recovered.map((p) => [p.sportName, p.betType]),
      [["NFL", "PLAYER_PROP"], ["NFL", "PLAYER_PROP"], ["NFL", "PLAYER_PROP"]]
    );
    const ertz = rec.recovered.find((p) => /Ertz/.test(p.description));
    check("'Zach Ertz 3+ receptions' stored as over 2.5 receptions", ertz?.description, "Zach Ertz Over 2.5 receptions");
    check("  ...and its line reads back as OVER 2.5", parsePlayerPropLine(ertz?.description ?? ""), { direction: "OVER", line: 2.5 });
    check("  ...and its market is RECEPTIONS for player Zach Ertz", parsePlayerProp(ertz?.description ?? ""), {
      playerName: "Zach Ertz",
      propMarket: "RECEPTIONS",
    });
  }
  // N+ conversion per supported market: N+ == over (N - 0.5).
  const nPlus: [string, string, string][] = [
    ["Zach Ertz 3+ receptions", "Zach Ertz Over 2.5 receptions", "RECEPTIONS"],
    ["Saquon Barkley 80+ rushing yards", "Saquon Barkley Over 79.5 rushing yards", "RUSH_YDS"],
    ["A.J. Brown 100+ receiving yards", "A.J. Brown Over 99.5 receiving yards", "REC_YDS"],
    ["Josh Allen 250+ passing yards", "Josh Allen Over 249.5 passing yards", "PASS_YDS"],
    ["Jahmyr Gibbs 100+ rush and rec yards", "Jahmyr Gibbs Over 99.5 rush and rec yards", "RUSH_REC_YDS"],
    ["Josh Allen 300+ pass and rush yards", "Josh Allen Over 299.5 pass and rush yards", "PASS_RUSH_YDS"],
  ];
  for (const [line, expectedDescription, market] of nPlus) {
    const r = parseCatalog("Krash\nNFL " + line);
    check(`N+ imports: "${line}"`, r.picks.map((p) => [p.sportName, p.betType, p.description]), [["NFL", "PLAYER_PROP", expectedDescription]]);
    check(`  market ${market}`, parsePlayerProp(expectedDescription)?.propMarket, market);
    check(`  not flagged unsupported: "${line}"`, detectUnsupportedPropLine(line), null);
  }
  // TD N+ keeps its existing multi-TD "unsupported" handling (still a PLAYER_PROP
  // that grading declines) - not rewritten to an over/under line.
  {
    const r = parseCatalog("Krash\nNFL Puka Nacua 2+ TDs");
    check("TD N+ text untouched", r.picks.map((p) => [p.betType, p.description]), [["PLAYER_PROP", "Puka Nacua 2+ TDs"]]);
    check("TD N+ still flagged multi-TD unsupported by parseTouchdownProp", !!parseTouchdownProp("Puka Nacua 2+ TDs")?.unsupported, true);
  }
  // Unsupported NFL stats in N+ form route to unresolved (never yardage picks -
  // parsePlayerProp alone would read "passing completions" as PASS_YDS).
  for (const line of ["Patrick Mahomes 25+ passing completions", "NFL T.J. Watt 1+ sacks", "Micah Parsons 5+ tackles", "Derrick Henry 20+ rushing attempts"]) {
    const r = parseCatalog("Krash\n" + line);
    check(`unsupported NFL N+ -> unresolved: "${line}"`, [r.picks.length, r.unresolved.length], [0, 1]);
    check(`  reason: "${line}"`, detectUnsupportedPropLine(line)?.reason, UNSUPPORTED_PROP_REASONS.NFL);
  }
  // Same unsupported NFL stats in OVER/UNDER form: unresolved with the NFL
  // reason, checked before parsePlayerProp (which reads "passing completions"
  // and "pass attempts" as PASS_YDS, and "rushing attempts" as RUSH_YDS).
  for (const line of [
    "Patrick Mahomes over 22.5 passing completions",
    "Josh Allen under 34.5 pass attempts",
    "T.J. Watt over 0.5 sacks",
    "Micah Parsons over 6.5 tackles",
    "Derrick Henry over 15.5 carries",
    "Amon-Ra St. Brown over 5.5 targets",
    "Brandon Aubrey over 1.5 field goals",
    "Sauce Gardner over 0.5 interceptions",
    "NFL Derrick Henry over 20.5 rushing attempts",
    "Derrick Henry o15.5 carries",
  ]) {
    const r = parseCatalog("Krash\n" + line);
    check(`unsupported NFL over/under -> unresolved: "${line}"`, [r.picks.length, r.unresolved.length], [0, 1]);
    check(`  reason: "${line}"`, detectUnsupportedPropLine(line)?.reason, UNSUPPORTED_PROP_REASONS.NFL);
  }
  // Supported NFL markets in over/under form are unaffected: still PLAYER_PROP
  // picks (prefixed) with the text untouched.
  for (const line of [
    "Josh Allen over 250.5 passing yards",
    "Saquon Barkley over 79.5 rushing yards",
    "A.J. Brown over 99.5 receiving yards",
    "Zach Ertz over 2.5 receptions",
    "Jahmyr Gibbs over 99.5 rush and rec yards",
    "Josh Allen over 299.5 pass and rush yards",
    "Rome Odunze Anytime Touchdown",
  ]) {
    const r = parseCatalog("Krash\nNFL " + line);
    check(`supported NFL prop unaffected: "${line}"`, r.picks.map((p) => [p.sportName, p.betType, p.description]), [["NFL", "PLAYER_PROP", line]]);
    check(`  not flagged: "${line}"`, detectUnsupportedPropLine(line), null);
  }
  // An over/under line already present is never rewritten; headers with "3+" stay headers.
  check("explicit over/under text is left alone", normalizeNPlusPlayerProp("Zach Ertz Over 2.5 receptions"), "Zach Ertz Over 2.5 receptions");
  check("odds like +150 are not N+", normalizeNPlusPlayerProp("Zach Ertz Over 2.5 receptions +150"), "Zach Ertz Over 2.5 receptions +150");
  {
    const r = parseCatalog("Sharp Sam 3+ units\nNFL Chiefs ML");
    check("'3+ units' style header line unaffected", r.picks.map((p) => p.sportName), ["NFL"]);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main();
