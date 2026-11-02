// The Over/Under tile a TOTAL pick counts toward must be the side it was graded
// on. pickCategory (stats.ts) used to look for "over"/"under" in the raw text
// while the grader read it with totalSideFromText (bet-line.ts), so "o/u 5.5 under"
// was filed OVER and graded UNDER, and "u5.5" / "o5.5" had no tile at all.
// pickCategory now calls totalSideFromText itself.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/total-category-side-acceptance-test.ts
import { pickCategory } from "@/server/data/stats";
import { gradePick } from "@/server/data/grading";
import { totalSideFromText } from "@/lib/bet-line";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type Input = Parameters<typeof pickCategory>[0];
const total = (betDetail: string | null, over: Partial<Input> = {}): Input => ({
  betType: "TOTAL",
  period: "FULL_GAME",
  betDetail,
  odds: -110,
  line: null,
  sportName: "NHL",
  pickedSide: null,
  mlFavoredSide: null,
  oddsSource: null,
  propMarket: null,
  ...over,
});

// The cases named in the request, full game.
const NAMED: [string, string | null, "OVER" | "UNDER" | null][] = [
  ["o/u 5.5 under", "o/u 5.5 under", "UNDER"],
  ["o/u 5.5 over", "o/u 5.5 over", "OVER"],
  ["O/U 5.5 Under", "O/U 5.5 Under", "UNDER"],
  ["over/under 5.5 under", "over/under 5.5 under", "UNDER"],
  ["u5.5", "u5.5", "UNDER"],
  ["o5.5", "o5.5", "OVER"],
  ["u 5.5", "u 5.5", "UNDER"],
  ["Over 5.5", "Over 5.5", "OVER"],
  ["Under 5.5", "Under 5.5", "UNDER"],
  ["bare line", "5.5", null],
  ["sideless over/under market", "Over/Under 5.5", null],
  ["null text", null, null],
];
for (const [label, text, side] of NAMED) {
  check(`full game: ${label}`, pickCategory(total(text)), side);
  check(`full game: ${label} reads like the grader`, totalSideFromText(text), side);
}

// Every period / sport the TOTAL branch splits by: the category's side is always the grader's side.
const PERIODS: [Input["period"], string][] = [
  ["FULL_GAME", ""],
  ["FIRST_HALF", "_"],
  ["FIRST_PERIOD", "_"],
  ["SECOND_QUARTER", "_"],
];
for (const sportName of ["MLB", "NFL", "NHL", "NBA"]) {
  for (const [period] of PERIODS) {
    for (const [, text] of NAMED) {
      const cat = pickCategory(total(text, { period, sportName }));
      const side = totalSideFromText(text);
      const catSide = cat === null ? null : cat.endsWith("OVER") ? "OVER" : cat.endsWith("UNDER") ? "UNDER" : "?";
      if (catSide !== side) check(`${sportName} ${period} ${JSON.stringify(text)}: category side equals the grader's`, catSide, side);
    }
  }
}
check("MLB first half keeps its F5 keys", [pickCategory(total("F5 o5.5", { period: "FIRST_HALF", sportName: "MLB" })), pickCategory(total("F5 u5.5", { period: "FIRST_HALF", sportName: "MLB" }))], ["F5_OVER", "F5_UNDER"]);
check("NHL period keeps its segment keys", [pickCategory(total("P1 o1.5", { period: "FIRST_PERIOD" })), pickCategory(total("P1 u1.5", { period: "FIRST_PERIOD" }))], ["FIRST_PERIOD_OVER", "FIRST_PERIOD_UNDER"]);

// Grading and the tile agree on a real result: 4 goals vs a 5.5 line.
for (const [text, expectedGrade, expectedCat] of [
  ["o/u 5.5 under", "WIN", "UNDER"],
  ["u5.5", "WIN", "UNDER"],
  ["o5.5", "LOSS", "OVER"],
  ["Over 5.5", "LOSS", "OVER"],
] as const) {
  check(`4 goals vs ${text}: graded ${expectedGrade}`, gradePick("TOTAL", text, 5.5, "Home", "Away", 2, 2, null), expectedGrade);
  check(`4 goals vs ${text}: tile ${expectedCat}`, pickCategory(total(text)), expectedCat);
}

// Team totals are one tile whatever the text says.
for (const text of ["Yankees team total over 4.5", "Yankees TT u4.5", "Yankees team total o/u 4.5 under", "TT 4.5"]) {
  check(`TEAM_TOTAL ${JSON.stringify(text)} -> TEAM_TOTAL`, pickCategory(total(text, { betType: "TEAM_TOTAL", sportName: "MLB" })), "TEAM_TOTAL");
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
