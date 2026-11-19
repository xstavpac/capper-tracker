// A re-import of the same pick with the teams flipped is a duplicate - run with:
//   npx tsx src/lib/neutral-site-duplicates-acceptance-test.ts
//
// Neutral-site games (Auburn / Notre Dame 2026-11-19): one import resolves the game from ESPN
// (Auburn home), a later one from the Odds API (Notre Dame home). isSameBet required home-to-home,
// so Telegram auto-ingest could log the same pick twice. Side-relative parts (ML pickedSide,
// team-total HOME/AWAY key) are mirrored, so Auburn ML never collides with Notre Dame ML.

import { isSameBet, computeDuplicateFlags, type BetIdentity, type ResolvedDupCandidate } from "./duplicate-pick-detection";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const T = Date.parse("2026-11-19T22:00:00Z");
const DRIFT = 6 * 3600000;
const SK = "basketball_ncaab";
const AUB = "Auburn Tigers";
const ND = "Notre Dame Fighting Irish";
const espn = { homeTeam: AUB, awayTeam: ND, gameTimeMs: T, sportKey: SK, period: "FULL_GAME" };
const odds = { homeTeam: ND, awayTeam: AUB, gameTimeMs: T, sportKey: SK, period: "FULL_GAME" };
const bet = (o: Partial<BetIdentity>): BetIdentity => ({ ...espn, category: null, ...o });
const flippedBet = (o: Partial<BetIdentity>): BetIdentity => ({ ...odds, category: null, ...o });
const same = (a: BetIdentity, b: BetIdentity) => isSameBet(a, b, DRIFT);

// Spread / total categories are side-neutral, so flipped teams are the same bet.
check("flipped spread re-import is a duplicate", same(bet({ betType: "SPREAD", category: "SPREAD_MINUS" }), flippedBet({ betType: "SPREAD", category: "SPREAD_MINUS" })), true);
check("flipped, opposite spread side is not", same(bet({ betType: "SPREAD", category: "SPREAD_MINUS" }), flippedBet({ betType: "SPREAD", category: "SPREAD_PLUS" })), false);
check(
  "flipped total over/under",
  [same(bet({ betType: "TOTAL", category: "OVER" }), flippedBet({ betType: "TOTAL", category: "OVER" })), same(bet({ betType: "TOTAL", category: "OVER" }), flippedBet({ betType: "TOTAL", category: "UNDER" }))],
  [true, false]
);

// Moneyline compares the picked team: Auburn is HOME in one feed and AWAY in the other.
check("flipped ML on the same team is a duplicate (HOME vs AWAY)", same(bet({ betType: "MONEYLINE", pickedSide: "HOME", category: "FAV_ML" }), flippedBet({ betType: "MONEYLINE", pickedSide: "AWAY", category: "FAV_ML" })), true);
check("flipped ML on the other team is not (HOME vs HOME)", same(bet({ betType: "MONEYLINE", pickedSide: "HOME", category: "FAV_ML" }), flippedBet({ betType: "MONEYLINE", pickedSide: "HOME", category: "DOG_ML" })), false);

// Team total keys carry HOME/AWAY: Auburn under is HOME in one feed, AWAY in the other.
const tt = (category: string, pickedSide: "HOME" | "AWAY") => ({ betType: "TEAM_TOTAL" as const, category, pickedSide });
check("flipped team total, same team", same(bet(tt("TEAM_TOTAL:HOME:UNDER", "HOME")), flippedBet(tt("TEAM_TOTAL:AWAY:UNDER", "AWAY"))), true);
check("flipped team total, other team is not", same(bet(tt("TEAM_TOTAL:HOME:UNDER", "HOME")), flippedBet(tt("TEAM_TOTAL:HOME:UNDER", "HOME"))), false);
check("flipped team total, other side (over) is not", same(bet(tt("TEAM_TOTAL:HOME:UNDER", "HOME")), flippedBet(tt("TEAM_TOTAL:AWAY:OVER", "AWAY"))), false);

// Guards still apply.
check("flipped but a different period is not", same(bet({ betType: "SPREAD", category: "SPREAD_MINUS" }), flippedBet({ period: "FIRST_HALF", betType: "SPREAD", category: "SPREAD_MINUS" })), false);
check("flipped but outside the drift window is not", same(bet({ betType: "SPREAD", category: "SPREAD_MINUS" }), flippedBet({ gameTimeMs: T + DRIFT + 1, betType: "SPREAD", category: "SPREAD_MINUS" })), false);
check("unrelated teams are not", same(bet({ betType: "SPREAD", category: "SPREAD_MINUS" }), bet({ homeTeam: "Duke Blue Devils", betType: "SPREAD", category: "SPREAD_MINUS" })), false);
check("same orientation unchanged", same(bet({ betType: "MONEYLINE", pickedSide: "HOME", category: "FAV_ML" }), bet({ betType: "MONEYLINE", pickedSide: "HOME", category: "FAV_ML" })), true);

// Paste-level: the second copy, resolved the other way round, is flagged.
const cand = (index: number, o: Partial<ResolvedDupCandidate>): ResolvedDupCandidate => ({
  index,
  capperKey: "c1",
  capperName: "Cap",
  ...espn,
  category: "SPREAD_MINUS",
  betType: "SPREAD",
  description: "Auburn -3.5",
  dbDuplicateLabel: null,
  ...o,
});
const flags = computeDuplicateFlags([cand(0, {}), cand(1, { homeTeam: ND, awayTeam: AUB })], DRIFT);
check("computeDuplicateFlags flags the flipped second copy only", Object.keys(flags), ["1"]);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll passed");
