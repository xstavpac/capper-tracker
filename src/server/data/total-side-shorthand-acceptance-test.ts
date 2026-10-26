// Proof for the over/under SHORTHAND ("o6.5", "O 6.5", "ov 5" / "u6.5", "un 5").
// Two prod picks sat PENDING for days because the grader's totalSideFromText
// only read the words "over" / "under": "LEAFS / OILERS O6.5" (TOTAL) and
// "Ole Miss TT o24.5" (TEAM_TOTAL). The importer already classified both
// correctly (and read their side), but stores the text as typed.
//   1. totalSideFromText reads every form, case-insensitively, words first;
//   2. what must NOT read as a side (units, words that merely contain o / u);
//   3. gradePick / resolveOutcome grade a TOTAL and a TEAM_TOTAL written each way
//      - including the two real picks' stored inputs;
//   4. extractLine takes the number after the shorthand, not a period digit;
//   5. the importer classifies "ov" / "un" as totals (they imported as
//      MONEYLINE), its other forms are unchanged, and ML lines are untouched;
//   6. the fallback parser and the market hint agree.
// Pure: no DB. Run with:
//   npx tsx src/server/data/total-side-shorthand-acceptance-test.ts
import { totalSideFromText, extractLine } from "@/lib/bet-line";
import { gradePick, resolveOutcome } from "@/server/data/grading";
import { parseCatalog } from "@/lib/parse-catalog";
import { parseFallbackBetText } from "@/lib/live-team-fallback";
import { computeMarketHint } from "@/lib/market-hint";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const OVERS = ["O6.5", "o6.5", "O 6.5", "o 6.5", "ov 6.5", "OV 6.5", "Ov. 6.5", "ov6.5", "Leafs / Oilers O6.5 -110", "Ole Miss TT o24.5", "(o6.5)", "Leafs/Oilers/o6.5"];
const UNDERS = ["U6.5", "u6.5", "U 6.5", "u 6.5", "un 6.5", "UN 6.5", "Un. 6.5", "un6.5", "Leafs / Oilers U6.5 -110", "Ole Miss TT u24.5", "(u6.5)", "Leafs/Oilers/u6.5"];

// ---- 1. Every form, both sides ----
for (const t of OVERS) expect(`over: ${JSON.stringify(t)}`, totalSideFromText(t), "OVER");
for (const t of UNDERS) expect(`under: ${JSON.stringify(t)}`, totalSideFromText(t), "UNDER");
expect("the words still work", [totalSideFromText("Over 6.5"), totalSideFromText("under 6.5"), totalSideFromText("Leafs OVER 6")], ["OVER", "UNDER", "OVER"]);
expect("a word beats a shorthand in the same text (as before: over first, words first)", [totalSideFromText("over 5 u3"), totalSideFromText("under 5 o3")], ["OVER", "UNDER"]);
expect("null text", totalSideFromText(null), null);

// ---- 2. What is not a side ----
for (const t of ["Outlook 5", "Utah 5", "Oakland 5", "Ohio State 6", "2u 5", "1.5u", "Pro 5", "Cubs -1.5", "TT 3.5", "Leafs ML", "o", "u", "ov", "un", "o/u 6.5", "O/U 6.5", "ov/un 6.5", "Leafs/Oilers o/u 6.5 -110", "Unit 5", "Ovation 5"]) {
  expect(`not a side: ${JSON.stringify(t)}`, totalSideFromText(t), null);
}

// ---- 3. Grading ----
// NHL: Toronto @ Edmonton, 4-3 (7 total). NCAAF: Ole Miss (away) 27, Texas 30.
for (const t of OVERS.slice(0, 11).filter((x) => !/TT/.test(x))) {
  expect(`TOTAL over 6.5 on 7 goals: ${JSON.stringify(t)}`, gradePick("TOTAL", t, 6.5, "Edmonton Oilers", "Toronto Maple Leafs", 3, 4, null), "WIN");
}
for (const t of UNDERS.filter((x) => !/TT/.test(x))) {
  expect(`TOTAL under 6.5 on 7 goals: ${JSON.stringify(t)}`, gradePick("TOTAL", t, 6.5, "Edmonton Oilers", "Toronto Maple Leafs", 3, 4, null), "LOSS");
}
expect("TOTAL o6.5 pushes on exactly 6.5? (no: 7 > 6.5) - o7 pushes on 7", gradePick("TOTAL", "Leafs/Oilers o7", 7, "Edmonton Oilers", "Toronto Maple Leafs", 3, 4, null), "PUSH");
for (const [t, want] of [["Ole Miss TT o24.5", "WIN"], ["Ole Miss TT O 24.5", "WIN"], ["Ole Miss TT ov 24.5", "WIN"], ["Ole Miss TT u24.5", "LOSS"], ["Ole Miss TT un 24.5", "LOSS"], ["Ole Miss TT U 24.5", "LOSS"]] as const) {
  expect(`TEAM_TOTAL, Ole Miss 27 vs 24.5: ${JSON.stringify(t)}`, gradePick("TEAM_TOTAL", t, 24.5, "Texas Longhorns", "Ole Miss Rebels", 30, 27, "AWAY"), want);
}
// The two real prod picks, with the inputs read from prod (line, pickedSide) on 2026-10-26.
const game = (homeTeam: string, awayTeam: string, homeScore: number, awayScore: number) => ({
  homeTeam,
  awayTeam,
  homeScore,
  awayScore,
  firstFiveHomeScore: null,
  firstFiveAwayScore: null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: null,
});
expect(
  "prod pick: NHL TOTAL 'LEAFS / OILERS O6.5' line 6.5, no side - grades from its text",
  resolveOutcome({ betType: "TOTAL", period: "FULL_GAME", betDetail: "LEAFS / OILERS O6.5", homeTeam: "Edmonton Oilers", line: 6.5, pickedSide: null }, game("Edmonton Oilers", "Toronto Maple Leafs", 3, 4)),
  "WIN"
);
expect(
  "prod pick: NCAAF TEAM_TOTAL 'Ole Miss TT o24.5' line 24.5, side AWAY - grades from its text",
  resolveOutcome({ betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Ole Miss TT o24.5", homeTeam: "Texas Longhorns", line: 24.5, pickedSide: "AWAY" }, game("Texas Longhorns", "Ole Miss Rebels", 30, 27)),
  "WIN"
);

// ---- 4. extractLine ----
expect("extractLine: shorthand with a space, 'ov', 'un'", [extractLine("TOTAL", "Leafs/Oilers o 6.5"), extractLine("TOTAL", "Leafs/Oilers ov 6.5"), extractLine("TOTAL", "Leafs/Oilers un 6.5")], [6.5, 6.5, 6.5]);
expect("extractLine: the shorthand's number, not a period digit", [extractLine("TOTAL", "First 5 ov 4.5"), extractLine("TOTAL", "1st Half un 19.5")], [4.5, 19.5]);
expect("extractLine: existing forms unchanged", [extractLine("TOTAL", "Over 8.5"), extractLine("TOTAL", "u220"), extractLine("TOTAL", "under nine"), extractLine("TEAM_TOTAL", "Ole Miss TT o24.5")], [8.5, 220, 9, 24.5]);

// ---- 5. Import classification ----
const parsed = (line: string) => {
  const p = parseCatalog("Test Capper\n\n" + line, []).picks[0];
  return p ? { betType: p.betType, totalSide: p.totalSide ?? null } : null;
};
for (const t of ["Leafs/Oilers O6.5", "Leafs/Oilers o 6.5", "Leafs/Oilers ov 6.5", "Toronto Maple Leafs / Edmonton Oilers OV 6.5"]) {
  expect(`import: ${JSON.stringify(t)} is a TOTAL over`, parsed(t), { betType: "TOTAL", totalSide: "over" });
}
for (const t of ["Leafs/Oilers U6.5", "Leafs/Oilers u 6.5", "Leafs/Oilers un 6.5", "Toronto Maple Leafs / Edmonton Oilers UN 6.5"]) {
  expect(`import: ${JSON.stringify(t)} is a TOTAL under`, parsed(t), { betType: "TOTAL", totalSide: "under" });
}
expect("import: team total shorthand", [parsed("Ole Miss TT o24.5"), parsed("Ole Miss TT un 24.5")], [{ betType: "TEAM_TOTAL", totalSide: "over" }, { betType: "TEAM_TOTAL", totalSide: "under" }]);
expect("import: the words are unchanged", [parsed("Leafs/Oilers over 6.5"), parsed("Leafs/Oilers under 6.5")], [{ betType: "TOTAL", totalSide: "over" }, { betType: "TOTAL", totalSide: "under" }]);
expect("import: a moneyline is still a moneyline", parsed("Leafs ML"), { betType: "MONEYLINE", totalSide: null });
expect("import: units are not a side ('Leafs ML 2u')", parsed("Leafs ML 2u"), { betType: "MONEYLINE", totalSide: null });

// ---- 6. The other two readers ----
expect("fallback parser: o/u/ov/un", ["Leafs o6.5", "Leafs ov 6.5", "Leafs u6.5", "Leafs un 6.5"].map((l) => parseFallbackBetText(l).totalSide), ["over", "over", "under", "under"]);
expect("fallback parser: no side for a plain team line", parseFallbackBetText("Leafs ML").totalSide ?? null, null);
expect("market hint: ov / un read as over/under", [computeMarketHint("Leafs/Oilers ov 6.5"), computeMarketHint("Leafs/Oilers un 6.5")], ["over/under", "over/under"]);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
