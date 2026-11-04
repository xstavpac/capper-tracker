// Consensus Hybrid's frozen cases for the move onto scoring.ts (PR 8): the 2026-10-27 slate
// (15 games with picks, the cappers' records as the Live board showed them that night), a set of
// single-game consensus cases (the record hierarchy, the lever, hedges, crowds), long dog moneylines
// at real posted prices, the all-leagues-vs-in-league cases and a priced (edge-model) capper.
//
// Read by hybrid-tonight-slate-acceptance-test.ts, hybrid-scoring-acceptance-test.ts and
// hybrid-scoring-frozen-diff-acceptance-test.ts. Uses only what consensus.ts / hybrid.ts already
// exported before PR 8 (an extra `platformRates` on the snapshot and `scorer` in the options are
// ignored there), so the before capture runs this same file on the base commit. Pure - no DB.
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import nhlEvent from "@/lib/parlay/__fixtures__/fanduel-event-nhl.json";
import mlbEvent from "@/lib/parlay/__fixtures__/fanduel-event-mlb.json";
import nbaEvent from "@/lib/parlay/__fixtures__/fanduel-event-nba.json";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { HybridBoxLegs, HybridLadder, HybridLadders } from "@/lib/parlay/hybrid";
import { buildPlatformRates, type PlatformRateRow, type PlatformRates } from "@/lib/parlay/scoring";
import type { CategoryBreakdownItem, PickCategoryKey, PricedColumn } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

export type FdEvent = { home_team: string; away_team: string; commence_time: string; bookmakers: { key: string; markets: { key: string; outcomes: HybridLadder["outcomes"] }[] }[] };
export const EVENTS: Record<string, FdEvent> = { NFL: nflEvent as unknown as FdEvent, NCAAF: nflEvent as unknown as FdEvent, NHL: nhlEvent as unknown as FdEvent, MLB: mlbEvent as unknown as FdEvent, NBA: nbaEvent as unknown as FdEvent };
const TOTAL_LINE: Record<string, number> = { NHL: 6.5, NBA: 234.5, MLB: 7.5, NFL: 44.5, NCAAF: 44.5 };
export const SLATE_NOW = new Date("2026-10-27T22:30:00.000Z");
const START = "2026-10-28T00:00:00.000Z";

export function laddersOf(ev: FdEvent, scale = 1): HybridLadders[string] {
  const fd = ev.bookmakers.find((b) => b.key === "fanduel")!;
  const out: HybridLadders[string] = {};
  for (const key of ["alternate_spreads", "alternate_totals", "h2h"] as const) {
    const m = fd.markets.find((x) => x.key === key);
    // `scale` moves every rung's price (a different FanDuel board); 1 = the fixture as captured.
    if (m) out[key] = { outcomes: scale === 1 ? m.outcomes : m.outcomes.map((o) => ({ ...o, price: Math.round(o.price * scale) })), marketLastUpdate: "2026-10-27T22:00:00.000Z", isStale: false };
  }
  return out;
}

// A pick: a side (home / away, ML or spread) or a total (Over / Under), the capper's all-time and
// in-league records in that bet category, and optionally its posted price and priced history.
type Rec = [number, number];
export type P = {
  capper: string;
  side?: "home" | "away";
  ml?: boolean;
  spread?: number;
  total?: "OVER" | "UNDER";
  all: Rec;
  lg?: Rec;
  // The posted price (absent: -110 with no source, as the 10/27 slate's picks were read).
  odds?: number;
  oddsSource?: "MARKET" | "STATED";
  // Real-priced picks behind the record: in-league and all-leagues (wins, losses, sum of implied probabilities).
  priced?: { lg: [number, number, number]; all: [number, number, number] };
  // The category, where it isn't the one the bet reads as.
  category?: PickCategoryKey;
};
export type G = { id: string; label: string; league: string; picks: P[] };

const col = ([wins, losses]: Rec) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });
const pricedCol = ([wins, losses, impliedSum]: [number, number, number]): PricedColumn => ({ wins, losses, impliedSum });

export type CaseSnapshot = { games: GeneratorGame[]; leagueRecords: CapperLeagueRecords; categoryRecords: Record<string, CategoryBreakdownItem | null>; platformRates?: PlatformRates };

// The games and both record maps, built as the snapshot loader would hand them over.
export function snapshotOfGames(slate: G[], opts: { start?: string; platformRates?: PlatformRates } = {}): CaseSnapshot {
  const start = opts.start ?? START;
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const games = slate.map((g): GeneratorGame => {
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
      category = p.category ?? category;
      const overall = col(p.all);
      leagueRecords.records[p.capper + "|" + g.league + "|" + category] = {
        category,
        label: category,
        overall,
        league: p.lg ? col(p.lg) : { wins: 0, losses: 0, pushes: 0, winPct: 0, count: 0 },
        ...(p.priced ? { priced: { league: pricedCol(p.priced.lg), overall: pricedCol(p.priced.all) } } : {}),
      } as never;
      categoryRecords[p.capper + "|" + category] = { key: category, label: category, ...overall };
      return {
        pickId: g.id + "-" + i, capperId: p.capper, capperName: p.capper, capperColorTag: null, capperIsFavorite: false,
        category, leagueName: g.league, gameId: g.id, gameLabel: g.label, betDetail: detail, odds: p.odds ?? -110, units: 1, status: "PENDING",
        ...(p.oddsSource ? { oddsSource: p.oddsSource } : {}),
        betType, period: "FULL_GAME", rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime: start,
        teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2026-10-27T12:00:00.000Z", gameNumber: null,
      } as unknown as GeneratorPick;
    });
    return { gameId: g.id, gameLabel: g.label, gameTime: start, leagueName: g.league, picks } as GeneratorGame;
  });
  return { games, leagueRecords, categoryRecords, ...(opts.platformRates ? { platformRates: opts.platformRates } : {}) };
}

// ---------------------------------------------------------------------------
// The 2026-10-27 slate. Records are the Live board's (all-time, in-league) where it showed them; the
// box games' other cappers are filled in at qualifying records, the skipped games' at the records that
// stopped them. Teams are the FanDuel fixtures' (one per league) so the ladders price; the labels are the
// real matchups.
// ---------------------------------------------------------------------------
export const SLATE_10_27: G[] = [
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

// ---------------------------------------------------------------------------
// The other cases: one game each unless noted. Teams are the fixtures'.
// ---------------------------------------------------------------------------
// The platform's NHL dog-moneyline rate at ~38% (what lets a 0-for-N dog capper pass on the prior alone
// without the long-shot rule), and an NHL total rate near 50%.
const NHL_RATES: PlatformRateRow[] = [
  { league: "NHL", betType: "MONEYLINE", key: "DOG_ML", wins: 380, losses: 620, impliedSum: 360, priced: 1000 },
  { league: "NHL", betType: "MONEYLINE", key: "FAV_ML", wins: 590, losses: 410, impliedSum: 600, priced: 1000 },
  { league: "NHL", betType: "TOTAL", key: "OVER", wins: 500, losses: 500, impliedSum: 524, priced: 1000 },
  { league: "NHL", betType: "TOTAL", key: "UNDER", wins: 505, losses: 495, impliedSum: 524, priced: 1000 },
];
export const CASE_RATES = buildPlatformRates(NHL_RATES);

export type FrozenCase = { name: string; slate: G[]; platformRates?: PlatformRates; ladders: boolean; maxLegs: number; boxLegs: HybridBoxLegs };

export const FROZEN_CASES: FrozenCase[] = [
  { name: "slate-10-27", slate: SLATE_10_27, ladders: true, maxLegs: 15, boxLegs: "auto" },
  { name: "slate-10-27 (3 legs, cap 6)", slate: SLATE_10_27, ladders: true, maxLegs: 6, boxLegs: "3" },
  // The record hierarchy: in-league vs all-leagues, the two ways round.
  { name: "all-leagues vs in-league", ladders: true, maxLegs: 4, boxLegs: "2", slate: [
    // 30-20 all leagues but 2-8 in the NFL: the in-league-first score fails 55, the all-leagues one passes.
    { id: "AL1", label: "all-leagues capper", league: "NFL", picks: [
      { capper: "Wide", side: "away", spread: 3.5, all: [30, 20], lg: [2, 8] },
      { capper: "Tot1", total: "OVER", all: [14, 6], lg: [14, 6] },
    ] },
    // 8-0 in the NFL but 20-30 all leagues: in-league first carries it.
    { id: "AL2", label: "in-league capper", league: "NFL", picks: [
      { capper: "Local", side: "home", spread: -2.5, all: [20, 30], lg: [8, 0] },
      { capper: "Tot2", total: "UNDER", all: [12, 8] },
    ] },
    // 2-0 all time: Wilson's 2-0 is weak, the shrunk 2-0 sits near the prior.
    { id: "AL3", label: "tiny sample", league: "NFL", picks: [
      { capper: "Tiny", side: "home", spread: -1.5, all: [2, 0], lg: [2, 0] },
      { capper: "Mid", side: "away", spread: 1.5, all: [11, 8], lg: [11, 8] },
      { capper: "Tot3", total: "OVER", all: [9, 5] },
    ] },
  ] },
  // Long dog moneylines at real posted prices, on the NHL platform rates.
  { name: "long dogs", platformRates: CASE_RATES, ladders: true, maxLegs: 6, boxLegs: "2", slate: [
    { id: "LD1", label: "0-3 at +300", league: "NHL", picks: [
      { capper: "Zero", side: "home", ml: true, all: [0, 3], lg: [0, 3], odds: 300, oddsSource: "STATED" },
      { capper: "Ov1", total: "OVER", all: [12, 8], lg: [12, 8] },
    ] },
    { id: "LD2", label: "6-14 at +250", league: "NHL", picks: [
      { capper: "SixFourteen", side: "home", ml: true, all: [6, 14], lg: [6, 14], odds: 250, oddsSource: "STATED" },
      { capper: "Fav1", side: "away", ml: true, all: [10, 9], lg: [10, 9], odds: -150, oddsSource: "STATED", category: "FAV_ML" },
      { capper: "Un1", total: "UNDER", all: [13, 9], lg: [13, 9] },
    ] },
    { id: "LD3", label: "14-16 at +400", league: "NHL", picks: [
      { capper: "Fourteen", side: "home", ml: true, all: [14, 16], lg: [14, 16], odds: 400, oddsSource: "STATED" },
      { capper: "Ov2", total: "OVER", all: [11, 7], lg: [11, 7] },
    ] },
    { id: "LD4", label: "1-4 at +200", league: "NHL", picks: [
      { capper: "OneFour", side: "home", ml: true, all: [1, 4], lg: [1, 4], odds: 200, oddsSource: "STATED" },
      { capper: "Ov3", total: "OVER", all: [10, 6], lg: [10, 6] },
    ] },
  ] },
  // An edge-model capper: 60-40 lifetime at -110 on spreads, posting at +150.
  { name: "priced capper", ladders: true, maxLegs: 4, boxLegs: "2", slate: [
    { id: "PR1", label: "edge model", league: "NFL", picks: [
      { capper: "Priced", side: "away", spread: 6.5, all: [60, 40], lg: [30, 20], odds: 150, oddsSource: "MARKET", priced: { lg: [30, 20, 26.19], all: [60, 40, 52.38] } },
      { capper: "Crowd1", side: "home", spread: -6.5, all: [15, 10], lg: [15, 10] },
      { capper: "Tot4", total: "OVER", all: [13, 7], lg: [13, 7] },
    ] },
  ] },
  // Single-game consensus shapes (no box needed: positions and the diagnostic only).
  { name: "consensus shapes", ladders: false, maxLegs: 4, boxLegs: "2", slate: [
    { id: "CS1", label: "crowd vs one strong", league: "NFL", picks: [
      { capper: "O1", total: "OVER", all: [6, 4], lg: [6, 4] },
      { capper: "O2", total: "OVER", all: [6, 4], lg: [6, 4] },
      { capper: "O3", total: "OVER", all: [6, 4], lg: [6, 4] },
      { capper: "U1", total: "UNDER", all: [30, 10], lg: [30, 10] },
    ] },
    { id: "CS2", label: "hedged strong capper", league: "NFL", picks: [
      { capper: "H", total: "OVER", all: [90, 10], lg: [90, 10] },
      { capper: "H", total: "UNDER", all: [90, 10], lg: [90, 10] },
      { capper: "U", total: "UNDER", all: [7, 3], lg: [7, 3] },
    ] },
    { id: "CS3", label: "50-40 in-league, 2-0 all", league: "NFL", picks: [
      { capper: "A", side: "home", spread: -3, all: [2, 0], lg: [50, 40] },
      { capper: "B", side: "home", spread: -3, all: [7, 3], lg: [7, 3] },
    ] },
    { id: "CS4", label: "0-5 weak capper", league: "NFL", picks: [{ capper: "W", total: "OVER", all: [0, 5], lg: [0, 5] }] },
    { id: "CS5", label: "52% record", league: "NFL", picks: [
      { capper: "C", side: "home", spread: -3, all: [13, 12], lg: [13, 12] },
      { capper: "D", side: "away", spread: 3, all: [6, 4], lg: [6, 4] },
    ] },
  ] },
];

export const FROZEN_GATES = [0, 45, 55, 60] as const;

export function caseSnapshot(c: FrozenCase): CaseSnapshot {
  return snapshotOfGames(c.slate, { platformRates: c.platformRates });
}

export function caseLadders(c: FrozenCase, scale = 1): HybridLadders {
  return c.ladders ? Object.fromEntries(c.slate.map((g) => [g.id, laddersOf(EVENTS[g.league], scale)])) : {};
}
