// The NBA same-game fix's frozen diff (nba-samegame-frozen-diff-acceptance-test.ts): every Contrarian case
// (contrarian-frozen-cases.ts) plus an NBA slate built to stack props on their games - two players, one
// player on several stats, Over vs Under on one stat, one stat at two lines, game totals both ways, and the
// non-offensive stats (rebounds, steals, blocks) beside a game Under. nba-samegame-before-frozen.json holds
// the engine's output on these cases at 53ad4f5 (before the fix) and after step 1 (same-game rules only).
// Pure - no DB.
import type { GeneratorSettings, GeneratorSnapshot } from "@/lib/parlay/generator";
import { buildSnapshot, NOW as SWITCH_NOW, type FixtureGame, type Spec } from "@/lib/parlay/scoring-switch-fixture";
import { CONTRARIAN_CASES, nowOf as contrarianNowOf, snapshotOf as contrarianSnapshotOf, type ContrarianCase } from "@/lib/parlay/contrarian-frozen-cases";

export type NbaCase = { slate: ContrarianCase["slate"] | "NBA"; label: string; settings: GeneratorSettings; slip: string[] };

export const NBA_GAMES: FixtureGame[] = [
  { league: "NBA", home: "Boston Celtics", away: "New York Knicks", nick: "Celtics" },
  { league: "NBA", home: "Los Angeles Lakers", away: "Golden State Warriors", nick: "Lakers" },
];

const p = (s: Omit<Spec, "source" | "hist" | "odds"> & { odds?: number }): Spec => ({ source: "STATED", hist: -110, odds: -110, ...s });
export const NBA_SPECS: Spec[] = [
  // Celtics / Knicks: a side, a game Under, and props.
  p({ id: "c-spread", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Celtics -6", line: -6, lg: [40, 22] }),
  p({ id: "c-under", game: 0, category: "UNDER", betType: "TOTAL", detail: "Under 221.5", line: 221.5, lg: [42, 22] }),
  p({ id: "c-tatum-pts", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 27.5 Points", line: 27.5, lg: [44, 20], propMarket: "POINTS" }),
  p({ id: "c-tatum-pts-285", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 28.5 Points", line: 28.5, lg: [45, 20], propMarket: "POINTS" }),
  p({ id: "c-tatum-pts-under", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Under 29.5 Points", line: 29.5, lg: [38, 22], propMarket: "POINTS" }),
  p({ id: "c-tatum-reb", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 8.5 Rebounds", line: 8.5, lg: [43, 21], propMarket: "REBOUNDS" }),
  p({ id: "c-tatum-pra", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 40.5 PRA", line: 40.5, lg: [41, 21], propMarket: "POINTS_REBOUNDS_ASSISTS" }),
  p({ id: "c-brunson-pts", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jalen Brunson Over 26.5 Points", line: 26.5, lg: [39, 21], propMarket: "POINTS" }),
  p({ id: "c-brown-stl", game: 0, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jaylen Brown Over 1.5 Steals", line: 1.5, lg: [36, 20], propMarket: "STEALS" }),
  // Lakers / Warriors: a moneyline, a game Over, and props.
  p({ id: "l-ml", game: 1, category: "FAV_ML", betType: "MONEYLINE", detail: "Lakers ML", odds: -150, lg: [40, 20] }),
  p({ id: "l-over", game: 1, category: "OVER", betType: "TOTAL", detail: "Over 230.5", line: 230.5, lg: [41, 22] }),
  p({ id: "l-lebron-ast", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "LeBron James Over 7.5 Assists", line: 7.5, lg: [42, 21], propMarket: "ASSISTS" }),
  p({ id: "l-curry-3s", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Stephen Curry Over 4.5 Threes", line: 4.5, lg: [40, 22], propMarket: "THREES_MADE" }),
  p({ id: "l-curry-3s-under", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Stephen Curry Under 4.5 Threes", line: 4.5, lg: [35, 22], propMarket: "THREES_MADE" }),
  p({ id: "l-davis-blk", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Anthony Davis Over 1.5 Blocks", line: 1.5, lg: [37, 21], propMarket: "BLOCKS" }),
  p({ id: "l-davis-reb", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Anthony Davis Under 11.5 Rebounds", line: 11.5, lg: [36, 21], propMarket: "REBOUNDS" }),
];

const base: GeneratorSettings = { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const NBA_CASES: NbaCase[] = [
  { slate: "NBA", label: "NBA · 2 legs, 1 per game", settings: { ...base, legCount: 2 }, slip: [] },
  { slate: "NBA", label: "NBA · 6 legs, 3 per game", settings: { ...base, maxLegsPerGame: 3 }, slip: [] },
  { slate: "NBA", label: "NBA · 10 legs, 6 per game, no gate", settings: { ...base, legCount: 10, maxLegsPerGame: 6, minWinPct: 0 }, slip: [] },
  { slate: "NBA", label: "NBA · Props only, 6 legs, 4 per game", settings: { ...base, include: ["PROPS"], maxLegsPerGame: 4 }, slip: [] },
  { slate: "NBA", label: "NBA · slip: Tatum Over 27.5 and Over 28.5 (one bet, two lines)", settings: { ...base, legCount: 3, maxLegsPerGame: 3 }, slip: ["c-tatum-pts", "c-tatum-pts-285"] },
  { slate: "NBA", label: "NBA · slip: game Under + Tatum Rebounds Over, 4 legs, 3 per game", settings: { ...base, legCount: 4, maxLegsPerGame: 3 }, slip: ["c-under", "c-tatum-reb"] },
  { slate: "NBA", label: "NBA · Your picks: 3 of 6", settings: { ...base, legCount: 3, maxLegsPerGame: 3, fillFrom: "YOUR_PICKS_ONLY" }, slip: ["c-spread", "c-tatum-pts", "c-brunson-pts", "l-ml", "l-curry-3s", "l-davis-blk"] },
];

export const NBA_SAMEGAME_CASES: NbaCase[] = [...CONTRARIAN_CASES, ...NBA_CASES];

export function snapshotOf(c: NbaCase): GeneratorSnapshot {
  if (c.slate === "NBA") return buildSnapshot(NBA_SPECS, c.slip, [], NBA_GAMES);
  return contrarianSnapshotOf(c as ContrarianCase);
}

export function nowOf(c: NbaCase): Date {
  return c.slate === "NBA" ? SWITCH_NOW : contrarianNowOf(c as ContrarianCase);
}
