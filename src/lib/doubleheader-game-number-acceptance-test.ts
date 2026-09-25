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

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
