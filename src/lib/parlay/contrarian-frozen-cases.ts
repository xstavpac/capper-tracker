// The slates and settings the Contrarian frozen diff (contrarian-frozen-diff-acceptance-test.ts) runs: the
// scoring switch's slate on SELECTION_CASES, the Standard frozen slate (the former standard-generator-frozen-acceptance-
// test.ts's NFL snapshot, copied here as it was), and a mixed-markets slate with every market Contrarian
// matches on (NRFI, team totals, props, a soccer game, 1H lines). contrarian-before-frozen.json is the engine
// at de0719e (before PR 7) on exactly these cases. Pure - no DB.
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSettings, GeneratorSnapshot } from "@/lib/parlay/generator";
import { SELECTION_CASES } from "@/lib/parlay/selection-frozen-cases";
import { buildSnapshot, NOW as SWITCH_NOW, type FixtureGame, type Spec } from "@/lib/parlay/scoring-switch-fixture";

export type ContrarianCase = { slate: "SWITCH" | "NFL" | "MIXED"; label: string; settings: GeneratorSettings; slip: string[] };

// ---------------------------------------------------------------------------
// The Standard frozen slate (NFL, 6 games: fav ML, Over, dog ML, spread on each)
// ---------------------------------------------------------------------------
export const NFL_NOW = new Date("2026-10-15T14:00:00.000Z");
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
const TEAMS: [string, string, string][] = [
  ["Kansas City Chiefs", "Los Angeles Chargers", "Chiefs"],
  ["Buffalo Bills", "Miami Dolphins", "Bills"],
  ["Philadelphia Eagles", "Dallas Cowboys", "Eagles"],
  ["Detroit Lions", "Chicago Bears", "Lions"],
  ["Baltimore Ravens", "Cincinnati Bengals", "Ravens"],
  ["San Francisco 49ers", "Seattle Seahawks", "49ers"],
];

export function nflSnapshot(slipIds: string[] = []): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const cappers: [string, [number, number]][] = [["fav", [14, 6]], ["over", [13, 7]], ["dog", [6, 14]], ["spread", [11, 4]]];
  const games: GeneratorGame[] = TEAMS.map(([home, away, nick], i) => {
    const gameTime = new Date(NFL_NOW.getTime() + (3 + i) * 3600_000).toISOString();
    const picks: GeneratorPick[] = [];
    const add = (capper: string, rec: [number, number], category: PickCategoryKey, betType: string, detail: string, line: number | null, odds: number) => {
      const r = col(...rec);
      categoryRecords[capper + "|" + category] = { key: category, label: category, ...r };
      leagueRecords.records[capper + "|NFL|" + category] = { category, label: category, overall: r, league: r };
      picks.push({
        pickId: `p-${i}-${capper}`, capperId: capper, capperName: "Capper " + capper, capperColorTag: null, capperIsFavorite: false, category,
        leagueName: "NFL", gameId: "g" + i, gameLabel: away + " @ " + home, betDetail: detail, odds, units: 1, status: "PENDING", betType, period: "FULL_GAME",
        rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime, teamGroup: "HOME", teamLabel: "", teamColor: null,
        datePosted: new Date(NFL_NOW.getTime() - 2 * 3600_000).toISOString(), gameNumber: null,
      } as unknown as GeneratorPick);
    };
    add("fav", cappers[0][1], "FAV_ML", "MONEYLINE", nick + " ML", null, -150);
    add("over", cappers[1][1], "OVER", "TOTAL", "Over 44.5", 44.5, -110);
    add("dog", cappers[2][1], "DOG_ML", "MONEYLINE", away.split(" ").pop() + " ML", null, 130);
    add("spread", cappers[3][1], "SPREAD_MINUS", "SPREAD", nick + " -3", -3, -110);
    return { gameId: "g" + i, gameLabel: away + " @ " + home, gameTime, leagueName: "NFL", picks };
  });
  const all = games.flatMap((g) => g.picks);
  return { builtAt: NFL_NOW.toISOString(), games, slipPicks: all.filter((p) => slipIds.includes(p.pickId)), targets: [], leagueRecords, categoryRecords };
}

const nflBase: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const NFL_CASES: ContrarianCase[] = [
  { slate: "NFL", label: "NFL · 3 legs, best available", settings: nflBase, slip: [] },
  { slate: "NFL", label: "NFL · 4 legs, 2 per game, game lines", settings: { ...nflBase, legCount: 4, maxLegsPerGame: 2, include: ["MONEYLINE", "SPREAD", "TOTALS"] }, slip: [] },
  { slate: "NFL", label: "NFL · 2 legs, totals only, 60% gate", settings: { ...nflBase, legCount: 2, include: ["TOTALS"], minWinPct: 60 }, slip: [] },
  { slate: "NFL", label: "NFL · 6 legs, no gate", settings: { ...nflBase, legCount: 6, minWinPct: 0 }, slip: [] },
  { slate: "NFL", label: "NFL · Your picks: every favorite ML", settings: { ...nflBase, legCount: 6, fillFrom: "YOUR_PICKS_ONLY" }, slip: TEAMS.map((_, i) => `p-${i}-fav`) },
];

// ---------------------------------------------------------------------------
// Mixed markets: one leg per case (a one-pick slip), so each market's
// availability is read on its own.
// ---------------------------------------------------------------------------
export const MIXED_GAMES: FixtureGame[] = [
  { league: "MLB", home: "New York Yankees", away: "Boston Red Sox", nick: "Yankees" },
  { league: "NBA", home: "Boston Celtics", away: "New York Knicks", nick: "Celtics" },
  { league: "EPL", home: "Arsenal", away: "Chelsea", nick: "Arsenal" },
  { league: "NFL", home: "Kansas City Chiefs", away: "Los Angeles Chargers", nick: "Chiefs" },
];

type Mix = Omit<Spec, "source" | "hist"> & { hist?: number | null };
const m = (s: Mix): Spec => ({ source: "STATED", hist: -110, ...s });
export const MIXED_SPECS: Spec[] = [
  // MLB: NRFI/YRFI, a team total at one line and past the half-run tolerance, a total and its Under half a
  // run away, an F5 Under (another period), the run line and an alt run line (exact only), both MLs.
  m({ id: "m0-yrfi", game: 0, category: "YRFI", betType: "NRFI", detail: "YRFI", odds: -110, lg: [30, 15] }),
  m({ id: "m0-nrfi", game: 0, category: "NRFI", betType: "NRFI", detail: "NRFI", odds: -110, lg: [28, 16] }),
  m({ id: "m0-tt-over", game: 0, category: "TEAM_TOTAL", betType: "TEAM_TOTAL", detail: "Yankees Over 4.5", line: 4.5, odds: -110, lg: [25, 12] }),
  m({ id: "m0-tt-under", game: 0, category: "TEAM_TOTAL", betType: "TEAM_TOTAL", detail: "Yankees Under 4.5", line: 4.5, odds: -110, lg: [24, 14] }),
  m({ id: "m0-tt-under-far", game: 0, category: "TEAM_TOTAL", betType: "TEAM_TOTAL", detail: "Yankees Under 5.5", line: 5.5, odds: -110, lg: [40, 10] }),
  m({ id: "m0-over", game: 0, category: "OVER", betType: "TOTAL", detail: "Over 8.5", line: 8.5, odds: -110, lg: [30, 14] }),
  m({ id: "m0-under", game: 0, category: "UNDER", betType: "TOTAL", detail: "Under 9", line: 9, odds: -110, lg: [22, 14] }),
  m({ id: "m0-f5-under", game: 0, category: "F5_UNDER", betType: "TOTAL", detail: "First 5 Under 4.5", line: 4.5, odds: -110, lg: [26, 12], period: "FIRST_HALF" }),
  m({ id: "m0-rl-home", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Yankees -1.5", line: -1.5, odds: 130, lg: [20, 10], hist: 130 }),
  m({ id: "m0-rl-away-alt", game: 0, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Red Sox +2.5", line: 2.5, odds: -250, lg: [30, 10], hist: -250 }),
  m({ id: "m0-ml-home", game: 0, category: "FAV_ML", betType: "MONEYLINE", detail: "Yankees ML", odds: -140, lg: [30, 15], hist: -140 }),
  m({ id: "m0-ml-away", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Red Sox ML", odds: 120, lg: [14, 16], hist: 120 }),
  // NBA: a points prop and its Under half a point away, a rebounds prop whose Under is a point away (past 0.5),
  // a spread whose other side is 1.5 away (past 1), and a 1H spread (another period).
  m({ id: "n1-tatum-over", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 27.5 Points", line: 27.5, odds: -115, lg: [20, 10], hist: -115, propMarket: "POINTS" }),
  m({ id: "n1-tatum-under", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Under 28 Points", line: 28, odds: -110, lg: [18, 10], propMarket: "POINTS" }),
  m({ id: "n1-brown-reb-over", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jaylen Brown Over 5.5 Rebounds", line: 5.5, odds: -110, lg: [20, 8], propMarket: "REBOUNDS" }),
  m({ id: "n1-brown-reb-under", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jaylen Brown Under 6.5 Rebounds", line: 6.5, odds: -110, lg: [22, 8], propMarket: "REBOUNDS" }),
  m({ id: "n1-spread-home", game: 1, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Celtics -6", line: -6, odds: -110, lg: [24, 12] }),
  m({ id: "n1-spread-away-far", game: 1, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Knicks +7.5", line: 7.5, odds: -110, lg: [24, 10] }),
  m({ id: "n1-1h-spread-away", game: 1, category: "FIRST_HALF_SPREAD", betType: "SPREAD", detail: "Knicks +3.5", line: 3.5, odds: -110, lg: [25, 10], period: "FIRST_HALF" }),
  // EPL: both MLs (soccer ML is never a Contrarian), and a total with its Under.
  m({ id: "e2-ml-home", game: 2, category: "FAV_ML", betType: "MONEYLINE", detail: "Arsenal ML", odds: -120, lg: [20, 10], hist: -120 }),
  m({ id: "e2-ml-away", game: 2, category: "DOG_ML", betType: "MONEYLINE", detail: "Chelsea ML", odds: 250, lg: [15, 10], hist: 250 }),
  m({ id: "e2-over", game: 2, category: "OVER", betType: "TOTAL", detail: "Over 2.5", line: 2.5, odds: -110, lg: [20, 12] }),
  m({ id: "e2-under", game: 2, category: "UNDER", betType: "TOTAL", detail: "Under 2.5", line: 2.5, odds: -110, lg: [22, 12] }),
  // NFL: an anytime TD (yes/no: never a Contrarian), both MLs, and the spread half a point apart.
  m({ id: "f3-td", game: 3, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Travis Kelce Anytime TD", odds: 120, lg: [20, 10], hist: 120, propMarket: "TD" }),
  m({ id: "f3-ml-home", game: 3, category: "FAV_ML", betType: "MONEYLINE", detail: "Chiefs ML", odds: -160, lg: [25, 10], hist: -160 }),
  m({ id: "f3-ml-away", game: 3, category: "DOG_ML", betType: "MONEYLINE", detail: "Chargers ML", odds: 140, lg: [20, 12], hist: 140 }),
  m({ id: "f3-spread-home", game: 3, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Chiefs -3", line: -3, odds: -110, lg: [25, 12] }),
  m({ id: "f3-spread-away", game: 3, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Chargers +3.5", line: 3.5, odds: -110, lg: [22, 10] }),
];

export function mixedSnapshot(slipIds: string[] = []): GeneratorSnapshot {
  return buildSnapshot(MIXED_SPECS, slipIds, [], MIXED_GAMES);
}

const MIXED_CASES: ContrarianCase[] = MIXED_SPECS.map((s) => ({
  slate: "MIXED" as const,
  label: `MIXED · ${s.id} alone`,
  settings: { legCount: 1, maxLegsPerGame: 1, include: "ALL" as const, mix: null, fillFrom: "YOUR_PICKS_ONLY" as const },
  slip: [s.id],
}));

// ---------------------------------------------------------------------------
export const CONTRARIAN_CASES: ContrarianCase[] = [
  ...SELECTION_CASES.map((c) => ({ slate: "SWITCH" as const, label: `SWITCH · ${c.label}`, settings: c.settings, slip: c.slip })),
  ...NFL_CASES,
  ...MIXED_CASES,
];

export function snapshotOf(c: ContrarianCase): GeneratorSnapshot {
  if (c.slate === "NFL") return nflSnapshot(c.slip);
  if (c.slate === "MIXED") return mixedSnapshot(c.slip);
  return buildSnapshot(undefined, c.slip);
}

export function nowOf(c: ContrarianCase): Date {
  return c.slate === "NFL" ? NFL_NOW : SWITCH_NOW;
}
