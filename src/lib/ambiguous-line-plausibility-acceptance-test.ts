// Proof for the ambiguous-nickname line-plausibility filter - run with:
//   npx tsx src/lib/ambiguous-line-plausibility-acceptance-test.ts
//
// Unit-level coverage of filterPlausibleCandidates in isolation (candidates
// in, filtered candidates out - no decision-making, see the module's own
// header comment). Integration coverage of how ambiguous-hierarchy.ts uses
// this alongside the cross-check (AGREES/NO_SIGNAL/CONFLICTS) lives in
// ambiguous-hierarchy-acceptance-test.ts's PART F instead.
//
// One case here deliberately uses a SYNTHETIC 3-candidate list (MLB + NFL +
// NHL) rather than a real AMBIGUOUS_NICKNAMES key: every real MLB/KBO
// collision today (giants, bears, twins, lions, eagles, tigers) gives MLB
// and KBO the identical run-line bound, so a real 3-way collision like
// "giants" can only ever filter down to 1 remaining candidate or leave all
// 3 untouched - never exactly 2 of 3. This case proves the underlying
// mechanism generalizes correctly (drops exactly the implausible one(s),
// keeps the rest) without waiting for a real 3-way collision with
// non-identical bounds to exist.
import type { AmbiguousOption } from "./parse-catalog";
import { filterPlausibleCandidates } from "./ambiguous-line-plausibility";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const MLB_GIANTS: AmbiguousOption = { label: "San Francisco Giants (MLB)", sport: "MLB", nickname: "san francisco giants" };
const NFL_GIANTS: AmbiguousOption = { label: "New York Giants (NFL)", sport: "NFL", nickname: "new york giants" };
const KBO_GIANTS: AmbiguousOption = { label: "Lotte Giants (KBO)", sport: "KBO", nickname: "lotte giants" };
const GIANTS = [MLB_GIANTS, NFL_GIANTS, KBO_GIANTS];

function sports(options: AmbiguousOption[]): string[] {
  return options.map((o) => o.sport).sort();
}

console.log("########## Spread magnitude bounds ##########");
{
  // A real MLB run line (+/-1.5) is well inside the bound for both MLB and
  // KBO - nothing dropped.
  check("+1.5 spread -> nothing dropped (real MLB/KBO run line)", sports(filterPlausibleCandidates(GIANTS, "SPREAD", 1.5)), sports(GIANTS));
}
{
  // Right at the bound (2.5) - still plausible, not excluded.
  check("+2.5 spread (bound edge) -> MLB/KBO still plausible", sports(filterPlausibleCandidates(GIANTS, "SPREAD", 2.5)), sports(GIANTS));
}
{
  // Past the bound - MLB and KBO both excluded, only NFL (unbounded) remains.
  check("+6.5 spread -> only NFL remains", sports(filterPlausibleCandidates(GIANTS, "SPREAD", 6.5)), ["NFL"]);
}
{
  // Negative magnitude handled the same as positive (Math.abs).
  check("-6.5 spread -> only NFL remains", sports(filterPlausibleCandidates(GIANTS, "SPREAD", -6.5)), ["NFL"]);
}
{
  // A real, large-but-plausible NFL spread is never excluded - no NFL bound
  // exists in this table at all.
  check("-24 spread (real NFL blowout line) -> NFL still remains", filterPlausibleCandidates([NFL_GIANTS], "SPREAD", -24), [NFL_GIANTS]);
}

console.log("\n########## Total line bounds ##########");
{
  check("total of 8.5 (real MLB/KBO total) -> nothing dropped", sports(filterPlausibleCandidates(GIANTS, "TOTAL", 8.5)), sports(GIANTS));
}
{
  check("total of 45.5 (real NFL total, implausible for MLB/KBO) -> only NFL remains", sports(filterPlausibleCandidates(GIANTS, "TOTAL", 45.5)), ["NFL"]);
}
{
  check("TEAM_TOTAL of 45.5 uses the same bound table as TOTAL -> only NFL remains", sports(filterPlausibleCandidates(GIANTS, "TEAM_TOTAL", 45.5)), ["NFL"]);
}

console.log("\n########## No line to filter on ##########");
{
  check("null line (moneyline) -> every candidate passes through unfiltered", filterPlausibleCandidates(GIANTS, "MONEYLINE", null), GIANTS);
}
{
  check("undefined line -> every candidate passes through unfiltered", filterPlausibleCandidates(GIANTS, "MONEYLINE", undefined), GIANTS);
}
{
  check("undefined betType -> every candidate passes through unfiltered", filterPlausibleCandidates(GIANTS, undefined, 6.5), GIANTS);
}
{
  // PLAYER_PROP/NRFI have no numeric-line bound table at all - always pass
  // through, regardless of whether a line happens to be present.
  check("PLAYER_PROP betType -> not filtered (no bound table for it)", sports(filterPlausibleCandidates(GIANTS, "PLAYER_PROP", 6.5)), sports(GIANTS));
}

console.log("\n########## Synthetic 3-candidate mix: narrows to exactly 2 of 3 (not a real AMBIGUOUS_NICKNAMES key) ##########");
{
  const NHL_OPTION: AmbiguousOption = { label: "Some Team (NHL)", sport: "NHL", nickname: "some team" };
  const mixed = [MLB_GIANTS, NFL_GIANTS, NHL_OPTION];
  // NHL has no bound in this table any more than NFL does - only the
  // MLB candidate is implausible for a +6.5 spread, so exactly 2 of the 3
  // survive: NFL and NHL, MLB dropped.
  check("+6.5 spread against MLB+NFL+NHL -> drops only MLB, leaves 2", sports(filterPlausibleCandidates(mixed, "SPREAD", 6.5)), ["NFL", "NHL"]);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
