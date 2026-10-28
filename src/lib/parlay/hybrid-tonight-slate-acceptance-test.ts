// Consensus Hybrid's one-strong-capper rule on a slate shaped like 2026-10-27's:
// 15 games with picks, the cappers' real records as the Live board showed them that
// night (all-time and in-league, by bet category). Under the old two-cappers-agree
// rule only Brewers @ Rays formed a box; under the new rule five games do, each leg
// driven by one capper (the side and the total can be different cappers). The
// other ten are skipped for the reason "Why only N games?" gives. Teams are the
// FanDuel fixtures' (one per league) so the ladders price; the game labels are
// the real matchups. Pure - no DB, no fetch.
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts            check
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts --digest   print the selection digest
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import nhlEvent from "@/lib/parlay/__fixtures__/fanduel-event-nhl.json";
import mlbEvent from "@/lib/parlay/__fixtures__/fanduel-event-mlb.json";
import nbaEvent from "@/lib/parlay/__fixtures__/fanduel-event-nba.json";
import { buildConsensusPositions } from "@/lib/parlay/consensus";
import { boxEligibleGames, optimizeHybridReport, type HybridLadder, type HybridLadders } from "@/lib/parlay/hybrid";
import { explainSkips } from "@/lib/parlay/hybrid-diagnostics";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type FdEvent = { home_team: string; away_team: string; commence_time: string; bookmakers: { key: string; markets: { key: string; outcomes: HybridLadder["outcomes"] }[] }[] };
const EVENTS: Record<string, FdEvent> = { NFL: nflEvent as unknown as FdEvent, NCAAF: nflEvent as unknown as FdEvent, NHL: nhlEvent as unknown as FdEvent, MLB: mlbEvent as unknown as FdEvent, NBA: nbaEvent as unknown as FdEvent };
const TOTAL_LINE: Record<string, number> = { NHL: 6.5, NBA: 234.5, MLB: 7.5, NFL: 44.5, NCAAF: 44.5 };
const NOW = new Date("2026-10-27T22:30:00.000Z");
const START = "2026-10-28T00:00:00.000Z";

function laddersOf(ev: FdEvent): HybridLadders[string] {
  const fd = ev.bookmakers.find((b) => b.key === "fanduel")!;
  const out: HybridLadders[string] = {};
  for (const key of ["alternate_spreads", "alternate_totals", "h2h"] as const) {
    const m = fd.markets.find((x) => x.key === key);
    if (m) out[key] = { outcomes: m.outcomes, marketLastUpdate: "2026-10-27T22:00:00.000Z", isStale: false };
  }
  return out;
}

// A pick: a side (home / away, ML or spread) or a total (Over / Under), and the capper's
// all-time and in-league records in that bet category.
type Rec = [number, number];
type P = { capper: string; side?: "home" | "away"; ml?: boolean; spread?: number; total?: "OVER" | "UNDER"; all: Rec; lg?: Rec };
type G = { id: string; label: string; league: string; picks: P[] };

const records: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
const col = ([wins, losses]: Rec) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });

function toGame(g: G): GeneratorGame {
  const ev = EVENTS[g.league];
  const home = ev.home_team;
  const away = ev.away_team;
  const picks = g.picks.map((p, i) => {
    let betType: string;
    let detail: string;
    let line: number | null;
    let category: PickCategoryKey;
    if (p.total) {
      betType = "TOTAL";
      line = TOTAL_LINE[g.league];
      detail = (p.total === "OVER" ? "Over " : "Under ") + line;
      category = p.total;
    } else {
      const team = p.side === "home" ? home : away;
      if (p.ml) {
        betType = "MONEYLINE";
        line = null;
        detail = team + " ML";
        category = p.side === "home" ? "DOG_ML" : "FAV_ML";
      } else {
        betType = "SPREAD";
        line = p.spread!;
        detail = team + " " + (line > 0 ? "+" : "") + line;
        category = line > 0 ? "SPREAD_PLUS" : "SPREAD_MINUS";
      }
    }
    const overall = col(p.all);
    records.records[p.capper + "|" + g.league + "|" + category] = { category, label: category, overall, league: p.lg ? col(p.lg) : { wins: 0, losses: 0, pushes: 0, winPct: 0, count: 0 } } as never;
    categoryRecords[p.capper + "|" + category] = { key: category, label: category, ...overall };
    return {
      pickId: g.id + "-" + i, capperId: p.capper, capperName: p.capper, capperColorTag: null, capperIsFavorite: false,
      category, leagueName: g.league, gameId: g.id, gameLabel: g.label, betDetail: detail, odds: -110, units: 1, status: "PENDING",
      betType, period: "FULL_GAME", rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime: START,
      teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2026-10-27T12:00:00.000Z", gameNumber: null,
    } as unknown as GeneratorPick;
  });
  return { gameId: g.id, gameLabel: g.label, gameTime: START, leagueName: g.league, picks } as GeneratorGame;
}

// The slate. Records are the Live board's (all-time, in-league) where it showed them;
// the box games' other cappers are filled in at qualifying records, the skipped
// games' at the records that stopped them.
const SLATE: G[] = [
  { id: "MLB1", label: "Brewers @ Rays", league: "MLB", picks: [
    { capper: "Sharp Sheet", side: "home", ml: true, all: [20, 14], lg: [13, 6] },
    { capper: "LOCKS by Tommy", side: "home", ml: true, all: [30, 22] },
    { capper: "R2", side: "home", ml: true, all: [20, 15] },
    { capper: "R3", side: "home", ml: true, all: [18, 12] },
    { capper: "R4", side: "home", ml: true, all: [25, 19] },
    { capper: "R5", side: "home", ml: true, all: [12, 9] },
    { capper: "BEEZOWINS", side: "away", ml: true, all: [32, 23], lg: [28, 18] },
    { capper: "Proven winner", side: "away", ml: true, all: [10, 9], lg: [9, 7] },
    { capper: "MRBIGBETS", side: "away", ml: true, all: [37, 39], lg: [31, 35] },
    { capper: "BEEZOWINS", total: "OVER", all: [29, 16], lg: [11, 3] },
    { capper: "Shark", total: "OVER", all: [20, 14] },
    { capper: "Smart Money Sports", total: "UNDER", all: [12, 9] },
    { capper: "Porter PICKS", total: "UNDER", all: [12, 19], lg: [1, 6] },
  ] },
  { id: "NHL1", label: "Kings @ Blackhawks", league: "NHL", picks: [
    { capper: "KLEOS", side: "away", ml: true, all: [2, 5], lg: [2, 3] },
    { capper: "SHARP", side: "home", ml: true, all: [15, 8], lg: [5, 0] },
    { capper: "KIMSPICKS", side: "home", ml: true, all: [19, 9], lg: [7, 1] },
    { capper: "Analytics capper", side: "home", ml: true, all: [10, 8] },
    { capper: "BEEZOWINS", total: "OVER", all: [29, 16], lg: [6, 3] },
    { capper: "PARLAY SAFARI", total: "OVER", all: [10, 17], lg: [2, 3] },
  ] },
  { id: "NBA1", label: "Trail Blazers @ Lakers", league: "NBA", picks: [
    { capper: "Porter PICKS", side: "away", spread: 3, all: [47, 23], lg: [4, 1] },
    { capper: "BEEZOWINS", side: "away", spread: 2.5, all: [42, 40], lg: [2, 2] },
    { capper: "B1", side: "away", spread: 3, all: [30, 24] },
    { capper: "B2", side: "away", spread: 3.5, all: [22, 17] },
    { capper: "L1", side: "home", spread: -3, all: [14, 10] },
    { capper: "L2", side: "home", spread: -2.5, all: [11, 8] },
    { capper: "BET LABS", total: "UNDER", all: [7, 3] },
    { capper: "O1", total: "OVER", all: [9, 12] },
  ] },
  { id: "NHL2", label: "Devils @ Stars", league: "NHL", picks: [
    { capper: "YDC", side: "away", ml: true, all: [20, 16], lg: [7, 1] },
    { capper: "D2", side: "away", ml: true, all: [15, 11] },
    { capper: "D3", side: "away", ml: true, all: [12, 9] },
    { capper: "S1", side: "home", ml: true, all: [11, 8] },
    { capper: "Porter PICKS", total: "UNDER", all: [12, 19], lg: [4, 2] },
    { capper: "O2", total: "OVER", all: [5, 4] },
  ] },
  { id: "NHL3", label: "Senators @ Golden Knights", league: "NHL", picks: [
    { capper: "Duck", side: "home", ml: true, all: [26, 20] },
    { capper: "Pardon My Pick", total: "OVER", all: [13, 6] },
  ] },
  // Skipped under both rules.
  { id: "NHL4", label: "Bruins @ Hurricanes", league: "NHL", picks: [
    { capper: "YDC2", side: "away", ml: true, all: [47, 52] },
    { capper: "H1", side: "home", ml: true, all: [10, 12] },
    { capper: "PATSPICKS", total: "OVER", all: [8, 8] },
    { capper: "U4", total: "UNDER", all: [5, 7] },
  ] },
  { id: "NHL5", label: "Panthers @ Jets", league: "NHL", picks: [
    { capper: "F1", side: "away", ml: true, all: [20, 12] },
    { capper: "J1", side: "home", ml: true, all: [14, 9] },
    { capper: "J2", side: "home", ml: true, all: [11, 9] },
  ] },
  { id: "NHL6", label: "Islanders @ Predators", league: "NHL", picks: [{ capper: "U6", total: "UNDER", all: [14, 10] }] },
  { id: "NHL7", label: "Canucks @ Ducks", league: "NHL", picks: [
    { capper: "Porter PICKS", total: "OVER", all: [33, 28], lg: [9, 2] },
    { capper: "O7", total: "OVER", all: [16, 12] },
  ] },
  { id: "NHL8", label: "Sabres @ Sharks", league: "NHL", picks: [
    { capper: "B Bank", side: "away", ml: true, all: [22, 20] },
    { capper: "O8a", total: "OVER", all: [20, 15] },
    { capper: "O8b", total: "OVER", all: [14, 10] },
  ] },
  { id: "NBA2", label: "Pistons @ Knicks", league: "NBA", picks: [
    { capper: "Duck", side: "away", spread: 4.5, all: [18, 14], lg: [4, 2] },
    { capper: "DPATT", side: "away", spread: 5.5, all: [15, 8] },
    { capper: "K1", side: "home", spread: -5.5, all: [20, 15] },
    { capper: "MRBIGBETS", total: "OVER", all: [27, 27] },
  ] },
  { id: "NBA3", label: "Kings @ Spurs", league: "NBA", picks: [
    { capper: "SK1", side: "away", spread: 2.5, all: [12, 8] },
    { capper: "NICKYCASHIN", total: "OVER", all: [8, 11] },
  ] },
  { id: "NHL9", label: "Canadiens @ Blues", league: "NHL", picks: [
    { capper: "C1", side: "away", ml: true, all: [16, 12] },
    { capper: "B9", side: "home", ml: true, all: [13, 10] },
  ] },
  { id: "NHL10", label: "Wild @ Mammoth", league: "NHL", picks: [
    { capper: "Porter PICKS", side: "away", ml: true, all: [23, 14], lg: [5, 3] },
    { capper: "M10", side: "home", ml: true, all: [12, 9] },
    { capper: "PATSPICKS", total: "OVER", all: [8, 8] },
  ] },
  // An NCAAF game that night; run as NFL, since the NFL fixture's teams don't read as NCAAF teams.
  { id: "CF1", label: "Sam Houston State @ Missouri State", league: "NFL", picks: [{ capper: "SH1", side: "away", spread: -3, all: [30, 20] }] },
];

const games = SLATE.map(toGame);
const snapshot: Pick<GeneratorSnapshot, "games" | "leagueRecords" | "categoryRecords"> = { games, leagueRecords: records, categoryRecords };
const positions = buildConsensusPositions(snapshot, { now: NOW, minWinPct: 55 });
const ladders: HybridLadders = Object.fromEntries(SLATE.map((g) => [g.id, laddersOf(EVENTS[g.league])]));
const labelOf = (id: string) => SLATE.find((g) => g.id === id)!.label;
const driver = (p: { supporters: { capperName: string }[]; direction: string }) => `${p.supporters[0].capperName}: ${p.direction}`;
const boxes = boxEligibleGames(positions);
const { result, report } = optimizeHybridReport({ positions, ladders, swings: {}, settings: { maxLegs: 15, boxLegs: "auto" } });

function digest() {
  const left = explainSkips({ games, pickCounts: Object.fromEntries(games.map((g) => [g.gameId, g.picks.length])), snapshotSkipped: [], records: snapshot, minWinPct: 55, filtered: false, positions, candidateEvents: boxes.map((b) => b.eventId), notes: [], report, result });
  return {
    leftOut: left.skipped.map((r) => [labelOf(r.eventId), r.text]),
    boxGames: boxes.map((b) => [labelOf(b.eventId), driver(b.side), driver(b.total)]),
    parlay: result.primary ? { structure: result.primary.structure, games: Array.from(new Set(result.primary.legs.map((l) => labelOf(l.eventId)))), legs: result.primary.legs.length, delivery: result.delivery } : null,
  };
}
if (process.argv.includes("--digest")) {
  console.log(JSON.stringify(digest(), null, 2));
  process.exit(0);
}

// ---- Which games form a box, and who drives each leg ----
check("five games form a box (the old rule found one)", boxes.map((b) => labelOf(b.eventId)).sort(), ["Brewers @ Rays", "Devils @ Stars", "Kings @ Blackhawks", "Senators @ Golden Knights", "Trail Blazers @ Lakers"]);
const legOf = (label: string) => {
  const b = boxes.find((x) => labelOf(x.eventId) === label)!;
  return { side: [b.side.supporters[0].capperName, b.side.direction], total: [b.total.supporters[0].capperName, b.total.direction] };
};
check("Brewers @ Rays: Sharp Sheet on the Rays ML (13-6 in MLB) beats BEEZOWINS on the Brewers; BEEZOWINS' Over (11-3) drives the total", legOf("Brewers @ Rays"), { side: ["Sharp Sheet", EVENTS.MLB.home_team], total: ["BEEZOWINS", "OVER"] });
check("Kings @ Blackhawks: SHARP 5-0 on the home ML; BEEZOWINS alone on the Over", legOf("Kings @ Blackhawks"), { side: ["SHARP", EVENTS.NHL.home_team], total: ["BEEZOWINS", "OVER"] });
check("Trail Blazers @ Lakers: Porter PICKS 47-23 on the road spread; BET LABS 7-3 alone on the Under", legOf("Trail Blazers @ Lakers"), { side: ["Porter PICKS", EVENTS.NBA.away_team], total: ["BET LABS", "UNDER"] });
check("Devils @ Stars: YDC 7-1 on the road ML; the Under (Porter 4-2 in NHL) beats a 5-4 Over", legOf("Devils @ Stars"), { side: ["YDC", EVENTS.NHL.away_team], total: ["Porter PICKS", "UNDER"] });
check("Senators @ Golden Knights: Duck alone on the home ML, Pardon My Pick alone on the Over - different cappers make a box", legOf("Senators @ Golden Knights"), { side: ["Duck", EVENTS.NHL.home_team], total: ["Pardon My Pick", "OVER"] });

// ---- One position per family per game: the losing direction yields none ----
const onGame = (id: string) => positions.filter((p) => p.eventId === id).map((p) => p.family + ":" + p.direction).sort();
check("Devils @ Stars: one side and one total position, the losers gone", onGame("NHL2"), ["SIDE:" + EVENTS.NHL.away_team, "TOTAL:UNDER"]);
check("Brewers @ Rays: no Brewers position and no Under position", onGame("MLB1"), ["SIDE:" + EVENTS.MLB.home_team, "TOTAL:OVER"]);
const rays = positions.find((p) => p.eventId === "MLB1" && p.family === "SIDE")!;
check("the losing direction's cappers ride along as opposers, without moving the score", [rays.opposers.map((c) => c.capperName), rays.score === rays.supporters[0].score], [["BEEZOWINS", "Proven winner"], true]);
check("agreeing cappers are kept (confidence), the strongest first", rays.supporters.map((c) => c.capperName).slice(0, 2), ["Sharp Sheet", "LOCKS by Tommy"]);

// ---- The parlay at 15 legs ----
check("cap 15: a multi-box parlay of the five games", [result.primary?.structure, Array.from(new Set(result.primary?.legs.map((l) => labelOf(l.eventId)))).sort()], ["multi-box", ["Brewers @ Rays", "Devils @ Stars", "Kings @ Blackhawks", "Senators @ Golden Knights", "Trail Blazers @ Lakers"]]);
check("cap 15: delivery says how many came out of 15, all five games used", [result.delivery.requestedLegs, result.delivery.boxes, result.delivery.qualifyingGames], [15, 5, 5]);
check("cap 15: no box was lost to a missing line", report.noLine, []);

// ---- Why the other ten were left out - and "needs 2" never appears ----
const d = explainSkips({
  games,
  pickCounts: Object.fromEntries(games.map((g) => [g.gameId, g.picks.length])),
  snapshotSkipped: [],
  records: snapshot,
  minWinPct: 55,
  filtered: false,
  positions,
  candidateEvents: boxes.map((b) => b.eventId),
  notes: [],
  report,
  result,
});
const why = Object.fromEntries(d.skipped.map((r) => [labelOf(r.eventId), r.text]));
check("ten games left out", d.skipped.length, 10);
check("why: the side's best capper is below 55%", [why["Bruins @ Hurricanes"], why["Sabres @ Sharks"]], [`Best ${EVENTS.NHL.away_team} capper 47% (47-52), needs 55%`, `Best ${EVENTS.NHL.away_team} capper 52% (22-20), needs 55%`]);
check("why: the total's best capper is below 55%", [why["Pistons @ Knicks"], why["Kings @ Spurs"], why["Wild @ Mammoth"]], ["Best Over capper 50% (27-27), needs 55%", "Best Over capper 42% (8-11), needs 55%", "Best Over capper 50% (8-8), needs 55%"]);
check("why: no total picks", [why["Panthers @ Jets"], why["Canadiens @ Blues"], why["Sam Houston State @ Missouri State"]], ["No full-game total picks", "No full-game total picks", "No full-game total picks"]);
check("why: no side picks", [why["Islanders @ Predators"], why["Canucks @ Ducks"]], ["No full-game side picks (spread or moneyline)", "No full-game side picks (spread or moneyline)"]);
check("no game is held back for too few cappers agreeing", d.skipped.some((r) => r.reason === "not-enough-supporters" || r.text.includes("needs 2")), false);

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll tonight-slate checks passed.");
process.exit(failures > 0 ? 1 : 0);
