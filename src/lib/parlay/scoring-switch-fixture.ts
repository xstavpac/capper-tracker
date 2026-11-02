// The frozen slate the scoring switch is compared on (scoring-switch-diff-acceptance-test.ts,
// scoring-wiring-acceptance-test.ts): NFL and NBA only, every price rule, thin and edge-model cappers, a pick with
// only an other-leagues record, a prop, and slip picks. Hand-built numbers, not production data.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import { breakEvenOf, buildPlatformRates, trimPlatformRates, type PlatformRateRow } from "@/lib/parlay/scoring";
import { propMarketKey } from "@/lib/prop-market-key";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey, PricedColumn } from "@/server/data/stats";

export const NOW = new Date("2026-11-08T14:00:00.000Z");

const col = (w: number, l: number) => ({ wins: w, losses: l, pushes: 0, winPct: w + l === 0 ? 0 : (w / (w + l)) * 100, count: w + l });
type WL = [number, number];

export type Spec = {
  id: string;
  game: number;
  category: PickCategoryKey;
  betType: string;
  detail: string;
  line?: number;
  odds: number;
  source: "STATED" | "MARKET" | "DEFAULTED" | null;
  // In-league and all-leagues records.
  lg: WL;
  all?: WL;
  // The price the capper's history was priced at; null: no priced picks.
  hist?: number | null;
  propMarket?: string;
};

const GAMES: { league: string; home: string; away: string; nick: string }[] = [
  { league: "NFL", home: "Kansas City Chiefs", away: "Los Angeles Chargers", nick: "Chiefs" },
  { league: "NFL", home: "Buffalo Bills", away: "Miami Dolphins", nick: "Bills" },
  { league: "NFL", home: "Philadelphia Eagles", away: "Dallas Cowboys", nick: "Eagles" },
  { league: "NFL", home: "Detroit Lions", away: "Chicago Bears", nick: "Lions" },
  { league: "NBA", home: "Boston Celtics", away: "New York Knicks", nick: "Celtics" },
  { league: "NBA", home: "Denver Nuggets", away: "Phoenix Suns", nick: "Nuggets" },
];

export const SPECS: Spec[] = [
  // Game 0: a side, and a total the side can hedge to. 6-4 passes the raw gate, not the shrunk one.
  { id: "g0-elite-spread", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Chiefs -3", line: -3, odds: -110, source: "STATED", lg: [18, 4], hist: -110 },
  { id: "g0-small-spread", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Chiefs -2.5", line: -2.5, odds: -110, source: "MARKET", lg: [6, 4], hist: -110 },
  { id: "g0-over", game: 0, category: "OVER", betType: "TOTAL", detail: "Over 44.5", line: 44.5, odds: -110, source: "STATED", lg: [60, 40], hist: -110 },
  { id: "g0-small-over", game: 0, category: "OVER", betType: "TOTAL", detail: "Over 45.5", line: 45.5, odds: -110, source: null, lg: [14, 2], hist: -110 },
  { id: "g0-dog-ml", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Chargers ML", odds: 150, source: "MARKET", lg: [11, 9], hist: 150 },
  // Game 1: raw 55.0 flips; a 50% capper at a long price passes on edge, not on win %.
  { id: "g1-55-45", game: 1, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Bills -6", line: -6, odds: -110, source: "STATED", lg: [55, 45], hist: -110 },
  { id: "g1-longshot", game: 1, category: "DOG_ML", betType: "MONEYLINE", detail: "Dolphins ML", odds: 200, source: "MARKET", lg: [10, 10], hist: 200 },
  // Game 2: the same record at a heavy price against a mid record at -110.
  { id: "g2-heavy-fav", game: 2, category: "FAV_ML", betType: "MONEYLINE", detail: "Eagles ML", odds: -1000, source: "MARKET", lg: [18, 4], hist: -110 },
  { id: "g2-mid-under", game: 2, category: "UNDER", betType: "TOTAL", detail: "Under 47.5", line: 47.5, odds: -110, source: null, lg: [30, 20], hist: -110 },
  // Game 3: no real price (NULL -110 moneyline, and DEFAULTED); thin at a real -110.
  { id: "g3-no-price", game: 3, category: "FAV_ML", betType: "MONEYLINE", detail: "Lions ML", odds: -110, source: null, lg: [30, 10], hist: null },
  { id: "g3-defaulted", game: 3, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Lions -7", line: -7, odds: -110, source: "DEFAULTED", lg: [40, 25], hist: null },
  { id: "g3-thin", game: 3, category: "UNDER", betType: "TOTAL", detail: "Under 50.5", line: 50.5, odds: -110, source: "STATED", lg: [3, 1], hist: null },
  // Game 4: an other-leagues record only, and a prop on its own market.
  { id: "g4-other-leagues", game: 4, category: "OVER", betType: "TOTAL", detail: "Over 221.5", line: 221.5, odds: -110, source: "STATED", lg: [0, 0], all: [16, 4], hist: -110 },
  { id: "g4-prop", game: 4, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 27.5 Points", line: 27.5, odds: -115, source: "MARKET", lg: [20, 10], hist: -115, propMarket: "POINTS" },
  { id: "g4-no-record", game: 4, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Celtics -4", line: -4, odds: -110, source: "STATED", lg: [0, 0], hist: null },
  // Game 5: side against side, for Contrarian.
  { id: "g5-home", game: 5, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Nuggets -5", line: -5, odds: -110, source: "STATED", lg: [25, 12], hist: -110 },
  { id: "g5-away", game: 5, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Suns +5", line: 5, odds: -105, source: "MARKET", lg: [22, 12], hist: -105 },
];

export const RATE_ROWS: PlatformRateRow[] = [
  { league: "NFL", betType: "SPREAD", key: "SPREAD_MINUS", wins: 520, losses: 480, impliedSum: 523.8, priced: 1000 },
  { league: "NFL", betType: "TOTAL", key: "OVER", wins: 510, losses: 490, impliedSum: 523.8, priced: 1000 },
  { league: "NFL", betType: "TOTAL", key: "UNDER", wins: 515, losses: 485, impliedSum: 523.8, priced: 1000 },
  { league: "NFL", betType: "MONEYLINE", key: "FAV_ML", wins: 620, losses: 380, impliedSum: 640, priced: 1000 },
  { league: "NFL", betType: "MONEYLINE", key: "DOG_ML", wins: 380, losses: 620, impliedSum: 400, priced: 1000 },
  { league: "NBA", betType: "TOTAL", key: "OVER", wins: 505, losses: 495, impliedSum: 523.8, priced: 1000 },
  { league: "NBA", betType: "SPREAD", key: "SPREAD_MINUS", wins: 500, losses: 500, impliedSum: 523.8, priced: 1000 },
  { league: "NBA", betType: "SPREAD", key: "SPREAD_PLUS", wins: 520, losses: 480, impliedSum: 523.8, priced: 1000 },
  { league: "NBA", betType: "PLAYER_PROP", key: "basketball:POINTS", wins: 530, losses: 470, impliedSum: 535, priced: 1000 },
];

const pricedColumn = ([w, l]: WL, hist: number | null | undefined): PricedColumn =>
  hist == null ? { wins: 0, losses: 0, impliedSum: 0 } : { wins: w, losses: l, impliedSum: (w + l) * breakEvenOf(hist)! };

export function pickOf(s: Spec): GeneratorPick {
  const g = GAMES[s.game];
  return {
    pickId: s.id, capperId: "c-" + s.id, capperName: "Capper " + s.id, capperColorTag: null, capperIsFavorite: false, category: s.category,
    leagueName: g.league, gameId: "g" + s.game, gameLabel: g.away + " @ " + g.home, betDetail: s.detail, odds: s.odds, oddsSource: s.source, units: 1, status: "PENDING",
    betType: s.betType, period: "FULL_GAME", rawBetDetail: s.detail, propMarket: s.propMarket ?? null, line: s.line ?? null, homeTeam: g.home, awayTeam: g.away,
    gameTime: new Date(NOW.getTime() + (3 + s.game) * 3600_000).toISOString(), teamGroup: "HOME", teamLabel: "", teamColor: null,
    datePosted: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), gameNumber: null,
  } as unknown as GeneratorPick;
}

export function buildSnapshot(specs: Spec[] = SPECS, slipIds: string[] = [], rows: PlatformRateRow[] = RATE_ROWS): GeneratorSnapshot {
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const propMarketRecords: Record<string, PropMarketRecord | null> = {};
  const picks = specs.map(pickOf);
  specs.forEach((s, i) => {
    const pick = picks[i];
    const all = s.all ?? s.lg;
    const key = propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });
    if (key) {
      propMarketRecords[propMarketRecordKey(pick.capperId, pick.leagueName, key)] = {
        key,
        league: col(...s.lg),
        allTime: col(...all),
        priced: { league: pricedColumn(s.lg, s.hist), allTime: pricedColumn(all, s.hist) },
      };
      return;
    }
    const overall = col(...all);
    if (overall.count === 0) {
      leagueRecords.records[leagueRecordKey(pick.capperId, pick.leagueName, s.category)] = null;
      return;
    }
    categoryRecords[categoryRecordKey(pick.capperId, s.category)] = { key: s.category, label: s.category, ...overall };
    leagueRecords.records[leagueRecordKey(pick.capperId, pick.leagueName, s.category)] = {
      category: s.category,
      label: s.category,
      overall,
      league: col(...s.lg),
      priced: { overall: pricedColumn(all, s.hist), league: pricedColumn(s.lg, s.hist) },
    };
  });
  const games: GeneratorGame[] = GAMES.map((g, i) => {
    const onGame = picks.filter((p) => p.gameId === "g" + i);
    return { gameId: "g" + i, gameLabel: g.away + " @ " + g.home, gameTime: new Date(NOW.getTime() + (3 + i) * 3600_000).toISOString(), leagueName: g.league, picks: onGame };
  }).filter((g) => g.picks.length > 0);
  const slipPicks = picks.filter((p) => slipIds.includes(p.pickId));
  return {
    builtAt: NOW.toISOString(),
    games,
    slipPicks,
    targets: [],
    leagueRecords,
    categoryRecords,
    propMarketRecords,
    platformRates: trimPlatformRates(buildPlatformRates(rows), picks),
    platformRateRows: rows.length,
  };
}
