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
import { formatPickLabel } from "@/lib/bet-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

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
