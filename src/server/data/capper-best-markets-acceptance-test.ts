// The capper page banner's two market stats (bestMarketsOf / bestMarketStats in capper-detail.ts):
// MOST PROFITABLE is the market-breakdown tile with the most plain net units, HIGHEST WIN % the one
// with the best wins / (wins + losses). No sample adjustment and no minimum sample; the same market
// winning both collapses to one "Best market". Pure - the tiles are built by the breakdown's own
// categoryBreakdownFromCounts, so a win % here is the number the tile shows.
import { DEFAULT_CHIP_SET, categoryBreakdownFromCounts } from "@/server/data/stats";
import { bestMarketStats, bestMarketsOf } from "@/server/data/capper-detail";

let failures = 0;
let assertions = 0;
function check(label: string, pass: boolean, detail = "") {
  assertions++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// One tile row: record plus the units won / lost behind it (as categoryTilesSelect returns them).
type Row = { category: string; wins: number; losses: number; pushes: number; unitsWon: number; unitsLost: number };
const row = (category: string, wins: number, losses: number, pushes: number, unitsWon: number, unitsLost: number): Row => ({ category, wins, losses, pushes, unitsWon, unitsLost });
const best = (rows: Row[]) => bestMarketsOf(categoryBreakdownFromCounts(rows, DEFAULT_CHIP_SET), rows);
const keys = (rows: Row[]) => {
  const b = best(rows);
  return b ? `${b.mostProfitable.key}/${b.highestWinPct?.key ?? "none"}` : "null";
};
const labels = (rows: Row[]) => {
  const b = best(rows);
  return b ? bestMarketStats(b).map((s) => `${s.label}:${s.market.label}:${s.lead}`).join(" | ") : "";
};

{
  // The Cheese shape: spreads hit 57% and make the money, favorites hit 67% for next to nothing.
  const cheese = [row("FAV_ML", 10, 5, 0, 5.2, 5), row("SPREAD_MINUS", 20, 15, 0, 25, 15), row("OVER", 4, 6, 1, 3.6, 6)];
  const b = best(cheese)!;
  check("cheese: most profitable is Spread - (+10u at 57%)", b.mostProfitable.label === "Spread -" && b.mostProfitable.netUnits === 10 && Math.round(b.mostProfitable.winPct) === 57, JSON.stringify(b.mostProfitable));
  check("cheese: highest win % is Fav ML (67% at +0.2u)", b.highestWinPct?.label === "Fav ML" && Math.round(b.highestWinPct.winPct) === 67 && b.highestWinPct.netUnits === 0.2, JSON.stringify(b.highestWinPct));
  check("cheese: two stats, units leading the first and win % the second", labels(cheese) === "Most profitable:Spread -:units | Highest win %:Fav ML:winPct", labels(cheese));
  check("cheese: each stat carries the tile's own record", b.mostProfitable.wins === 20 && b.mostProfitable.losses === 15 && b.highestWinPct!.wins === 10 && b.highestWinPct!.losses === 5);
}
{
  // No sample adjustment, no minimum sample: one graded pick can win either stat.
  const small = [row("FAV_ML", 50, 30, 0, 30, 30), row("DOG_ML", 1, 0, 0, 2.5, 0), row("UNDER", 40, 20, 0, 22, 20)];
  check("no sample rule: a 1-0 market is the highest win % and (at +2.5u) the most profitable", keys(small) === "DOG_ML/DOG_ML", keys(small));
  // Under the old netUnits / (graded + 20) rule OVER (0.19) beat UNDER (0.18); plain units say UNDER.
  const shrunk = [row("OVER", 3, 0, 0, 4.4, 0), row("UNDER", 30, 26, 0, 40, 26)];
  check("no sample rule: +14u on 56 picks beats +4.4u on 3", best(shrunk)!.mostProfitable.key === "UNDER", keys(shrunk));
}
{
  // The same market wins both: one "Best market".
  const same = [row("FAV_ML", 6, 6, 0, 4, 6), row("SPREAD_PLUS", 14, 6, 1, 13, 6)];
  check("collapse: one market wins both", keys(same) === "SPREAD_PLUS/SPREAD_PLUS", keys(same));
  check("collapse: a single Best market stat", labels(same) === "Best market:Spread +:units", labels(same));
}
{
  // Most profitable ties: higher win %, then more graded picks, then the tiles' own order.
  const byPct = [row("FAV_ML", 5, 5, 0, 8, 5), row("DOG_ML", 6, 4, 0, 7, 4), row("OVER", 9, 1, 0, 2, 1)];
  check("most profitable tie (+3u each): the higher win % wins", best(byPct)!.mostProfitable.key === "DOG_ML", keys(byPct));
  const byGraded = [row("FAV_ML", 3, 3, 0, 5, 3), row("DOG_ML", 6, 6, 0, 8, 6), row("OVER", 6, 6, 2, 8, 6)];
  check("most profitable tie (+2u, 50% each): more graded picks wins, pushes counted", best(byGraded)!.mostProfitable.key === "OVER", keys(byGraded));
  const byOrder = [row("UNDER", 4, 4, 0, 6, 4), row("SPREAD_MINUS", 4, 4, 0, 6, 4)];
  check("most profitable full tie: the earlier tile (Spread - before Under)", best(byOrder)!.mostProfitable.key === "SPREAD_MINUS", keys(byOrder));
  // 0.1 + 0.2 and 0.3 differ as doubles; the stat compares the 2dp figure it prints.
  const noise = [row("FAV_ML", 1, 1, 0, 0.1 + 0.2 + 1, 1), row("DOG_ML", 3, 1, 0, 1.3, 1)];
  check("most profitable tie at 2dp is a tie (float noise does not decide it)", best(noise)!.mostProfitable.key === "DOG_ML", keys(noise));
}
{
  // Highest win % ties: more graded picks, then more units, then the tiles' own order.
  const byGraded = [row("FAV_ML", 2, 1, 0, 9, 1), row("DOG_ML", 4, 2, 0, 3, 2), row("OVER", 1, 5, 0, 1, 5)];
  check("highest win % tie (2-1 vs 4-2): more graded picks wins", best(byGraded)!.highestWinPct?.key === "DOG_ML", keys(byGraded));
  const byUnits = [row("FAV_ML", 4, 2, 0, 3, 2), row("DOG_ML", 4, 2, 0, 9, 2)];
  check("highest win % tie (4-2 each): more units wins", best(byUnits)!.highestWinPct?.key === "DOG_ML", keys(byUnits));
  const byOrder = [row("UNDER", 4, 2, 0, 3, 2), row("OVER", 4, 2, 0, 3, 2)];
  check("highest win % full tie: the earlier tile (Over before Under)", best(byOrder)!.highestWinPct?.key === "OVER", keys(byOrder));
}
{
  // Pushes never enter the win %: 3-1-6 is 75%, not 30%.
  const pushes = [row("OVER", 3, 1, 6, 2.7, 1), row("UNDER", 7, 3, 0, 9, 3)];
  const b = best(pushes)!;
  check("pushes excluded: 3-1-6 (75%) beats 7-3 (70%)", b.highestWinPct?.key === "OVER" && b.highestWinPct.winPct === 75 && b.highestWinPct.pushes === 6 && b.highestWinPct.count === 10, JSON.stringify(b.highestWinPct));
}
{
  // A market with only pushes has no win %: never the highest win %, still a most-profitable candidate.
  const withPushOnly = [row("FAV_ML", 0, 0, 3, 0, 0), row("DOG_ML", 1, 4, 0, 1.5, 4), row("OVER", 2, 3, 0, 1.8, 3)];
  check("pushes only: ineligible for highest win %, most profitable at 0u over two losing markets", keys(withPushOnly) === "FAV_ML/OVER", keys(withPushOnly));
  check("pushes only: the two stats name different markets", labels(withPushOnly) === "Most profitable:Fav ML:units | Highest win %:Over:winPct", labels(withPushOnly));
  const onlyPushes = [row("FAV_ML", 0, 0, 2, 0, 0), row("UNDER", 0, 0, 5, 0, 0)];
  check("pushes only everywhere: no highest win %, one Best market (more graded picks)", keys(onlyPushes) === "UNDER/none" && labels(onlyPushes) === "Best market:Under:units", keys(onlyPushes) + " " + labels(onlyPushes));
  const winless = [row("FAV_ML", 0, 4, 0, 0, 4), row("UNDER", 0, 0, 5, 0, 0)];
  check("an 0-4 market has a win % (0%) and is eligible; the pushes-only one is not", best(winless)!.highestWinPct?.key === "FAV_ML", keys(winless));
}
{
  check("no graded picks: no best markets", best([]) === null);
  // The All Sports tiles sum a market's per-sport rows; so do its units. A key outside the tiles is ignored.
  const split = [row("FAV_ML", 3, 1, 0, 2, 1), row("FAV_ML", 2, 4, 0, 1.5, 4), row("OVER", 2, 2, 0, 2.2, 2), row("NRFI", 9, 0, 0, 9, 0)];
  const b = best(split)!;
  check("per-sport rows are summed; a market outside the tiles is not a candidate", b.mostProfitable.key === "OVER" && b.highestWinPct?.key === "FAV_ML" && b.highestWinPct.netUnits === -1.5 && b.highestWinPct.wins === 5, JSON.stringify(b));
}

console.log(`\n${assertions} assertions, ${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
