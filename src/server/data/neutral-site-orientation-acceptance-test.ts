// Picks must reach their card when the pick's home/away is the reverse of the card's -
// run with:
//   npx tsx src/server/data/neutral-site-orientation-acceptance-test.ts
//
// Neutral-site games have no true home team: ESPN (which resolves a pick's teams at
// import) and the Odds API (the /live card) pick differently. 2026-11-19, Auburn vs
// Notre Dame (Michelob ULTRA Arena): ESPN home = Auburn, Odds API home = Notre Dame, so
// all 8 picks matched no card (Games panel: "No logged picks"). Same for UNLV/Rutgers
// and Seton Hall/Wisconsin. console.logs PASS/FAIL, exits non-zero on any failure.

import { matchPicksToGame, orientPickToGame } from "./picks";
import { liveGameHref } from "@/lib/pick-game-link";
import { findBoardGameForPick } from "@/lib/parlay/off-board-game";
import { classifyPickTeamGroup } from "@/lib/pick-team-group";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
}

const T = new Date("2026-11-19T22:00:00Z");
const pick = (o: Record<string, unknown>) => ({
  id: "p1", homeTeam: "Auburn Tigers", awayTeam: "Notre Dame Fighting Irish", betType: "SPREAD",
  betDetail: "Auburn Tigers -3.5", pickedSide: "HOME" as string | null, mlFavoredSide: null as string | null, gameTime: T, ...o,
});
const ndHomeCard = { homeTeam: "Notre Dame Fighting Irish", awayTeam: "Auburn Tigers", commenceTime: T };
const auburnHomeCard = { homeTeam: "Auburn Tigers", awayTeam: "Notre Dame Fighting Irish", commenceTime: T };

// 1. The reported case: pick Auburn-home, card ND-home.
const flipped = matchPicksToGame([pick({})], ndHomeCard, "NCAAB");
expect("flipped orientation reaches the card", flipped.length, 1);
expect("flipped pick is re-oriented to the card", [flipped[0]?.homeTeam, flipped[0]?.awayTeam], ["Notre Dame Fighting Irish", "Auburn Tigers"]);
expect("pickedSide mirrored (Auburn was HOME, is now AWAY)", flipped[0]?.pickedSide, "AWAY");
expect("grouped under Auburn (AWAY on this card), not Notre Dame",
  classifyPickTeamGroup({ ...flipped[0], pickedSide: flipped[0].pickedSide as "HOME" | "AWAY" | null }, ndHomeCard, "NCAAB"), "AWAY");

// 2. Same orientation is untouched (same object, no copy).
const p = pick({});
const same = matchPicksToGame([p], auburnHomeCard, "NCAAB");
expect("same orientation still matches", same.length, 1);
expect("same orientation returns the original object", same[0] === p, true);

// 3. Mirrored copy is stable per pick (assignPicksToNearestGame keys by identity).
expect("one mirrored copy per pick",
  orientPickToGame(p, ndHomeCard, "basketball_ncaab") === orientPickToGame(p, ndHomeCard, "basketball_ncaab"), true);

// 4. Drift and team-pair guards still apply to the flipped branch.
expect("flipped but >6h away: no match",
  matchPicksToGame([pick({ gameTime: new Date("2026-11-20T22:00:00Z") })], ndHomeCard, "NCAAB").length, 0);
expect("different team pair: no match",
  matchPicksToGame([pick({ homeTeam: "Auburn Tigers", awayTeam: "Duke Blue Devils", betDetail: "Auburn -3.5" })], ndHomeCard, "NCAAB").length, 0);

// 5. mlFavoredSide mirrors too; null sides stay null.
const ml = matchPicksToGame([pick({ betType: "MONEYLINE", pickedSide: "AWAY", mlFavoredSide: "HOME" })], ndHomeCard, "NCAAB")[0];
expect("moneyline sides mirrored", [ml?.pickedSide, ml?.mlFavoredSide], ["HOME", "AWAY"]);
expect("null pickedSide stays null", matchPicksToGame([pick({ pickedSide: null })], ndHomeCard, "NCAAB")[0]?.pickedSide, null);

// 6. Other pick -> game lookups accept either orientation.
const slate = [{ id: "g1", homeTeam: "Notre Dame Fighting Irish", awayTeam: "Auburn Tigers", commenceTime: T.toISOString() }];
expect("liveGameHref finds the flipped card", liveGameHref(slate, { homeTeam: "Auburn Tigers", awayTeam: "Notre Dame Fighting Irish", gameTime: T }, "basketball_ncaab"), "/live/g1?sport=basketball_ncaab");
expect("findBoardGameForPick finds the flipped card",
  findBoardGameForPick({ homeTeam: "Auburn Tigers", awayTeam: "Notre Dame Fighting Irish", gameTime: T }, slate, "basketball_ncaab", 6 * 3600000)?.id, "g1");

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll passed");
