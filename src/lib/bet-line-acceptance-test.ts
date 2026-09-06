// Proof for formatPickLabel (bet-line.ts) - the pick-list short label. The
// bug it fixes: a TOTAL pick imported without a number in its own text ("just
// Under") had its line confirmed through the catalog-import flow and stored in
// Pick.line, but no display surface rendered Pick.line, so it showed as bare
// "Under". This helper appends the stored line ONLY when the text carries no
// line of its own - using extractLine (the same check grading trusts), so
// "u8.5" shorthand and "under nine" spelled-out are recognized and never get
// a duplicate appended.
//
// Pure: no DB, no imports beyond the module under test. Run with:
//   npx tsx src/lib/bet-line-acceptance-test.ts
import { formatPickLabel, betScope, pickPeriodFromText, periodLabel } from "@/lib/bet-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---- betScope: classifying a pick's game-segment scope from its text ----
// The full phrasing matrix. betScope lower-cases internally, so callers pass
// raw betDetail. First match wins; quarters/periods are tested before the
// broader half patterns.
const SCOPE_CASES: [string, string][] = [
  // full game
  ["UNLV -7", "FULL_GAME"],
  ["Dodgers/Padres over 8.5", "FULL_GAME"],
  ["Curry 3P over 2.5", "FULL_GAME"], // "3P" (threes) must NOT read as THIRD_PERIOD
  // first half / F5 (unchanged from PR #19)
  ["over 20.5 1st half", "FIRST_HALF"],
  ["first half spread -3", "FIRST_HALF"],
  ["UNLV 1H over 20.5", "FIRST_HALF"],
  ["Yankees F5 -1.5", "FIRST_HALF"],
  ["first 5 innings under 4.5", "FIRST_HALF"],
  // second half
  ["over 27.5 2nd half", "SECOND_HALF"],
  ["Hawaii second half +7", "SECOND_HALF"],
  ["UNLV 2H -3", "SECOND_HALF"],
  // quarters
  ["over 13.5 first quarter", "FIRST_QUARTER"],
  ["Hawaii 1st qtr ML", "FIRST_QUARTER"],
  ["Q1 -3.5", "FIRST_QUARTER"],
  ["UNLV 1Q over 6.5", "FIRST_QUARTER"],
  ["quarter 1 total over 10", "FIRST_QUARTER"],
  ["2nd quarter over 14.5", "SECOND_QUARTER"],
  ["q2 spread", "SECOND_QUARTER"],
  ["3rd quarter ML", "THIRD_QUARTER"],
  ["over 14.5 q3", "THIRD_QUARTER"],
  ["4th quarter under 12.5", "FOURTH_QUARTER"],
  ["UNLV ML 4q", "FOURTH_QUARTER"],
  // hockey periods
  ["over 2.5 1st period", "FIRST_PERIOD"],
  ["Jets 2nd period ML", "SECOND_PERIOD"],
  ["3rd period over 1.5", "THIRD_PERIOD"],
  ["p1 total over 1.5", "FIRST_PERIOD"],
  ["period 3 ML", "THIRD_PERIOD"],
  // no score source anywhere -> UNSUPPORTED_SEGMENT
  ["over 0.5 1st inning", "UNSUPPORTED_SEGMENT"],
  ["yankees 7th inning over 0.5", "UNSUPPORTED_SEGMENT"],
];
for (const [text, expected] of SCOPE_CASES) {
  check(`betScope(${JSON.stringify(text)})`, betScope(text), expected);
}

// pickPeriodFromText collapses only the ungradeable UNSUPPORTED_SEGMENT to
// FULL_GAME (it has no Period value); everything else passes through.
check("pickPeriodFromText: Q1 text -> FIRST_QUARTER", pickPeriodFromText("over 13.5 first quarter"), "FIRST_QUARTER");
check("pickPeriodFromText: 2H text -> SECOND_HALF", pickPeriodFromText("over 27.5 2nd half"), "SECOND_HALF");
check("pickPeriodFromText: lone-inning text -> FULL_GAME (no Period for it)", pickPeriodFromText("over 0.5 1st inning"), "FULL_GAME");
check("pickPeriodFromText: plain text -> FULL_GAME", pickPeriodFromText("UNLV -7"), "FULL_GAME");

check("periodLabel(FIRST_QUARTER)", periodLabel("FIRST_QUARTER"), "1st quarter");
check("periodLabel(SECOND_HALF)", periodLabel("SECOND_HALF"), "2nd half");
check("periodLabel(THIRD_PERIOD)", periodLabel("THIRD_PERIOD"), "3rd period");
check("periodLabel(FIRST_HALF)", periodLabel("FIRST_HALF"), "1st half / F5");
check("periodLabel(FULL_GAME)", periodLabel("FULL_GAME"), "full game");

// (a) betDetail with no number + line present -> number appended.
check("(a) 'Athletics Under' + line 7.5 -> appended", formatPickLabel("Athletics Under", "TOTAL", 7.5), "Athletics Under 7.5");

// (b) betDetail already containing the line -> unchanged (no duplicate).
check("(b) 'Over 8.5' + line 8.5 -> unchanged", formatPickLabel("Over 8.5", "TOTAL", 8.5), "Over 8.5");
check("(b2) 'Rangers -1.5' + line -1.5 -> unchanged", formatPickLabel("Rangers -1.5", "SPREAD", -1.5), "Rangers -1.5");

// (c) no line, no number -> unchanged (caller then applies its own betType label).
check("(c) 'Athletics Under' + null line -> unchanged", formatPickLabel("Athletics Under", "TOTAL", null), "Athletics Under");
check("(c2) null betDetail -> null (caller falls back to betType label)", formatPickLabel(null, "TOTAL", null), null);
check("(c3) empty betDetail -> null", formatPickLabel("", "MONEYLINE", null), null);

// (d) spread with a positive line -> sign preserved on append.
check("(d) 'Rangers' + SPREAD line 1.5 -> '+1.5' appended", formatPickLabel("Rangers", "SPREAD", 1.5), "Rangers +1.5");
check("(d2) 'Rangers' + SPREAD line -1.5 -> '-1.5' appended", formatPickLabel("Rangers", "SPREAD", -1.5), "Rangers -1.5");

// (e) o/u shorthand already in the text -> extractLine recognizes it -> unchanged.
check("(e) 'Rangers u8.5' + line 8.5 -> unchanged (no double)", formatPickLabel("Rangers u8.5", "TOTAL", 8.5), "Rangers u8.5");

// (f) team total -> plain number appended.
check("(f) 'Yankees TT Under' + TEAM_TOTAL line 4.5 -> appended", formatPickLabel("Yankees TT Under", "TEAM_TOTAL", 4.5), "Yankees TT Under 4.5");

// (g) spelled-out number already in the text -> extractLine recognizes it -> unchanged.
check("(g) 'Under nine' + line 9 -> unchanged", formatPickLabel("Under nine", "TOTAL", 9), "Under nine");

// Known edge (documented): digits inside a team name make extractLine's legacy
// bare-number fallback treat the text as already having a line, so nothing is
// appended. Rare for a total; matches the literal "text has a digit" reading.
check("(edge) '76ers Under' + line 218.5 -> unchanged (digits in team name)", formatPickLabel("76ers Under", "TOTAL", 218.5), "76ers Under");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
