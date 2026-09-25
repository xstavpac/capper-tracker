// Proof for the doubleheader game-number feature's parsing layer - run with:
//   npx tsx src/lib/doubleheader-game-number-acceptance-test.ts
//
// Covers: extractGameNumber's token matching (positive and negative cases -
// the negative list is the important half, since a false match would
// misattribute a pick to the wrong game), that the matched token is stripped
// before parsePickText/findTeamNicknames ever see it, the "(G1)"/"(G2)"
// label suffix parseCatalog bakes into description, and extractLine's
// suffix-safety fix (bet-line.ts) that keeps that suffix from ever being
// misread as a line/total/spread number. Resolution (pickBestScheduleCandidate)
// and grading (matchGameResult) are covered separately - see
// catalog-import-schedule-resolution-acceptance-test.ts and
// grading-pool-match-acceptance-test.ts.
import { extractGameNumber, withGameNumberSuffix, parseCatalog, parsePickText } from "./parse-catalog";
import { extractLine } from "./bet-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
console.log("########## extractGameNumber: positive matches ##########");
{
  const cases: [string, 1 | 2][] = [
    ["Cubs Game Two Moneyline", 2],
    ["Cubs G2 ML", 2],
    ["Red Sox nightcap ML", 2],
    ["Yankees 2nd game -1.5", 2],
    ["Cubs Game 1 ML", 1],
    ["Cubs first game ML", 1],
    ["Cubs Game One ML", 1],
    ["Cubs Game #2 ML", 2],
    ["Cubs game#1 ML", 1],
    ["Cubs G1 ML", 1],
    ["Cubs Gm2 ML", 2],
    ["Cubs Gm 1 ML", 1],
    ["Cubs second game ML", 2],
    ["Cubs 1st game ML", 1],
  ];
  for (const [text, expected] of cases) {
    check(`'${text}' -> gameNumber ${expected}`, extractGameNumber(text).gameNumber, expected);
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## extractGameNumber: must NOT match (period-scope tokens, generic numbers) ##########");
{
  const noMatch = [
    "Cubs first 5 ML",
    "Cubs 1st 5 -0.5",
    "Cubs F5 ML",
    "Cubs first five ML",
    "Cubs 1H ML",
    "Cubs 2H ML",
    "Cubs 1st half ML",
    "Cubs 2nd half ML",
    "Cubs 1st inning NRFI",
    "Cubs 1Q -3.5",
    "Cubs 2Q -3.5",
    "Cubs -1.5",
    "Cubs Over 8.5",
    "Cubs ML -124",
  ];
  for (const text of noMatch) {
    check(`'${text}' -> no gameNumber extracted`, extractGameNumber(text).gameNumber, null);
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## extractGameNumber: token is removed from the returned text ##########");
{
  check("'Cubs Game Two Moneyline' -> rest has the token stripped", extractGameNumber("Cubs Game Two Moneyline").rest, "Cubs Moneyline");
  check("'Yankees 2nd game -1.5' -> rest keeps the real line", extractGameNumber("Yankees 2nd game -1.5").rest, "Yankees -1.5");
  check("'Cubs G2 ML' -> rest has G2 stripped", extractGameNumber("Cubs G2 ML").rest, "Cubs ML");
  check("no token -> rest unchanged", extractGameNumber("Cubs ML").rest, "Cubs ML");
}

// ---------------------------------------------------------------------------
console.log("\n########## regression: 'Cubs 2nd game total 9' -> line 9, gameNumber 2 (not the 2 from '2nd game') ##########");
{
  const { gameNumber, rest } = extractGameNumber("Cubs 2nd game total 9");
  check("gameNumber extracted", gameNumber, 2);
  check("rest strips '2nd game', keeps 'total 9'", rest, "Cubs total 9");
  const parsed = parsePickText(rest);
  check("betType still resolves TOTAL", parsed.betType, "TOTAL");
  check("extractLine on the stripped text -> 9, not 2", extractLine("TOTAL", rest), 9);
}

// ---------------------------------------------------------------------------
console.log("\n########## withGameNumberSuffix + extractLine safety (decision 4/5) ##########");
{
  check("null gameNumber -> unchanged", withGameNumberSuffix("Cubs Moneyline", null), "Cubs Moneyline");
  check("gameNumber 2 -> ' (G2)' appended", withGameNumberSuffix("Cubs Moneyline", 2), "Cubs Moneyline (G2)");
  check("gameNumber 1 -> ' (G1)' appended", withGameNumberSuffix("Cubs Moneyline", 1), "Cubs Moneyline (G1)");

  // The exact cases the user asked to be proven safe: "(G2)" can never be
  // read as a line/total/spread number.
  check(
    "'Cubs total 9 (G2)' -> line 9 (the real number), not 2 from the suffix",
    extractLine("TOTAL", withGameNumberSuffix("Cubs total 9", 2)),
    9
  );
  check(
    "'Cubs (G2) ML' has no line concept at all (MONEYLINE) -> null either way",
    extractLine("MONEYLINE", withGameNumberSuffix("Cubs ML", 2)),
    null
  );
  // The actually dangerous case: a TOTAL pick with NO real number in its own
  // text at all (relies entirely on a separately-stored `line`) - without
  // the extractLine fix, the bare-number TOTAL fallback would misread the
  // "2" inside "(G2)" as the total line itself.
  check(
    "'Cubs Total (G2)' with no real number in text -> extractLine finds nothing, not 2",
    extractLine("TOTAL", withGameNumberSuffix("Cubs Total", 2)),
    null
  );
  check(
    "SPREAD: '(G2)' suffix never misread as a spread number",
    extractLine("SPREAD", withGameNumberSuffix("Cubs -1.5", 2)),
    -1.5
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## end-to-end through parseCatalog: label format + gameNumber field ##########");
{
  const text = "Porter Picks\nCubs Game Two Moneyline";
  const { picks } = parseCatalog(text);
  check("one pick resolved", picks.length, 1);
  if (picks.length === 1) {
    check("gameNumber threaded onto ParsedPick", picks[0].gameNumber, 2);
    check("description label format: 'Cubs Moneyline (G2)', no duplication", picks[0].description, "Cubs Moneyline (G2)");
    check("betType still MONEYLINE (game-number token didn't leak into bet-type detection)", picks[0].betType, "MONEYLINE");
  }

  const game1Text = "Porter Picks\nCubs Game 1 ML";
  const { picks: game1Picks } = parseCatalog(game1Text);
  check("game 1 pick resolved", game1Picks.length, 1);
  if (game1Picks.length === 1) {
    check("gameNumber 1", game1Picks[0].gameNumber, 1);
    check("label: 'Cubs ML (G1)'", game1Picks[0].description, "Cubs ML (G1)");
  }

  const noGameNumberText = "Porter Picks\nCubs ML";
  const { picks: plainPicks } = parseCatalog(noGameNumberText);
  check("no game-number token -> gameNumber null, description untouched", plainPicks[0]?.gameNumber, null);
  check("description has no suffix", plainPicks[0]?.description, "Cubs ML");

  // First-5/first-half text must never trigger gameNumber extraction inside
  // a real parseCatalog run either, not just in extractGameNumber isolation.
  const first5Text = "Porter Picks\nCubs First 5 ML";
  const { picks: first5Picks } = parseCatalog(first5Text);
  check("'Cubs First 5 ML' -> gameNumber stays null", first5Picks[0]?.gameNumber, null);
  check("'Cubs First 5 ML' -> period still FIRST_HALF (F5/1H mapping unaffected)", first5Picks[0]?.period, "FIRST_HALF");
}

// ---------------------------------------------------------------------------
console.log("\n########## token position: every variant resolves identically ##########");
{
  // Real repro shape: Cubs doubleheader, G1 final, G2 upcoming. Every one of
  // these must resolve to the same market/gameNumber/label/stripped-betDetail,
  // regardless of where the token sits in the line.
  const variants = [
    "Cubs G2 Moneyline",
    "Cubs Moneyline G2",
    "Cubs Moneyline (G2)",
    "Gm 2 Cubs Moneyline",
    "Gm2 Cubs ML",
    "Cubs Moneyline Gm 2",
    "Cubs ML gm2",
    "G2 Cubs ML",
    "Game 2 Cubs Moneyline",
    "Game 2: Cubs ML",
    "Cubs Game Two Moneyline",
    "Cubs moneyline game 2",
  ];
  for (const line of variants) {
    const { gameNumber, rest } = extractGameNumber(line);
    check(`'${line}' -> gameNumber 2`, gameNumber, 2);
    const parsed = parsePickText(rest);
    check(`'${line}' -> betType MONEYLINE`, parsed.betType, "MONEYLINE");
    // The capper's own wording for the bet type (ML / Moneyline / moneyline)
    // is preserved verbatim in cleanDescription - this app never normalizes
    // that (same "betDetail is the capper's own text" rule formatPickLabel
    // documents) - only the game-number token itself is stripped, and only
    // that token's removal is what every variant must have in common.
    check(`'${line}' -> token stripped from betDetail (no residual G2/Gm2/Game 2)`, /\b(g2|gm\s*2|game\s*2)\b/i.test(parsed.cleanDescription), false);
    check(`'${line}' -> label is '${parsed.cleanDescription} (G2)'`, withGameNumberSuffix(parsed.cleanDescription, gameNumber), `${parsed.cleanDescription} (G2)`);
  }
  // The exact literal example given: "Cubs G2 Moneyline" -> "Cubs Moneyline (G2)".
  {
    const { gameNumber, rest } = extractGameNumber("Cubs G2 Moneyline");
    check("'Cubs G2 Moneyline' -> exact label 'Cubs Moneyline (G2)'", withGameNumberSuffix(parsePickText(rest).cleanDescription, gameNumber), "Cubs Moneyline (G2)");
  }

  // Line/total value must never be corrupted by the token, in either order.
  {
    const { gameNumber, rest } = extractGameNumber("Cubs -1.5 Gm 2");
    check("'Cubs -1.5 Gm 2' -> gameNumber 2", gameNumber, 2);
    const parsed = parsePickText(rest);
    check("'Cubs -1.5 Gm 2' -> betType SPREAD", parsed.betType, "SPREAD");
    check("'Cubs -1.5 Gm 2' -> run line -1.5, not corrupted by the '2'", extractLine("SPREAD", rest), -1.5);
  }
  {
    const { gameNumber, rest } = extractGameNumber("Cubs over 6.5 gm2");
    check("'Cubs over 6.5 gm2' -> gameNumber 2", gameNumber, 2);
    const parsed = parsePickText(rest);
    check("'Cubs over 6.5 gm2' -> betType TOTAL", parsed.betType, "TOTAL");
    check("'Cubs over 6.5 gm2' -> total 6.5, not corrupted by the '2'", extractLine("TOTAL", rest), 6.5);
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## leading token in a multi-capper paste doesn't break capper/team detection ##########");
{
  const paste = "Ac Sniper\nGm 2 Cubs Moneyline";
  const { picks, unresolved } = parseCatalog(paste);
  check("no lines fall through to unresolved", unresolved, []);
  check("exactly one pick resolved", picks.length, 1);
  if (picks.length === 1) {
    check("capper is 'Ac Sniper', NOT swallowed by the leading 'Gm 2' token", picks[0].capperName, "Ac Sniper");
    check("sport resolves MLB (team detection wasn't blocked by the leading token)", picks[0].sportName, "MLB");
    check("gameNumber extracted despite leading position", picks[0].gameNumber, 2);
    check("label", picks[0].description, "Cubs Moneyline (G2)");
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## requirement 3 repro: 'Ac Sniper - Cubs G2 over 6.5' ##########");
{
  const paste = "Ac Sniper - Cubs G2 over 6.5";
  const { picks, unresolved } = parseCatalog(paste, ["Ac Sniper"]);
  check("no lines fall through to unresolved", unresolved, []);
  check("exactly one pick resolved", picks.length, 1);
  if (picks.length === 1) {
    check("capper is 'Ac Sniper'", picks[0].capperName, "Ac Sniper");
    check("sport resolves MLB", picks[0].sportName, "MLB");
    check("betType TOTAL", picks[0].betType, "TOTAL");
    check("totalSide over", picks[0].totalSide, "over");
    check("gameNumber 2", picks[0].gameNumber, 2);
    check("label", picks[0].description, "Cubs over 6.5 (G2)");
    check("teamNicknames includes cubs", picks[0].teamNicknames, ["cubs"]);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
