// Proof that an over/under with NO side chosen ("o/u 6.5") is never given one.
// The importer read "Leafs/Oilers o/u 6.5" as an UNDER (its "u 6.5" matched the
// under shorthand after the slash); the grader read "o/u6.5" as an under and
// "over/under 6.5" as an over. Now:
//   1. totalSideFromText: the o/u MARKET names no side, in every spelling and case;
//   2. a side word or o6.5 / u6.5 shorthand outside the marker still names the side;
//   3. isSidelessOverUnder is true only for the market with no side - a trailing bare
//      "o" / "u" is not a side (it can mean units);
//   4. the importer declines a sideless line to `unresolved` (never a pick), and keeps
//      every near-miss form as it was;
//   5. the recovery pass and parseFallbackBetText do not recover it as a spread.
// Pure: no DB. Run with:
//   npx tsx src/server/data/o-u-no-side-acceptance-test.ts
import { totalSideFromText, isSidelessOverUnder } from "@/lib/bet-line";
import { parseCatalog } from "@/lib/parse-catalog";
import { parseFallbackBetText } from "@/lib/live-team-fallback";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const imported = (line: string) => {
  const out = parseCatalog("Test Capper\n\n" + line, []);
  const p = out.picks[0];
  return { pick: p ? { betType: p.betType, totalSide: p.totalSide ?? null } : null, unresolved: out.unresolved };
};

// Every spelling of the market with no side chosen, any case.
const SIDELESS = [
  "o/u 6.5", "O/U 6.5", "o/U 6.5", "o/u6.5", "O/U6.5", "o / u 6.5", "o-u 6.5", "ov/un 6.5", "OV/UN 6.5",
  "over/under 6.5", "Over/Under 6.5", "OVER/UNDER 6.5", "over / under 6.5", "over/under6.5",
  "Leafs/Oilers o/u 6.5", "Leafs/Oilers O/U 6.5", "Leafs/Oilers o/u6.5", "Leafs/Oilers O/U6.5", "Leafs/Oilers over/under 6.5",
  "Leafs/Oilers o/u 6.5 -110", "Leafs/Oilers o/u 6.5 2u", "Leafs/Oilers 6.5 o/u",
  "Ole Miss TT o/u 24.5", "Ole Miss team total o/u 24.5", "Ole Miss TT over/under 24.5",
  // a side given only as a bare trailing letter: can mean units, so not a side
  "Leafs/Oilers o/u 6.5 u", "Leafs/Oilers o/u 6.5 o", "Leafs/Oilers O/U 6.5 U", "Ole Miss TT o/u 24.5 u",
];

// ---- 1. The grader reads no side from the market ----
for (const t of SIDELESS) expect(`no side: ${JSON.stringify(t)}`, totalSideFromText(t), null);
for (const t of SIDELESS) expect(`flagged sideless: ${JSON.stringify(t)}`, isSidelessOverUnder(t), true);

// ---- 2. A side stated outside the marker is still read ----
const WITH_SIDE: [string, "OVER" | "UNDER"][] = [
  ["Leafs/Oilers o/u 6.5 over", "OVER"], ["Leafs/Oilers O/U 6.5 OVER", "OVER"], ["Leafs/Oilers o/u 6.5 under", "UNDER"],
  ["Leafs/Oilers o/u 6.5 -110 under", "UNDER"], ["Leafs/Oilers over 6.5", "OVER"], ["Leafs/Oilers under 6.5", "UNDER"],
  ["Leafs/Oilers OVER 6.5", "OVER"], ["Leafs/Oilers UNDER 6.5", "UNDER"],
  ["o6.5", "OVER"], ["O6.5", "OVER"], ["u6.5", "UNDER"], ["U6.5", "UNDER"], ["O 6.5", "OVER"], ["U 6.5", "UNDER"],
  ["Leafs/Oilers o6.5", "OVER"], ["Leafs/Oilers u6.5", "UNDER"],
  ["Ole Miss TT o24.5", "OVER"], ["Ole Miss TT u24.5", "UNDER"], ["Ole Miss TT over 24.5", "OVER"], ["Ole Miss team total under 24.5", "UNDER"],
  ["Ole Miss TT o/u 24.5 over", "OVER"], ["Ole Miss TT o/u 24.5 under", "UNDER"],
];
for (const [t, side] of WITH_SIDE) {
  expect(`side: ${JSON.stringify(t)}`, totalSideFromText(t), side);
  expect(`not sideless: ${JSON.stringify(t)}`, isSidelessOverUnder(t), false);
}

// ---- 3. Near misses that must NOT change ----
for (const t of ["Outlook 5", "Utah 5", "2u 5", "Leafs ML 2u", "Leafs ML", "Leafs -1.5", "Ohio State 6", "Unit 5", "Ovation 5", "Leafs/Oilers 6.5 u", "Leafs/Oilers 6.5 2u"]) {
  expect(`not a side: ${JSON.stringify(t)}`, totalSideFromText(t), null);
  expect(`not flagged sideless (no market token): ${JSON.stringify(t)}`, isSidelessOverUnder(t), false);
}

// ---- 4. Import: sideless lines are declined, never a pick ----
for (const t of SIDELESS.filter((x) => /[a-z]{4,}\/|TT|team total/i.test(x))) {
  const r = imported(t);
  expect(`import declines ${JSON.stringify(t)} (no pick)`, r.pick, null);
  expect(`import declines ${JSON.stringify(t)} (left in unresolved)`, r.unresolved, [t]);
}
// Same declined line, with nothing before it (no team named).
for (const t of ["o/u 6.5", "O/U 6.5", "o/u6.5", "over/under 6.5"]) {
  const r = imported(t);
  expect(`import: bare ${JSON.stringify(t)} is never a pick`, r.pick, null);
}
// Lines that state a side import as before.
const TOTAL = (totalSide: "over" | "under") => ({ betType: "TOTAL", totalSide });
const TEAM_TOTAL = (totalSide: "over" | "under") => ({ betType: "TEAM_TOTAL", totalSide });
for (const [t, want] of [
  ["Leafs/Oilers o6.5", TOTAL("over")], ["Leafs/Oilers O6.5", TOTAL("over")], ["Leafs/Oilers u6.5", TOTAL("under")], ["Leafs/Oilers U 6.5", TOTAL("under")],
  ["Leafs/Oilers over 6.5", TOTAL("over")], ["Leafs/Oilers under 6.5", TOTAL("under")], ["Leafs/Oilers OVER 6.5", TOTAL("over")],
  ["Leafs/Oilers o/u 6.5 over", TOTAL("over")], ["Leafs/Oilers o/u 6.5 under", TOTAL("under")], ["Leafs/Oilers O/U 6.5 UNDER", TOTAL("under")],
  ["Ole Miss TT o24.5", TEAM_TOTAL("over")], ["Ole Miss TT u24.5", TEAM_TOTAL("under")], ["Ole Miss team total over 24.5", TEAM_TOTAL("over")],
  ["Ole Miss TT o/u 24.5 under", TEAM_TOTAL("under")],
] as const) {
  expect(`import keeps ${JSON.stringify(t)}`, imported(t).pick, want);
}
expect("import: 'Leafs ML 2u' is still a moneyline", imported("Leafs ML 2u").pick, { betType: "MONEYLINE", totalSide: null });
expect("import: 'Leafs ML' is still a moneyline", imported("Leafs ML").pick, { betType: "MONEYLINE", totalSide: null });

// ---- 5. Fallback parser and recovery pass ----
for (const t of ["Leafs o/u 6.5", "Leafs O/U6.5", "Leafs over/under 6.5"]) {
  expect(`fallback parser reads no side: ${JSON.stringify(t)}`, parseFallbackBetText(t).totalSide ?? null, null);
}
expect("fallback parser: sides still read", ["Leafs o6.5", "Leafs u6.5", "Leafs over 6.5", "Leafs o/u 6.5 under"].map((l) => parseFallbackBetText(l).totalSide), ["over", "under", "over", "under"]);
const LIVE = [{ sport: "NCAAF", name: "VMI Keydets" }];
{
  const sided = recoverUnresolvedLines(["VMI over 24.5"], ["Test Capper"], LIVE, []);
  expect("recovery: a sided line on a live team is recovered (the control)", sided.recovered.map((p) => [p.betType, p.totalSide]), [["TOTAL", "over"]]);
  for (const t of ["VMI o/u 24.5", "VMI O/U24.5", "VMI over/under 24.5", "VMI o/u 24.5 u"]) {
    const r = recoverUnresolvedLines([t], ["Test Capper"], LIVE, []);
    expect(`recovery declines ${JSON.stringify(t)} (no pick)`, r.recovered, []);
    expect(`recovery declines ${JSON.stringify(t)} (still unresolved)`, r.stillUnresolved, [t]);
    expect(`recovery declines ${JSON.stringify(t)} (says why)`, /no side/i.test(r.reasons[t] ?? ""), true);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
