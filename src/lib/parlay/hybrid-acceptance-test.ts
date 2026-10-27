// Consensus Hybrid's optimizer (hybrid.ts): tonight's line from the ladder; edge
// placement for Over / Under / favorite / dog, home and away, balanced vs wider,
// the opponent flip and the raw-score fallback; football key numbers; snapping
// against the anchor and the -600 floor; fine-tuning toward the target band;
// box eligibility, the 3-leg box (2 / 3 / auto, corridor pricing), expansion,
// the cross-game fallback, no-fit, stale flags and the odds math. Ladders are the real FanDuel captures in __fixtures__. Pure -
// no DB, no fetch. Run with:
//   npx tsx src/lib/parlay/hybrid-acceptance-test.ts
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import nhlEvent from "@/lib/parlay/__fixtures__/fanduel-event-nhl.json";
import mlbEvent from "@/lib/parlay/__fixtures__/fanduel-event-mlb.json";
import nbaEvent from "@/lib/parlay/__fixtures__/fanduel-event-nba.json";
import { americanToDecimal, combineOdds, decimalToAmerican } from "@/lib/parlay/combine-odds";
import type { ConsensusPosition, PositionCapper } from "@/lib/parlay/consensus";
import {
  distanceToBand,
  HYBRID_MIN_LEG_PRICE,
  impliedProbability,
  jointImplied,
  legRungs,
  optimizeHybrid,
  placeEdge,
  pushKeyNumber,
  snapIndex,
  targetBand,
  tonightLine,
  type HybridLadder,
  type HybridLadders,
  type HybridSettings,
} from "@/lib/parlay/hybrid";
import type { SwingGame } from "@/lib/parlay/recent-swings";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- Fixtures ----

type FdEvent = { sport_key: string; home_team: string; away_team: string; commence_time: string; bookmakers: { key: string; markets: { key: string; outcomes: HybridLadder["outcomes"] }[] }[] };
const LEAGUE: Record<string, string> = { americanfootball_nfl: "NFL", icehockey_nhl: "NHL", baseball_mlb: "MLB", basketball_nba: "NBA" };

// The event's FanDuel alternate_spreads / alternate_totals / h2h as getAltLadders returns them.
function laddersOf(ev: FdEvent, opts: { stale?: string[]; updated?: Record<string, string>; noH2h?: boolean } = {}): HybridLadders[string] {
  const fd = ev.bookmakers.find((b) => b.key === "fanduel")!;
  const out: HybridLadders[string] = {};
  for (const key of ["alternate_spreads", "alternate_totals", "h2h"] as const) {
    if (key === "h2h" && opts.noH2h) continue;
    const m = fd.markets.find((x) => x.key === key);
    if (m) out[key] = { outcomes: m.outcomes, marketLastUpdate: opts.updated?.[key] ?? "2026-10-15T20:00:00.000Z", isStale: opts.stale?.includes(key) ?? false };
  }
  return out;
}

function capper(name: string, wins: number, losses: number, score: number): PositionCapper {
  const n = wins + losses;
  return {
    capperId: name.toLowerCase(),
    capperName: name,
    record: { wins, losses, n, winPct: Math.round((wins / n) * 1000) / 10, source: "LEAGUE" },
    recordMarket: "SPREAD",
    score,
    postedMarket: "SPREAD",
    postedLine: null,
    endorsedLine: 0,
    posts: 1,
  };
}

function pos(eventId: string, ev: FdEvent, family: "SIDE" | "TOTAL", direction: string, anchorLine: number, opts: { ml?: boolean; score?: number } = {}): ConsensusPosition {
  const supporters = [capper("Ace", 60, 40, 0.5), capper("Bo", 55, 45, 0.45)];
  return {
    key: eventId + "|" + family + "|" + direction,
    eventId,
    homeTeam: ev.home_team,
    awayTeam: ev.away_team,
    commenceTime: ev.commence_time,
    sport: LEAGUE[ev.sport_key] ?? ev.sport_key,
    family,
    direction,
    anchorLine,
    anchorIsMoneyline: opts.ml ?? false,
    postedLines: { hardest: anchorLine, easiest: anchorLine },
    lineSpread: 0,
    supporters,
    opposers: [],
    score: opts.score ?? 0.95,
  };
}

// One team's recent games: cover margins and total misses, both stored unless null.
function games(team: string, opponent: string, cover: (number | null)[], miss: (number | null)[], opts: { dates?: string[]; margins?: number[]; totals?: number[] } = {}): SwingGame[] {
  return cover.map((c, i) => {
    const m = miss[i];
    const actualTotal = opts.totals?.[i] ?? (m === null ? 44 : 44 + m);
    return {
      date: opts.dates?.[i] ?? `2026-10-0${i + 1}T17:00:00.000Z`,
      opponent: `${opponent} ${i}`,
      home: i % 2 === 0,
      actualTotal,
      postedTotal: m === null ? null : 44,
      totalMiss: m,
      margin: opts.margins?.[i] ?? (c ?? 0),
      postedSpread: c === null ? null : 0,
      coverMargin: c,
      lineSource: c === null && m === null ? "missing" : "stored",
      hoursBeforeStart: c === null && m === null ? null : 4,
    };
  });
}

const NFL = nflEvent as unknown as FdEvent;
const NHL = nhlEvent as unknown as FdEvent;
const MLB = mlbEvent as unknown as FdEvent;
const NBA = nbaEvent as unknown as FdEvent;
const DEN = NFL.home_team; // Denver Broncos, +2.5 tonight
const SEA = NFL.away_team; // Seattle Seahawks, -2.5 tonight
const DET = NHL.home_team;
const NJ = NHL.away_team;

// ============================================================================
// Odds math: implied-probability target band, combine-odds pricing
// ============================================================================
{
  const band = targetBand({ targetMin: -140, targetMax: -110 });
  check("band: -140 -> 0.5833 high, -110 -> 0.5238 low", [r2(band.low * 100), r2(band.high * 100), r2(band.mid * 100)], [52.38, 58.33, 55.36]);
  const flipped = targetBand({ targetMin: -110, targetMax: -140 });
  check("band: either order", [flipped.low, flipped.high], [band.low, band.high]);
  check("band: unusable prices fall back to -140 / -110", targetBand({ targetMin: 50, targetMax: -110 }).high, band.high);
  check("band: plus-money target", [r2(targetBand({ targetMin: 100, targetMax: 150 }).low * 100), r2(targetBand({ targetMin: 100, targetMax: 150 }).high * 100)], [40, 50]);
  check("distance: inside the band is 0", distanceToBand(impliedProbability(-125)!, band), 0);
  check("distance: -250 is too short by 0.1310", Math.round(distanceToBand(impliedProbability(-250)!, band) * 10000) / 10000, 0.131);
  check("implied: +150 -> 0.4, -600 -> 0.8571", [impliedProbability(150), r2(impliedProbability(-600)! * 10000)], [0.4, 8571.43]);
  check("implied: not a price -> null", impliedProbability(50), null);
}

// ============================================================================
// Tonight's line from the ladder itself
// ============================================================================
{
  const ladders = { e1: laddersOf(NFL) };
  check("NFL: home dog Broncos +2.5 (100 / -128 is the closest pair)", tonightLine(pos("e1", NFL, "SIDE", DEN, 2.5), ladders), 2.5);
  check("NFL: away favorite Seahawks -2.5", tonightLine(pos("e1", NFL, "SIDE", SEA, -2.5), ladders), -2.5);
  // 40.5 (-122 / -104) and 41.5 (-104 / -122) tie exactly: the higher point.
  check("NFL total: 40.5 / 41.5 tie -> 41.5", tonightLine(pos("e1", NFL, "TOTAL", "OVER", 41.5), ladders), 41.5);
  check("NFL total: same line for the Under", tonightLine(pos("e1", NFL, "TOTAL", "UNDER", 41.5), ladders), 41.5);
  // NHL: the alternate spreads start at 1.5; the -110 / -110 moneylines are the main line.
  const nhl = { h1: laddersOf(NHL) };
  check("NHL: moneyline pair -> pick'em 0 for the home team", tonightLine(pos("h1", NHL, "SIDE", DET, 0), nhl), 0);
  check("NHL: pick'em 0 for the away team", tonightLine(pos("h1", NHL, "SIDE", NJ, 0), nhl), 0);
  check("NHL total: 6.5 (+110 / -140) beats 5.5 (-142 / +112)? -> 6.5", tonightLine(pos("h1", NHL, "TOTAL", "OVER", 6.5), nhl), 6.5);
  check("no ladder -> null", tonightLine(pos("zz", NFL, "SIDE", DEN, 2.5), ladders), null);
}

// ============================================================================
// Edge placement: Over / Under, favorite / dog, home / away, balanced vs wider
// ============================================================================
// Broncos totalMiss: -9 -5 -1 under; Seahawks: -2 -3 under. Over-misses: 3 2 6 1.
const totalSwings = {
  [DEN]: games(DEN, "X", [0, 0, 0, 0, 0], [-9, 3, -5, 2, -1]),
  [SEA]: games(SEA, "Y", [0, 0, 0, 0, 0], [-2, 6, -3, 1, 0]),
};
{
  const over = pos("e1", NFL, "TOTAL", "OVER", 45.5);
  const b = placeEdge(over, 41.5, totalSwings, "balanced");
  check("Over balanced: 41.5 - 5 (the 9 set aside) = 36.5", [b.edge, b.storedMiss, b.setAside.stored, b.edgeSource], [36.5, 5, 9, "stored"]);
  const w = placeEdge(over, 41.5, totalSwings, "wider");
  check("Over wider: 41.5 - 9 = 32.5", [w.edge, w.storedMiss, w.setAside.stored], [32.5, 9, null]);
  const under = pos("e1", NFL, "TOTAL", "UNDER", 38.5);
  check("Under balanced: 41.5 + 3 (the 6 set aside) = 44.5", placeEdge(under, 41.5, totalSwings, "balanced").edge, 44.5);
  check("Under wider: 41.5 + 6 = 47.5", placeEdge(under, 41.5, totalSwings, "wider").edge, 47.5);
  check("totals never get a key-number push (Over edge 14)", placeEdge(over, 14, {}, "balanced").keyNumberPush, null);
}
{
  // Home dog Broncos +2.5. Own cover margins: misses 12, 8, 2. Seahawks' margins
  // negated: +4 -> -4 (a 4 miss), -5 -> +5.
  const swings = {
    [DEN]: games(DEN, "X", [-12, -8, 3, 1, -2], [0, 0, 0, 0, 0]),
    [SEA]: games(SEA, "Y", [0, 4, -2, -5, 1], [0, 0, 0, 0, 0]),
  };
  const dog = pos("e1", NFL, "SIDE", DEN, 2.5);
  const b = placeEdge(dog, 2.5, swings, "balanced");
  check("dog (home) balanced: +2.5 + 8 = +10.5 (12 set aside)", [b.edge, b.storedMiss, b.setAside.stored], [10.5, 8, 12]);
  check("dog (home) wider: +2.5 + 12 = +14.5", placeEdge(dog, 2.5, swings, "wider").edge, 14.5);

  // Away favorite Seahawks -2.5 on the same swings: own cover margins
  // 0 4 -2 -5 1 -> misses 2 and 5; Broncos negated: +12 +8 -3 -1 +2 -> misses 3 and 1.
  const fav = pos("e1", NFL, "SIDE", SEA, -2.5);
  const f = placeEdge(fav, -2.5, swings, "balanced");
  check("favorite (away) balanced: -2.5 + 3 = +0.5 (5 set aside)", [f.edge, f.storedMiss, f.setAside.stored], [0.5, 3, 5]);
  check("favorite (away) wider: -2.5 + 5 = +2.5 -> key 3 -> +3.5", [placeEdge(fav, -2.5, swings, "wider").edge, placeEdge(fav, -2.5, swings, "wider").keyNumberPush], [3.5, { from: 2.5, to: 3.5 }]);
}
{
  // The opponent flip on its own: the Broncos never missed; the Seahawks covered by 9 and 6.
  const swings = {
    [DEN]: games(DEN, "X", [1, 2, 3, 4, 5], [0, 0, 0, 0, 0]),
    [SEA]: games(SEA, "Y", [9, 6, 0, -1, -2], [0, 0, 0, 0, 0]),
  };
  const w = placeEdge(pos("e1", NFL, "SIDE", DEN, 2.5), 2.5, swings, "wider");
  check("opponent covering by 9 counts as a 9-point Broncos miss: +11.5", w.edge, 11.5);
  const b = placeEdge(pos("e1", NFL, "SIDE", DEN, 2.5), 2.5, swings, "balanced");
  check("balanced: the 9 set aside -> +2.5 + 6 = +8.5", b.edge, 8.5);
}
{
  // A meeting of the two teams sits in both lists (Broncos -9, Seahawks +9):
  // counted once. Every other game is a cover from the Broncos' side, so
  // balanced sets the one 9 aside (counted twice, the second 9 would remain).
  const date = "2026-09-20T20:25:00.000Z";
  const den = games(DEN, "X", [-9, 1, 2, 1, 0], [0, 0, 0, 0, 0], { dates: [date, "2026-09-27T17:00:00.000Z", "2026-10-04T17:00:00.000Z", "2026-10-11T17:00:00.000Z", "2026-09-13T17:00:00.000Z"] });
  den[0].opponent = SEA;
  const sea = games(SEA, "Y", [9, 0, -1, -2, -1], [0, 0, 0, 0, 0], { dates: [date, "2026-09-28T00:15:00.000Z", "2026-10-05T17:00:00.000Z", "2026-10-12T17:00:00.000Z", "2026-09-14T17:00:00.000Z"] });
  sea[0].opponent = DEN;
  const b = placeEdge(pos("e1", NFL, "SIDE", DEN, 2.5), 2.5, { [DEN]: den, [SEA]: sea }, "balanced");
  check("head-to-head counted once: balanced sets the one 9 aside -> +2.5 (key 3 -> +3.5)", [b.edge, b.storedMiss, b.setAside.stored], [3.5, 0, 9]);
}

// ============================================================================
// Raw fallback (<3 games with the line) and the edgeSource label
// ============================================================================
{
  // Broncos: only 2 of 5 games carry a total -> raw scores. Totals 30 51 44 38 47.
  const den = games(DEN, "X", [null, null, null, 0, 0], [null, null, null, 2, -1], { totals: [30, 51, 44, 38, 47] });
  const swings = { [DEN]: den, [SEA]: games(SEA, "Y", [0, 0, 0, 0, 0], [-2, 6, -3, 1, 0]) };
  const over = pos("e1", NFL, "TOTAL", "OVER", 45.5);
  const b = placeEdge(over, 41.5, swings, "balanced");
  // Stored (Seahawks): misses 2, 3 -> balanced 2 -> 39.5. Raw (Broncos): 30 set aside -> floor 38. More forgiving: 38.
  check("Over: raw floor 38 (30 set aside) beats the stored 39.5", [b.edge, b.edgeSource, b.rawValue, b.setAside.raw, b.rawTeams], [38, "raw", 38, 30, [DEN]]);
  check("Over wider: raw floor 30", placeEdge(over, 41.5, swings, "wider").edge, 30);
  const under = placeEdge(pos("e1", NFL, "TOTAL", "UNDER", 38.5), 41.5, swings, "balanced");
  check("Under: raw cap 47 (51 set aside) vs stored 41.5 + 1 -> 47", [under.edge, under.edgeSource], [47, "raw"]);

  // Exactly 3 stored is enough.
  const three = games(DEN, "X", [null, null, 0, 0, 0], [null, null, -4, 2, -1]);
  check("3 of 5 stored -> stored", placeEdge(over, 41.5, { [DEN]: three }, "wider").edgeSource, "stored");

  // Team side raw: Broncos margins (no stored spreads) -10 -3 +7 -14 +1; Seahawks none.
  const rawSide = games(DEN, "X", [null, null, null, null, null], [null, null, null, null, null], { margins: [-10, -3, 7, -14, 1] });
  const side = placeEdge(pos("e1", NFL, "SIDE", DEN, 2.5), 2.5, { [DEN]: rawSide }, "balanced");
  check("side raw: worst loss 10 (14 set aside) -> +10.5 after key 10", [side.edge, side.edgeSource, side.rawValue, side.keyNumberPush], [10.5, "raw", 10, { from: 10, to: 10.5 }]);
  check("no games at all -> tonight's line, edgeSource none", [placeEdge(over, 41.5, {}, "balanced").edge, placeEdge(over, 41.5, {}, "balanced").edgeSource], [41.5, "none"]);

  // Through the optimizer: the reason names the fallback.
  const res = optimizeHybrid({
    positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5)],
    ladders: { e1: laddersOf(NFL) },
    swings,
    settings: { maxLegs: 2 },
  });
  const overLeg = res.primary!.legs.find((l) => l.family === "TOTAL")!;
  check("raw leg labelled", [overLeg.edgeSource, overLeg.reason.includes("raw scores (lines missing for Denver Broncos)")], ["raw", true]);
}

// ============================================================================
// Football key numbers
// ============================================================================
{
  const cases: [number, number][] = [
    [2.5, 3.5], [3, 3.5], [3.5, 3.5], [6.6, 7.5], [7, 7.5], [9.5, 10.5], [10.5, 10.5], [13.5, 14.5], [14, 14.5], [14.5, 14.5],
    [-3.5, -2.5], [-3, -2.5], [-7.5, -6.5], [-10, -9.5], [-14.5, -13.5], [5, 5], [11.5, 11.5], [0, 0],
  ];
  for (const [from, to] of cases) check(`key number: ${from} -> ${to}`, pushKeyNumber(from), to);
  check("NFL side with no swings: tonight +3 -> +3.5", placeEdge(pos("e1", NFL, "SIDE", DEN, 2.5), 3, {}, "balanced").edge, 3.5);
  const nba = { ...pos("e1", NFL, "SIDE", DEN, 2.5), sport: "NBA" };
  check("NBA side: no key-number push", [placeEdge(nba, 3, {}, "balanced").edge, placeEdge(nba, 3, {}, "balanced").keyNumberPush], [3, null]);
  const nhl = pos("h1", NHL, "SIDE", DET, 0);
  check("NHL side: no key-number push", placeEdge(nhl, 3, {}, "balanced").edge, 3);
}

// ============================================================================
// Snapping: the anchor, the moneyline, the floor, the per-leg range
// ============================================================================
{
  const ladders = { e1: laddersOf(NFL), h1: laddersOf(NHL) };
  // Spread backers' easiest line +6.5: an edge of +2.5 still snaps to +6.5.
  const anchored = pos("e1", NFL, "SIDE", DEN, 6.5);
  const rungs = legRungs(anchored, ladders);
  check("rungs never harder than the anchor", rungs[0].point, 6.5);
  check("edge +2.5 snaps to the anchor +6.5", rungs[snapIndex(rungs, 2.5).index].point, 6.5);
  check("edge +8 snaps to +8.5 (nearest at or past)", rungs[snapIndex(rungs, 8).index].point, 8.5);

  // ML-backed favorite: anchor 0, the ML is pick'em; spreads run from +1.5, never -1.5.
  const mlFav = pos("e1", NFL, "SIDE", SEA, 0, { ml: true });
  const mlRungs = legRungs(mlFav, ladders);
  check("ML-backed side: first rung is the ML (h2h, -154)", [mlRungs[0].marketKey, mlRungs[0].point, mlRungs[0].price], ["h2h", null, -154]);
  check("ML-backed side: no negative alternate spread", mlRungs.filter((r) => r.point !== null && r.point < 0).length, 0);
  check("ML-backed side: next rung +1.5", mlRungs[1].point, 1.5);
  check("edge -4 (harder than pick'em) -> the ML", mlRungs[snapIndex(mlRungs, -4).index].marketKey, "h2h");
  check("edge 0 -> the ML", mlRungs[snapIndex(mlRungs, 0).index].marketKey, "h2h");
  check("edge +1 -> +1.5", mlRungs[snapIndex(mlRungs, 1).index].point, 1.5);
  // A spread-only anchor of +3.5 (dog backers): the ML is harder, so not a rung.
  check("anchor +3.5: no ML rung", legRungs(pos("e1", NFL, "SIDE", DEN, 3.5), ladders).some((r) => r.marketKey === "h2h"), false);
  // Spread-only favorite anchored at -3.5: -2.5 and -1.5 are more forgiving, and so is the ML.
  const favSpread = legRungs(pos("e1", NFL, "SIDE", SEA, -3.5), ladders).map((r) => r.point);
  check("spread favorite anchored -3.5: -3.5, -2.5, -1.5, ML, +1.5...", favSpread.slice(0, 5), [-3.5, -2.5, -1.5, null, 1.5]);

  // Over anchored at 43.5: no rung above it.
  const over = legRungs(pos("e1", NFL, "TOTAL", "OVER", 43.5), ladders);
  check("Over anchor 43.5: hardest rung 43.5, most forgiving 35.5", [over[0].point, over[over.length - 1].point], [43.5, 35.5]);
  const past = snapIndex(over, -30);
  check("Over edge 30 past the ladder: clamps to 35.5, not reached", [over[past.index].point, past.reached], [35.5, false]);
  const under = legRungs(pos("e1", NFL, "TOTAL", "UNDER", 41.5), ladders);
  check("Under anchor 41.5: 41.5 up", [under[0].point, under[under.length - 1].point], [41.5, 47.5]);

  // The -600 floor: Red Wings +2.5 at -600 stays, +3.5 at -2000 is gone; Over 3.5 at -950 is gone.
  const det = legRungs(pos("h1", NHL, "SIDE", DET, 0, { ml: true }), ladders);
  check("NHL floor: Red Wings rungs ML, +1.5, +2.5 (-600 kept)", det.map((r) => [r.point, r.price]), [[null, -110], [1.5, -300], [2.5, -600]]);
  check("floor constant", HYBRID_MIN_LEG_PRICE, -600);
  const nhlOver = legRungs(pos("h1", NHL, "TOTAL", "OVER", 6.5), ladders);
  check("NHL Over floor: most forgiving 4.5 (-450)", [nhlOver[nhlOver.length - 1].point, nhlOver[nhlOver.length - 1].price], [4.5, -450]);

  // The per-leg range -200..+150.
  const ranged = legRungs(pos("e1", NFL, "TOTAL", "OVER", 47.5), ladders, { legRange: { min: -200, max: 150 } });
  check("per-leg range: Over 44.5 (+142) .. 37.5 (-180)", [ranged[0].point, ranged[ranged.length - 1].point], [44.5, 37.5]);
}

// ============================================================================
// Fine-tuning on the real NFL ladder (Broncos side + Over, tonight +2.5 / 41.5)
// ============================================================================
// Side misses: Broncos -12 -8 (+ Seahawks' negated): balanced worst 8 -> +10.5.
const sideSwings = {
  [DEN]: games(DEN, "X", [-12, -8, 3, 1, -2], [0, 0, 0, 0, 0]),
  [SEA]: games(SEA, "Y", [0, 4, -2, -5, 1], [0, 0, 0, 0, 0]),
};
function nflBox(overMisses: number[], sideCover: number[] | null, settings: HybridSettings = {}, anchors = { side: 2.5, over: 45.5 }) {
  const swings = {
    [DEN]: games(DEN, "X", sideCover ?? [-12, -8, 3, 1, -2], [overMisses[0], 0, 0, 0, 0]),
    [SEA]: games(SEA, "Y", sideCover ? [0, 0, 0, 0, 0] : [0, 4, -2, -5, 1], [overMisses[1], overMisses[2] ?? 0, 0, 0, 0]),
  };
  return optimizeHybrid({
    positions: [pos("e1", NFL, "SIDE", DEN, anchors.side), pos("e1", NFL, "TOTAL", "OVER", anchors.over)],
    ladders: { e1: laddersOf(NFL) },
    swings,
    settings: { maxLegs: 2, ...settings },
  });
}
{
  // Over misses 9 and 5 -> balanced 5 -> 36.5. +10.5 (-460) x Over 36.5 (-220) = -130: in target.
  const r = nflBox([-9, -5], null).primary!;
  check("in target at the edges: kept", [r.legs.map((l) => l.point), r.inTarget, r.rungsMoved, Math.round(r.combinedAmerican)], [[10.5, 36.5], true, 0, -130]);
  check("in target: legs at their edges", r.legs.map((l) => [l.snappedPoint, l.move.rungs]), [[10.5, 0], [36.5, 0]]);
  check("same-game box is an estimate", [r.structure, r.isEstimate], ["same-game-box", true]);
  check("box description", r.boxDescription, "Wins if Denver Broncos lose by 10 or fewer and 37+ total points");
  check("side reason", r.legs[0].reason, "Denver Broncos +10.5 · tonight +2.5 · their games miss the spread by up to 8 · biggest miss (12) set aside");
  const exact = combineOdds([{ odds: -460 }, { odds: -220 }]);
  check("price = combine-odds product", r.combinedAmerican, exact.status === "AVAILABLE" ? exact.american : null);
  check("leg tonight / edge", r.legs.map((l) => [l.tonightLine, l.edge]), [[2.5, 10.5], [41.5, 36.5]]);
}
{
  // Over misses 9 and 6 -> 35.5. +10.5 x 35.5 = -146: too short. One rung either
  // way reaches the band (-135 or -130); -130 is nearer the middle.
  const r = nflBox([-9, -6], null).primary!;
  check("too short: tighten one rung", [r.legs.map((l) => l.point), r.inTarget, r.rungsMoved, Math.round(r.combinedAmerican)], [[10.5, 36.5], true, 1, -130]);
  check("too short: the Over moved, the side stayed", r.legs.map((l) => l.move.rungs), [0, -1]);
  check("too short: why", r.legs[1].move.why, "tightened 1 rung toward the anchor to reach the target");
  check("too short: snapped vs final", [r.legs[1].snappedPoint, r.legs[1].point], [35.5, 36.5]);
}
{
  // Target -105 / +100 (0.50 - 0.5122), anchors +9.5 / 36.5: the furthest the box
  // can tighten is +9.5 x 36.5 = -121. It stops at the anchors, out of target.
  const r = nflBox([-9, -6], null, { targetMin: -105, targetMax: 100 }, { side: 9.5, over: 36.5 }).primary!;
  check("tighten stops at the anchors", [r.legs.map((l) => l.point), r.inTarget, Math.round(r.combinedAmerican)], [[9.5, 36.5], false, -121]);
  check("anchor stop: why", r.legs[1].move.why, "tightened 1 rung toward the anchor (at the anchor, can't go further)");
}
{
  // Side misses 4 -> +6.5 -> key 7 -> +7.5. Over misses 3 -> 38.5. +7.5 x 38.5 = +113:
  // too long. Three rungs out: +8.5 / 36.5 (-115, split 1-2) beats +7.5 / 35.5 (-120, 0-3).
  const r = nflBox([-3, 0], [-4, 0, 0, 0, 0], { width: "wider" }).primary!;
  check("too long: edges +7.5 (key push) / 38.5", r.legs.map((l) => [l.snappedPoint, l.keyNumberPush]), [[7.5, { from: 6.5, to: 7.5 }], [38.5, null]]);
  check("too long: push out, more even split", [r.legs.map((l) => l.point), r.inTarget, r.rungsMoved, Math.round(r.combinedAmerican)], [[8.5, 36.5], true, 3, -115]);
  check("too long: why", r.legs.map((l) => l.move.why), ["pushed out 1 rung to reach the target", "pushed out 2 rungs to reach the target"]);
}
{
  // The floor during fine-tuning: target -400 / -300 asks for a very short box; the
  // side may not go past +7.5 (-310)... the Over not past 35.5 (-260); every leg
  // stays at or above -600.
  const r = nflBox([-9, -6], null, { targetMin: -900, targetMax: -800 }).primary!;
  check("floor: no leg under -600", r.legs.every((l) => l.price >= -600), true);
  check("floor: side stops at +10.5 (-460, the last rung >= -600)", [r.legs[0].point, r.inTarget], [10.5, false]);
  // The per-leg range -300..+200 cuts the side at +7.5 (-310 is out): +6.5 (-225) is the most forgiving.
  const ranged = nflBox([-9, -6], null, { legRange: { min: -300, max: 200 } }).primary!;
  check("per-leg range: every leg inside -300..+200", ranged.legs.every((l) => l.price >= -300 && l.price <= 200), true);
  check("per-leg range: side clamps to +6.5, edge not reached", [ranged.legs[0].point, ranged.legs[0].edgeReached], [6.5, false]);
  check("per-leg range: the reason blames the price limits", ranged.legs[0].reason.includes("price limits (-600 floor / leg range) stop it short of the edge"), true);

  // The ladder's own end: an Over edge of 30 on a ladder that stops at 35.5.
  const swings = { [DEN]: games(DEN, "X", [null, null, null, null, null], [null, null, null, null, null], { totals: [30, 51, 44, 38, 47] }) };
  const end = optimizeHybrid({
    positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5)],
    ladders: { e1: laddersOf(NFL) },
    swings,
    settings: { maxLegs: 2, width: "wider" },
  }).primary!.legs[1];
  check("ladder end: Over edge 30 snaps to 35.5", [end.edge, end.snappedPoint, end.edgeReached], [30, 35.5, false]);
  check("ladder end: the reason says so", end.reason.includes("ladder stops short of the edge"), true);
}
{
  // MLB: the -132 / +112 moneylines are closer than any run-line pair, so tonight's
  // line is pick'em - and the reason shows the favorite's ML price. The Rays' +3.5
  // rung is -720, under the floor, so a +3.5 edge stops at +2.5 (-410).
  const ladders = { m1: laddersOf(MLB) };
  const rays = pos("m1", MLB, "SIDE", MLB.home_team, 0, { ml: true });
  check("MLB: tonight's line from the moneyline pair", tonightLine(rays, ladders), 0);
  const swings = { [MLB.home_team]: games(MLB.home_team, "X", [-3.5, -3.5, 1, 2, 0], [0, 0, 0, 0, 0]) };
  const r = optimizeHybrid({ positions: [rays, pos("m1", MLB, "TOTAL", "UNDER", 6.5)], ladders, swings, settings: { maxLegs: 2 } }).primary!;
  check("MLB: side stops at +2.5 (the floor)", [r.legs[0].edge, r.legs[0].snappedPoint, r.legs[0].price], [3.5, 2.5, -410]);
  check("MLB: reason", r.legs[0].reason.startsWith("Tampa Bay Rays +2.5 · tonight pick'em (ML -132) · their games miss the spread by up to 3.5"), true);
  check("MLB: total noun", r.boxDescription.endsWith("total runs"), true);
}

// ============================================================================
// NBA (Warriors @ Nuggets, captured 2026-10-27): deep ladders, no key numbers
// ============================================================================
{
  const GSW = NBA.away_team;
  const DEN_NBA = NBA.home_team;
  const ladders = { b1: laddersOf(NBA) };
  // Nuggets -7.5 (-106) / Warriors +7.5 (-116) is the closest pair; the h2h
  // (-260 / +215) is far apart. The total ties 235.5 / 236.5 -> 236.5.
  check("NBA: Nuggets -7.5, Warriors +7.5 tonight", [tonightLine(pos("b1", NBA, "SIDE", DEN_NBA, -7.5), ladders), tonightLine(pos("b1", NBA, "SIDE", GSW, 7.5), ladders)], [-7.5, 7.5]);
  check("NBA total: 235.5 / 236.5 tie -> 236.5", tonightLine(pos("b1", NBA, "TOTAL", "OVER", 236.5), ladders), 236.5);

  // The -600 floor on a 59-rung side: Warriors stop at +19.5 (-590); +20.5 is -700.
  const gsw = legRungs(pos("b1", NBA, "SIDE", GSW, 7.5), ladders);
  check("NBA floor: Warriors +7.5 .. +19.5 (-590)", [gsw[0].point, gsw[gsw.length - 1].point, gsw[gsw.length - 1].price], [7.5, 19.5, -590]);
  // ML-backed favorite: the ML (-260), then +1.5 up to +6.5 (-560); never a minus spread.
  const den = legRungs(pos("b1", NBA, "SIDE", DEN_NBA, 0, { ml: true }), ladders);
  check("NBA ML-backed Nuggets: ML then +1.5 .. +6.5", den.map((r) => r.point), [null, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5]);

  // No football key numbers in the NBA: an edge of exactly +7 stays +7 and snaps to +7.5.
  const seven = placeEdge(pos("b1", NBA, "SIDE", GSW, 7.5), 3, { [GSW]: games(GSW, "X", [-4, 0, 0, 0, 0], [0, 0, 0, 0, 0]) }, "wider");
  check("NBA: edge +7 not pushed", [seven.edge, seven.keyNumberPush], [7, null]);

  // The worked example. Warriors misses 9 14 3 (+ Nuggets' negated 11 5 8):
  // balanced 11 -> +18.5 (-500). Under-misses 12 4 9 (+ 18 2 7): balanced 12 ->
  // Over 224.5 (-300). 0.625 is too short; no 1- or 2-rung move reaches the band;
  // at 3 rungs the even splits are +16.5 / 225.5 (0.577) and +17.5 / 226.5
  // (0.574), the latter nearer the middle.
  const swings = {
    [GSW]: games(GSW, "X", [-9, 4, -14, 6, -3], [-12, 7, -4, 15, -9]),
    [DEN_NBA]: games(DEN_NBA, "Y", [11, -2, 5, -6, 8], [3, -18, 6, -2, -7]),
  };
  const r = optimizeHybrid({ positions: [pos("b1", NBA, "SIDE", GSW, 7.5), pos("b1", NBA, "TOTAL", "OVER", 236.5)], ladders, swings }).primary!;
  check("NBA: edges +18.5 / 224.5", r.legs.map((l) => [l.edge, l.snappedPoint]), [[18.5, 18.5], [224.5, 224.5]]);
  check("NBA: tuned to +17.5 (-410) / 226.5 (-250)", r.legs.map((l) => [l.point, l.price, l.move.rungs]), [[17.5, -410, -1], [226.5, -250, -2]]);
  check("NBA: -135, in target, estimate", [Math.round(r.combinedAmerican), r.inTarget, r.isEstimate], [-135, true, true]);
  check("NBA: description", r.boxDescription, "Wins if Golden State Warriors lose by 17 or fewer and 227+ total points");

  // Same games, 3-leg forced: the Under comes from the same over-misses (7 15 + 3 6; balanced sets
  // 15 aside -> 7) -> Under 243.5. The corridor at the edges is far too long, so it pushes out.
  const three = optimizeHybrid({ positions: [pos("b1", NBA, "SIDE", GSW, 7.5), pos("b1", NBA, "TOTAL", "OVER", 236.5)], ladders, swings, settings: { boxLegs: "3" } }).primary!;
  check("NBA 3-leg: side, Over, then the opposite Under", three.legs.map((l) => [l.family, l.direction, l.opposite]), [["SIDE", GSW, false], ["TOTAL", "OVER", false], ["TOTAL", "UNDER", true]]);
  const under = three.legs[2];
  check("NBA 3-leg: the Under's edge is tonight + the balanced over-miss (236.5 + 7)", [under.tonightLine, under.edge, under.snappedPoint, under.edgeSource], [236.5, 243.5, 243.5, "stored"]);
  check("NBA 3-leg: the Under has no consensus of its own", [under.consensus.supporters, under.consensus.score, three.consensusScore], [0, 0, r2(0.95 * 2)]);
  check("NBA 3-leg: every leg at or above the -600 floor", three.legs.every((l) => l.price >= HYBRID_MIN_LEG_PRICE), true);
  check("NBA 3-leg: Over below Under", three.legs[1].point! < under.point!, true);
  check("NBA 3-leg: still an estimate", [three.structure, three.isEstimate], ["same-game-box", true]);
  // Auto: the 2-leg edges (0.625) are too short, but the 3-leg box can't reach the band without moving the side and
  // the Over, and gets no closer than the tuned 2-leg box (in band) - so Auto keeps the 2-leg box.
  const auto = optimizeHybrid({ positions: [pos("b1", NBA, "SIDE", GSW, 7.5), pos("b1", NBA, "TOTAL", "OVER", 236.5)], ladders, swings, settings: { boxLegs: "auto" } }).primary!;
  check("NBA auto: keeps the tuned 2-leg box here", auto.legs.map((l) => [l.point, l.price]), [[17.5, -410], [226.5, -250]]);
}

// ============================================================================
// 3-leg box: corridor pricing, Auto, the opposite Over, the wording
// ============================================================================
{
  // The corridor: Over 225.5 (-275) + Under 248.5 (-320) can never both lose, so the pair is
  // pOver + pUnder - 1 = 0.7333 + 0.7619 - 1 = 0.4952 (about +102), not the product 0.5587 (about -127).
  const leg = (direction: string, point: number, price: number) => ({ eventId: "b1", family: "TOTAL" as const, direction, point, price });
  const corridor = jointImplied([leg("OVER", 225.5, -275), leg("UNDER", 248.5, -320)])!;
  check("corridor 225.5 / 248.5: 0.4952", Math.round(corridor * 10000) / 10000, 0.4952);
  check("corridor 225.5 / 248.5: about +102 (the product would be -127)", [Math.round(decimalToAmerican(1 / corridor)!), Math.round(combineOdds([{ odds: -275 }, { odds: -320 }]).status === "AVAILABLE" ? (combineOdds([{ odds: -275 }, { odds: -320 }]) as { american: number }).american : 0)], [102, -127]);
  const side = { eventId: "b1", family: "SIDE" as const, direction: "Golden State Warriors", point: 17.5, price: -410 };
  check("the side leg multiplies the corridor", r2(jointImplied([side, leg("OVER", 225.5, -275), leg("UNDER", 248.5, -320)])! * 1000), r2(corridor * impliedProbability(-410)! * 1000));
  check("no corridor: the plain product", jointImplied([side, leg("OVER", 225.5, -275)]), 1 / (americanToDecimal(-410)! * americanToDecimal(-275)!));
  check("an Under at or below the Over leaves no room", [jointImplied([leg("OVER", 236.5, -106), leg("UNDER", 236.5, -114)]), jointImplied([leg("OVER", 240.5, -150), leg("UNDER", 230.5, -150)])], [null, null]);
  check("another game's totals don't box each other", jointImplied([leg("OVER", 225.5, -275), { ...leg("UNDER", 248.5, -320), eventId: "b2" }]), 1 / (americanToDecimal(-275)! * americanToDecimal(-320)!));
}
{
  // Auto adds the third leg. Wide edges: Warriors +19.5 (-590; misses 12 20, balanced 12) and Over 218.5
  // (-590; under-misses 18 25, balanced 18) price 0.731 - too short. The Under starts at 245.5
  // (over-misses 9 12, balanced 9) and only it moves: pushed out to Under 248.5 (-320) the box is
  // 0.855 x (0.855 + 0.762 - 1) = 0.528, in the band with the side and the Over on their edges.
  const GSW = NBA.away_team;
  const DEN_NBA = NBA.home_team;
  const ladders = { b1: laddersOf(NBA) };
  const swings = {
    [GSW]: games(GSW, "X", [-12, -20, 0, 0, 0], [-18, -25, 9, 12, 0]),
    [DEN_NBA]: games(DEN_NBA, "Y", [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]),
  };
  const positions = [pos("b1", NBA, "SIDE", GSW, 7.5), pos("b1", NBA, "TOTAL", "OVER", 236.5)];
  const two = optimizeHybrid({ positions, ladders, swings, settings: { boxLegs: "2" } }).primary!;
  check("wide edges, 2-leg: tightened back from +19.5 / 218.5", [two.legs.length, two.rungsMoved > 0, two.legs.every((l) => l.move.rungs <= 0)], [2, true, true]);
  const auto = optimizeHybrid({ positions, ladders, swings, settings: { boxLegs: "auto" } }).primary!;
  check("auto: three legs, the side and Over on their edges", auto.legs.map((l) => [l.direction, l.point, l.price, l.move.rungs]), [[GSW, 19.5, -590, 0], ["OVER", 218.5, -590, 0], ["UNDER", 248.5, -320, 3]]);
  check("auto: the Under's edge 245.5, pushed 3 rungs", [auto.legs[2].edge, auto.legs[2].snappedPoint], [245.5, 245.5]);
  const p = impliedProbability(-590)! * (impliedProbability(-590)! + impliedProbability(-320)! - 1);
  check("auto: priced as side x corridor, in target", [r2(auto.impliedProbability), r2(p), auto.inTarget, Math.round(auto.combinedAmerican)], [r2(p), r2(p), true, Math.round(decimalToAmerican(1 / p)!)]);
  check("auto: corridor wording", auto.boxDescription, "Wins if Golden State Warriors lose by 19 or fewer and 219–248 total points");
  check("auto: the third leg's reason reads like any Under", auto.legs[2].reason.split(" · ").slice(0, 3), ["Under 248.5", "tonight 236.5", "their games go over the total by up to 9"]);
  check("maxLegs 2 never takes a third leg", optimizeHybrid({ positions, ladders, swings, settings: { boxLegs: "3", maxLegs: 2 } }).primary!.legs.length, 2);
  check("unset boxLegs is the 2-leg box", optimizeHybrid({ positions, ladders, swings }).primary!.legs.length, 2);

  // An Under box: the opposite Over comes from the under-misses (18 25 -> balanced 18) -> Over 218.5.
  const underBox = optimizeHybrid({ positions: [positions[0], pos("b1", NBA, "TOTAL", "UNDER", 236.5)], ladders, swings, settings: { boxLegs: "3" } }).primary!;
  check("Under box: the opposite leg is an Over from tonight - the balanced under-miss", [underBox.legs[2].direction, underBox.legs[2].opposite, underBox.legs[2].edge], ["OVER", true, 218.5]);
  check("Under box: Over below Under", underBox.legs[2].point! < underBox.legs[1].point!, true);
}

// ============================================================================
// Box eligibility, ranking, the K = 6 window
// ============================================================================
{
  // e1: both team sides and both totals qualify; e2: a side only.
  const positions = [
    pos("e1", NFL, "SIDE", SEA, -2.5, { score: 2.0 }),
    pos("e1", NFL, "SIDE", DEN, 2.5, { score: 1.5 }),
    pos("e1", NFL, "TOTAL", "OVER", 45.5, { score: 1.2 }),
    pos("e1", NFL, "TOTAL", "UNDER", 38.5, { score: 1.0 }),
    pos("e2", NFL, "SIDE", DEN, 2.5, { score: 3.0 }),
  ];
  const r = optimizeHybrid({ positions, ladders: { e1: laddersOf(NFL), e2: laddersOf(NFL) }, swings: {}, settings: { maxLegs: 2 } });
  const legs = r.primary!.legs;
  check("box: one team side + one total, both on e1", legs.map((l) => [l.eventId, l.family, l.direction]), [["e1", "SIDE", SEA], ["e1", "TOTAL", "OVER"]]);
  check("box: e2 (a side only) is not a box", r.alternates.length, 0);
}
{
  // Seven box-eligible games. Games 1-6 (best scores) are stuck out of target at
  // their anchors; game 7 would fit but is outside the top 6, so it never shows.
  const positions: ConsensusPosition[] = [];
  const ladders: HybridLadders = {};
  for (let i = 1; i <= 7; i++) {
    const id = "g" + i;
    ladders[id] = laddersOf(NFL);
    const stuck = i <= 6;
    positions.push(pos(id, NFL, "SIDE", DEN, stuck ? 10.5 : 2.5, { score: 10 - i }));
    positions.push(pos(id, NFL, "TOTAL", "OVER", stuck ? 35.5 : 45.5, { score: 1 }));
  }
  const swings = { [DEN]: games(DEN, "X", [-12, -8, 3, 1, -2], [-9, -5, 0, 0, 0]) };
  const r = optimizeHybrid({ positions, ladders, swings, settings: { maxLegs: 2 } });
  const shown = [r.primary!, ...r.alternates].map((h) => h.legs[0].eventId);
  check("K = 6: game 7 never evaluated; primary + 2 alternates by consensus", shown, ["g1", "g2", "g3"]);
  check("each hybrid a different game", new Set(shown).size, 3);
  check("all out of target (closest returned)", [r.primary!.inTarget, Math.round(r.primary!.combinedAmerican)], [false, -146]);
}
{
  // In-target boxes rank before out-of-target ones, then by consensus score.
  const swings = { [DEN]: games(DEN, "X", [-12, -8, 3, 1, -2], [-9, -5, 0, 0, 0]) };
  const positions = [
    pos("a", NFL, "SIDE", DEN, 10.5, { score: 5 }),
    pos("a", NFL, "TOTAL", "OVER", 35.5, { score: 5 }),
    pos("b", NFL, "SIDE", DEN, 2.5, { score: 1 }),
    pos("b", NFL, "TOTAL", "OVER", 45.5, { score: 1 }),
    pos("c", NFL, "SIDE", DEN, 2.5, { score: 2 }),
    pos("c", NFL, "TOTAL", "OVER", 45.5, { score: 2 }),
  ];
  const r = optimizeHybrid({ positions, ladders: { a: laddersOf(NFL), b: laddersOf(NFL), c: laddersOf(NFL) }, swings, settings: { maxLegs: 2 } });
  check("ranking: in target first, then consensus", [r.primary!, ...r.alternates].map((h) => [h.legs[0].eventId, h.inTarget]), [["c", true], ["b", true], ["a", false]]);
}

// ============================================================================
// Expansion (NHL: coarse ladders) and the 4-leg cap
// ============================================================================
{
  // Core NHL box stuck at its anchors: Red Wings +2.5 (-600) x Over 4.5 (-450) = -235.
  // Extras: NHL team sides anchored at +2.5 on other games (-600 / -550 rungs).
  const ladders: HybridLadders = { h1: laddersOf(NHL), x1: laddersOf(NHL), x2: laddersOf(NHL), x3: laddersOf(NHL), x4: laddersOf(NHL, { noH2h: true }) };
  const core = [pos("h1", NHL, "SIDE", DET, 2.5, { score: 5 }), pos("h1", NHL, "TOTAL", "OVER", 4.5, { score: 5 })];
  const extras = [pos("x1", NHL, "SIDE", DET, 2.5, { score: 3 }), pos("x2", NHL, "SIDE", DET, 2.5, { score: 2 }), pos("x3", NHL, "SIDE", DET, 2.5, { score: 1 })];
  const r = optimizeHybrid({ positions: [...core, ...extras], ladders, swings: {} });
  const h = r.primary!;
  // -235 -> x -600 = 0.601 (closer) -> x -600 = 0.515 (closer still); a 5th leg is never tried.
  check("expansion: two extra legs, 4-leg cap", h.legs.map((l) => l.eventId), ["h1", "h1", "x1", "x2"]);
  check("expansion: each extra is edge-placed", h.legs.slice(2).map((l) => [l.point, l.move.rungs]), [[2.5, 0], [2.5, 0]]);
  check("expansion: still a same-game box, still an estimate", [h.structure, h.isEstimate], ["same-game-box", true]);
  check("expansion: closest result, not in target", [h.inTarget, r2(h.impliedProbability)], [false, 0.52]);
  check("expansion: description names the other games", h.boxDescription, "Wins if Detroit Red Wings lose by 2 or fewer, 5+ total goals, Detroit Red Wings lose by 2 or fewer and Detroit Red Wings lose by 2 or fewer");

  // With maxLegs 2 there is no expansion.
  const two = optimizeHybrid({ positions: [...core, ...extras], ladders, swings: {}, settings: { maxLegs: 2 } }).primary!;
  check("maxLegs 2: no expansion", two.legs.length, 2);
  check("maxLegs is capped at 4", optimizeHybrid({ positions: [...core, ...extras], ladders, swings: {}, settings: { maxLegs: 9 } }).primary!.legs.length, 4);
}
{
  // An extra that would move the price AWAY from the band is not kept: the box is
  // too short (-235), and an NHL Over 6.5 (+110) extra overshoots to +222.
  const ladders: HybridLadders = { h1: laddersOf(NHL), x1: laddersOf(NHL) };
  const core = [pos("h1", NHL, "SIDE", DET, 2.5, { score: 5 }), pos("h1", NHL, "TOTAL", "OVER", 4.5, { score: 5 })];
  const r = optimizeHybrid({ positions: [...core, pos("x1", NHL, "TOTAL", "OVER", 6.5, { score: 3 })], ladders, swings: {} }).primary!;
  check("expansion only when strictly closer", r.legs.length, 2);
}
{
  // A box already in target never expands, even with positions to spare.
  const swings = { [DEN]: games(DEN, "X", [-12, -8, 3, 1, -2], [-9, -5, 0, 0, 0]), [SEA]: games(SEA, "Y", [0, 4, -2, -5, 1], [0, 0, 0, 0, 0]) };
  const r = optimizeHybrid({
    positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5), pos("h1", NHL, "SIDE", DET, 2.5)],
    ladders: { e1: laddersOf(NFL), h1: laddersOf(NHL) },
    swings,
  }).primary!;
  check("in-target box: no expansion", [r.legs.length, r.inTarget], [2, true]);
}

// ============================================================================
// Cross-game fallback, no fit, stale flags, nothing to build
// ============================================================================
{
  // No game has both a side and a total: Broncos side (e1) + NHL Over (h1).
  const r = optimizeHybrid({
    positions: [pos("e1", NFL, "SIDE", DEN, 2.5, { score: 3 }), pos("e1", NFL, "SIDE", SEA, -2.5, { score: 2 }), pos("h1", NHL, "TOTAL", "OVER", 6.5, { score: 1 })],
    ladders: { e1: laddersOf(NFL), h1: laddersOf(NHL) },
    swings: {},
    settings: { maxLegs: 2 },
  });
  const h = r.primary!;
  check("cross-game: structure, exact price", [h.structure, h.isEstimate], ["cross-game", false]);
  check("cross-game: the top two positions on different games", h.legs.map((l) => l.positionKey), ["e1|SIDE|" + DEN, "h1|TOTAL|OVER"]);
  const exact = combineOdds(h.legs.map((l) => ({ odds: l.price })));
  check("cross-game: price is the exact product", h.combinedAmerican, exact.status === "AVAILABLE" ? exact.american : null);
  check("cross-game: decimal", r2(h.combinedDecimal), r2(h.legs.reduce((d, l) => d * americanToDecimal(l.price)!, 1)));
  check("cross-game: the total names its game", h.boxDescription.includes(`total goals in ${NJ} @ ${DET}`), true);
}
{
  // Stale ladders pass through, and oddsAsOf is the oldest market update.
  const ladders = { e1: laddersOf(NFL, { stale: ["alternate_totals"], updated: { alternate_spreads: "2026-10-15T20:05:00.000Z", alternate_totals: "2026-10-15T19:30:00.000Z" } }) };
  const r = optimizeHybrid({ positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5)], ladders, swings: sideSwings, settings: { maxLegs: 2 } }).primary!;
  check("stale: per leg and anyStale", [r.legs.map((l) => l.isStale), r.anyStale], [[false, true], true]);
  check("oddsAsOf: the oldest leg update", r.oddsAsOf, "2026-10-15T19:30:00.000Z");
}
{
  const one = optimizeHybrid({ positions: [pos("e1", NFL, "SIDE", DEN, 2.5)], ladders: { e1: laddersOf(NFL) }, swings: {} });
  check("one placeable position: no hybrid", [one.primary, one.alternates.length, one.note], [null, 0, "Only one game has a placeable consensus position."]);
  const none = optimizeHybrid({ positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5)], ladders: {}, swings: {} });
  check("no ladders: no hybrid, never an invented price", [none.primary, none.note], [null, "No consensus position has a usable FanDuel ladder."]);
}
{
  // The consensus summary rides along.
  const r = optimizeHybrid({ positions: [pos("e1", NFL, "SIDE", DEN, 2.5), pos("e1", NFL, "TOTAL", "OVER", 45.5)], ladders: { e1: laddersOf(NFL) }, swings: sideSwings }).primary!;
  check("consensus summary", r.legs[0].consensus, {
    supporters: 2,
    opposers: 0,
    score: 0.95,
    anchorLine: 2.5,
    anchorIsMoneyline: false,
    topSupporters: [
      { capperName: "Ace", record: "LEAGUE", recordMarket: "SPREAD", wins: 60, losses: 40, n: 100, winPct: 60 },
      { capperName: "Bo", record: "LEAGUE", recordMarket: "SPREAD", wins: 55, losses: 45, n: 100, winPct: 55 },
    ],
  });
  check("leg handoff fields", [r.legs[0].marketKey, typeof r.legs[0].sid, typeof r.legs[0].link], ["alternate_spreads", "string", "string"]);
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL PASS");
