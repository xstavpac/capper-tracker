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

function main() {
  // --- Probe lines from the discovery report ------------------------------
  expectUnsupported("Schlittler over 17.5 outs", MLB);
  expectUnsupported("Chris Sale over 5.5 K", MLB);
  expectUnsupported("Tolle over 4.5 K", MLB);
  expectUnsupported("MLB Chris Sale over 5.5 K", MLB);
  expectUnsupported("MLB Yankees vs Red Sox Schlittler over 17.5 outs", MLB);
  expectUnsupported("NHL Ivan Demidov 2+ shots on goal", NHL);
  expectUnsupported("NHL William Nylander anytime goal scorer", NHL);
  // Tennis-surname collisions (ramos / wolf / paul are all in KNOWN_TENNIS_PLAYERS).
  expectUnsupported("Heliot Ramos over 1.5 total bases", MLB);
  expectUnsupported("Dustin Wolf over 24.5 saves", NHL);
  expectUnsupported("Nick Paul over 2.5 shots on goal", NHL);

  // --- Other shapes from the ask ------------------------------------------
  expectUnsupported("Ivan Demidov 2+ shots on goal", NHL);
  expectUnsupported("Cole Caufield 3+ shots on goal", NHL);
  expectUnsupported("Sale 3+ Ks", MLB);
  expectUnsupported("Leon Draisaitl first goal scorer", NHL);
  expectUnsupported("Leon Draisaitl over 1.5 points", UNSUPPORTED_PROP_REASONS.GENERIC);
  expectUnsupported("NHL Leon Draisaitl over 1.5 points", NHL);
  expectUnsupported("NHL Connor McDavid o1.5 assists", NHL);
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
      "KRASH/RBS paste: every line has the NHL reason",
      r.unresolved.map((l) => detectUnsupportedPropLine(l)?.reason),
      Array(6).fill(NHL)
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
    ["NBA LeBron James over 25.5 points", "NBA", "TOTAL"], // pre-existing behavior, deliberately unchanged
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

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main();
