// Consensus Hybrid's selection, frozen: the optimizer's whole result (every
// leg on its line at its price, the boxes, the alternates and the delivery) for fixed inputs at Total legs 2 / 3 / 15 / 25,
// across 2-leg, 3-leg and Auto boxes, the multi-box path, the cross-game
// fallback and a game whose ladder is missing. The JSON in __fixtures__ was
// written by this file from the optimizer as it stood before the "Why only N
// games?" diagnostic (#364 base 35d86e9), so the diagnostic is proven to leave
// selection exactly as it was. Pure - no DB, no fetch.
//   npx tsx src/lib/parlay/hybrid-selection-frozen-acceptance-test.ts          check
//   npx tsx src/lib/parlay/hybrid-selection-frozen-acceptance-test.ts --write  rewrite the fixture
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import nhlEvent from "@/lib/parlay/__fixtures__/fanduel-event-nhl.json";
import nbaEvent from "@/lib/parlay/__fixtures__/fanduel-event-nba.json";
import type { ConsensusPosition, PositionCapper } from "@/lib/parlay/consensus";
import { optimizeHybrid, type Hybrid, type HybridBoxLegs, type HybridResult, type HybridLadder, type HybridLadders, type HybridSettings } from "@/lib/parlay/hybrid";
import type { SwingGame } from "@/lib/parlay/recent-swings";

const FIXTURE = join(__dirname, "__fixtures__", "hybrid-selection-frozen.json");

type FdEvent = { sport_key: string; home_team: string; away_team: string; commence_time: string; bookmakers: { key: string; markets: { key: string; outcomes: HybridLadder["outcomes"] }[] }[] };
const LEAGUE: Record<string, string> = { americanfootball_nfl: "NFL", icehockey_nhl: "NHL", basketball_nba: "NBA" };
const NFL = nflEvent as unknown as FdEvent;
const NHL = nhlEvent as unknown as FdEvent;
const NBA = nbaEvent as unknown as FdEvent;

function laddersOf(ev: FdEvent): HybridLadders[string] {
  const fd = ev.bookmakers.find((b) => b.key === "fanduel")!;
  const out: HybridLadders[string] = {};
  for (const key of ["alternate_spreads", "alternate_totals", "h2h"] as const) {
    const m = fd.markets.find((x) => x.key === key);
    if (m) out[key] = { outcomes: m.outcomes, marketLastUpdate: "2026-10-15T20:00:00.000Z", isStale: false };
  }
  return out;
}

function capper(name: string, wins: number, losses: number, score: number): PositionCapper {
  const n = wins + losses;
  return { capperId: name.toLowerCase(), capperName: name, record: { wins, losses, n, winPct: Math.round((wins / n) * 1000) / 10, source: "LEAGUE" }, recordMarket: "SPREAD", score, postedMarket: "SPREAD", postedLine: null, endorsedLine: 0, posts: 1 };
}

function pos(eventId: string, ev: FdEvent, family: "SIDE" | "TOTAL", direction: string, anchorLine: number, score: number): ConsensusPosition {
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
    anchorIsMoneyline: false,
    postedLines: { hardest: anchorLine, easiest: anchorLine },
    lineSpread: 0,
    supporters: [capper("Ace", 60, 40, 0.5), capper("Bo", 55, 45, 0.45)],
    opposers: [],
    score,
  };
}

function games(team: string, cover: number[], miss: number[]): SwingGame[] {
  return cover.map((c, i) => ({
    date: `2026-10-0${i + 1}T17:00:00.000Z`,
    opponent: `X ${i}`,
    home: i % 2 === 0,
    actualTotal: 44 + miss[i],
    postedTotal: 44,
    totalMiss: miss[i],
    margin: c,
    postedSpread: 0,
    coverMargin: c,
    lineSource: "stored",
    hoursBeforeStart: 4,
  }));
}

type Scenario = { name: string; positions: ConsensusPosition[]; ladders: HybridLadders; swings: Record<string, SwingGame[]> };

function scenarios(): Scenario[] {
  const DEN = NFL.home_team;
  const nflSwings = { [DEN]: games(DEN, [-12, -8, 3, 1, -2], [-9, -5, 0, 0, 0]) };
  // Eight NFL games: in band (+2.5 / Over 45.5) and stuck out of band (+10.5 / Over 35.5), mixed scores;
  // g8's ladder is missing (its box can't be placed).
  const nflPositions: ConsensusPosition[] = [];
  const nflLadders: HybridLadders = {};
  const spec: [string, number, boolean][] = [["g1", 9, false], ["g2", 8, true], ["g3", 7, true], ["g4", 6, false], ["g5", 5, true], ["g6", 4, true], ["g7", 3, false], ["g8", 2, true]];
  for (const [id, score, inBand] of spec) {
    nflPositions.push(pos(id, NFL, "SIDE", DEN, inBand ? 2.5 : 10.5, score), pos(id, NFL, "TOTAL", "OVER", inBand ? 45.5 : 35.5, score));
    if (id !== "g8") nflLadders[id] = laddersOf(NFL);
  }
  // A single-leg position on another game (never a box).
  nflPositions.push(pos("x1", NFL, "SIDE", NFL.away_team, -2.5, 1));
  nflLadders.x1 = laddersOf(NFL);

  const GSW = NBA.away_team;
  const DEN_NBA = NBA.home_team;
  const nbaSwings = { [GSW]: games(GSW, [-12, -20, 0, 0, 0], [-18, -25, 9, 12, 0]), [DEN_NBA]: games(DEN_NBA, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]) };
  const nbaPositions = ["b1", "b2", "b3"].flatMap((id, i) => [pos(id, NBA, "SIDE", GSW, 7.5, 3 - i), pos(id, NBA, "TOTAL", "OVER", 236.5, 3 - i)]);
  const nbaLadders = Object.fromEntries(["b1", "b2", "b3"].map((id) => [id, laddersOf(NBA)]));

  const DET = NHL.home_team;
  const cross: Scenario = {
    name: "cross-game",
    positions: [pos("e1", NFL, "SIDE", DEN, 2.5, 3), pos("e1", NFL, "SIDE", NFL.away_team, -2.5, 2), pos("h1", NHL, "TOTAL", "OVER", 6.5, 1), pos("h2", NHL, "SIDE", DET, 2.5, 1)],
    ladders: { e1: laddersOf(NFL), h1: laddersOf(NHL), h2: laddersOf(NHL) },
    swings: {},
  };
  return [{ name: "nfl-eight", positions: nflPositions, ladders: nflLadders, swings: nflSwings }, { name: "nba-three-leg", positions: nbaPositions, ladders: nbaLadders, swings: nbaSwings }, cross];
}

// Every selection decision, compactly: which legs on which lines at which prices,
// the structure, the boxes, the alternates, the delivery and the note.
function hybridDigest(h: Hybrid | null) {
  if (!h) return null;
  return {
    s: h.structure,
    legs: h.legs.map((l) => [l.positionKey, l.marketKey, l.point, l.price, l.opposite, l.move.rungs]),
    price: Math.round(h.combinedAmerican * 100) / 100,
    est: h.isEstimate,
    inT: h.inTarget,
    boxes: h.boxes?.map((b) => [b.legs.map((l) => l.positionKey).join(","), Math.round(b.combinedAmerican * 100) / 100, b.inTarget]) ?? null,
  };
}
function digest(r: HybridResult) {
  return { p: hybridDigest(r.primary), alts: r.alternates.map(hybridDigest), note: r.note, d: r.delivery };
}

function results(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of scenarios()) {
    for (const maxLegs of [2, 3, 15, 25]) {
      for (const boxLegs of ["2", "3", "auto"] as HybridBoxLegs[]) {
        if (boxLegs === "3" && maxLegs < 3) continue;
        const settings: HybridSettings = { maxLegs, boxLegs };
        out[`${s.name}|${maxLegs}|${boxLegs}`] = digest(optimizeHybrid({ positions: s.positions, ladders: s.ladders, swings: s.swings, settings }));
      }
    }
  }
  return JSON.parse(JSON.stringify(out));
}

if (process.argv.includes("--write")) {
  writeFileSync(FIXTURE, JSON.stringify(results()) + "\n");
  console.log("wrote " + FIXTURE);
  process.exit(0);
}

let failures = 0;
const frozen = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
const now = results();
const keys = Object.keys(frozen);
for (const k of keys) {
  const pass = JSON.stringify(now[k]) === JSON.stringify(frozen[k]);
  console.log(`${pass ? "PASS" : "FAIL"}: selection unchanged · ${k}`);
  if (!pass) failures++;
}
const extra = Object.keys(now).filter((k) => !(k in frozen));
console.log(`${extra.length === 0 && keys.length > 0 ? "PASS" : "FAIL"}: the frozen set covers every case (${keys.length})`);
if (extra.length > 0 || keys.length === 0) failures++;
// The fixture is not trivial: the multi-box path and the cross-game fallback are both in it.
const multi = (frozen["nfl-eight|15|2"] as { p: { s: string; boxes: unknown[] } }).p;
const crossCase = (frozen["cross-game|25|auto"] as { p: { s: string } }).p;
const covers = multi.s === "multi-box" && multi.boxes.length >= 3 && crossCase.s === "cross-game";
console.log(`${covers ? "PASS" : "FAIL"}: the frozen cases include multi-box and cross-game results`);
if (!covers) failures++;

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll frozen selection checks passed.");
process.exit(failures > 0 ? 1 : 0);
