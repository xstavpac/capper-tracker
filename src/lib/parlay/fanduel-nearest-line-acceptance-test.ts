// Proof for Send to FanDuel's nearest-line rule: a player prop, or a basketball /
// football spread or full-game total, goes at the nearest line FanDuel has (no cap),
// flagged better / worse / same with its signed distance. NHL / MLB totals and every
// period total keep their caps, the puck / run line stays exact-only, and a player
// FanDuel doesn't have is still "Not found". Pure: no DB, no network.
// Run with:
//   npx tsx src/lib/parlay/fanduel-nearest-line-acceptance-test.ts
import { formatLineDistance } from "@/components/parlay/send-to-fanduel";
import { lineMoveCap, lineQuality, matchFanDuelOutcome, type FanDuelMarket } from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

let n = 100;
const out = (name: string, point: number, description?: string) => ({ name, description, point, price: -110, sid: String(++n) });
const market = (key: string, outcomes: ReturnType<typeof out>[]): FanDuelMarket => ({ key, sid: "42." + ++n, outcomes });
const adj = (r: ReturnType<typeof matchFanDuelOutcome>) =>
  r.status === "adjusted" ? [r.status, r.fanDuelLine, r.worse, r.quality] : [r.status];

const OVER = { marketKeys: ["player_rebounds"], outcomeName: "Over", player: { name: "Sam Hauser", sportKey: "basketball_nba" }, maxLineMove: Infinity, easier: "lower" as const };
const rebounds = (points: number[]) => [market("player_rebounds", points.map((p) => out("Over", p, "Sam Hauser")))];

// ---- exact line still sent normally ----
check("exact line: matched, no flag", matchFanDuelOutcome({ ...OVER, point: 1.5 }, rebounds([0.5, 1.5, 2.5])).status, "matched");

// ---- the production cases: far prop lines are sent, not rejected ----
check("Sam Hauser Over 1.5, FanDuel only 2.5: sent at 2.5, worse (Over at a higher number)", adj(matchFanDuelOutcome({ ...OVER, point: 1.5 }, rebounds([2.5]))), ["adjusted", 2.5, true, "worse"]);
const mitchell = [market("player_points", [out("Over", 12.5, "Davion Mitchell")])];
check(
  "Davion Mitchell Over 7.5, FanDuel only 12.5: sent at 12.5 (5.0 away), worse",
  adj(matchFanDuelOutcome({ ...OVER, marketKeys: ["player_points"], player: { name: "Davion Mitchell", sportKey: "basketball_nba" }, point: 7.5 }, mitchell)),
  ["adjusted", 12.5, true, "worse"]
);

// ---- closest above vs below ----
check("Over 5: lines 3.5 and 9.5 -> nearest below (1.5 away), better", adj(matchFanDuelOutcome({ ...OVER, point: 5 }, rebounds([3.5, 9.5]))), ["adjusted", 3.5, false, "better"]);
check("Over 5: lines 4.5 and 5.5 tie -> the easier (lower) 4.5", adj(matchFanDuelOutcome({ ...OVER, point: 5 }, rebounds([4.5, 5.5]))), ["adjusted", 4.5, false, "better"]);
check("Over 5: lines 1.5 and 5.5 -> nearest above (0.5 away), worse", adj(matchFanDuelOutcome({ ...OVER, point: 5 }, rebounds([1.5, 5.5]))), ["adjusted", 5.5, true, "worse"]);
const UNDER = { ...OVER, outcomeName: "Under", easier: "higher" as const };
const under = (points: number[]) => [market("player_rebounds", points.map((p) => out("Under", p, "Sam Hauser")))];
check("Under 5: nearest above is better, nearest below is worse", [adj(matchFanDuelOutcome({ ...UNDER, point: 5 }, under([6.5, 1.5]))), adj(matchFanDuelOutcome({ ...UNDER, point: 5 }, under([4.5, 12.5])))], [["adjusted", 6.5, false, "better"], ["adjusted", 4.5, true, "worse"]]);

// ---- quality + distance ----
check("lineQuality", [lineQuality(5, 5, "lower"), lineQuality(5, 6, "lower"), lineQuality(5, 4, "lower"), lineQuality(5, 6, "higher"), lineQuality(5, 4, "higher"), lineQuality(5, 4, undefined)], ["same", "worse", "better", "better", "worse", "same"]);
check("distance text is signed and one decimal", [formatLineDistance(5), formatLineDistance(-0.5), formatLineDistance(1.25)], ["5.0 higher", "0.5 lower", "1.3 higher"]);

// ---- uncapped scope: only props and basketball / football full-game totals and spreads ----
check(
  "caps: NBA/NFL totals + spreads + props uncapped; hockey / MLB totals, every period total 0.5; puck / run line 0",
  [
    lineMoveCap("basketball_nba", "totals", ""),
    lineMoveCap("basketball_nba", "spreads", ""),
    lineMoveCap("americanfootball_nfl", "totals", "_h1"),
    lineMoveCap("icehockey_nhl", "totals", ""),
    lineMoveCap("baseball_mlb", "totals", ""),
    lineMoveCap("icehockey_nhl", "spreads", ""),
    lineMoveCap("baseball_mlb", "spreads", ""),
  ],
  [Infinity, Infinity, 0.5, 0.5, 0.5, 0, 0]
);
const totals = [market("totals", [out("Over", 11.5)])];
check(
  "hockey total capped at 0.5 still refuses a 1.5 move: Line unavailable",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Over", point: 13, maxLineMove: lineMoveCap("icehockey_nhl", "totals", ""), easier: "lower" }, totals).status,
  "line_unavailable"
);
const spreads = [market("spreads", [out("Detroit Red Wings", -2.5)])];
check(
  "puck line stays exact-only: -1.5 against a -2.5 ladder is Line unavailable",
  matchFanDuelOutcome({ marketKeys: ["spreads"], outcomeName: "Detroit Red Wings", point: -1.5, maxLineMove: lineMoveCap("icehockey_nhl", "spreads", ""), easier: "higher" }, spreads).status,
  "line_unavailable"
);

// ---- "Not found" untouched: a player FanDuel doesn't list never gets a nearest line ----
check(
  "unmatched player (Khaman Maluach): Not found, no line substituted from another player",
  matchFanDuelOutcome({ ...OVER, player: { name: "Khaman Maluach", sportKey: "basketball_nba" }, point: 4.5 }, rebounds([2.5])).status,
  "not_found"
);
check("a different market is never substituted", matchFanDuelOutcome({ ...OVER, marketKeys: ["player_assists"], point: 1.5 }, rebounds([2.5])).status, "market_unavailable");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
