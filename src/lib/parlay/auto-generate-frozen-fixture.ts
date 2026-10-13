// A fixed slate for auto-generate's regression test
// (same-game-fill-acceptance-test.ts). auto-generate-frozen-parlay-a.json is
// what buildAutoParlay returned for this slate on main at 323d216, before "max
// legs per game" existed; the test holds today's output to it byte for byte.
//
// No runtime imports on purpose: the same file was run against that older
// checkout to produce the JSON. Changing anything here means regenerating it.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";

type Teams = { gameId: string; homeTeam: string; awayTeam: string; gameTime: string; doubleheader?: boolean };

const G1: Teams = { gameId: "g1", homeTeam: "Chicago Cubs", awayTeam: "Tampa Bay Rays", gameTime: "2026-09-23T23:05:00.000Z" };
const G2: Teams = { gameId: "g2", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: "2026-09-23T23:05:00.000Z" };
const G3: Teams = { gameId: "g3", homeTeam: "Los Angeles Dodgers", awayTeam: "San Francisco Giants", gameTime: "2026-09-24T02:10:00.000Z" };
// A doubleheader: the same two teams, twice on one day, two board games.
const G4: Teams = { gameId: "g4", homeTeam: "New York Mets", awayTeam: "Atlanta Braves", gameTime: "2026-09-23T17:10:00.000Z", doubleheader: true };
const G5: Teams = { gameId: "g5", homeTeam: "New York Mets", awayTeam: "Atlanta Braves", gameTime: "2026-09-23T23:10:00.000Z", doubleheader: true };

type Row = {
  game: Teams;
  pickId: string;
  capperId: string;
  betType: string;
  betDetail: string;
  odds: number;
  line: number | null;
  category: PickCategoryKey;
  // [wins, losses]: `league` is what Parlay A ranks by, `market` (all leagues,
  // this category) is what the same-game fill gates on. null = no record.
  league: [number, number] | null;
  market: [number, number] | null;
  gameNumber?: number | null;
};

const ROWS: Row[] = [
  { game: G1, pickId: "g1-a", capperId: "capA", betType: "MONEYLINE", betDetail: "Cubs ML", odds: -150, line: null, category: "FAV_ML", league: [21, 9], market: [21, 9] },
  { game: G1, pickId: "g1-b", capperId: "capB", betType: "TOTAL", betDetail: "Over 8.5", odds: -110, line: 8.5, category: "OVER", league: [12, 8], market: [16, 9] },
  // The strongest candidate on the slate, and a second side on G1.
  { game: G1, pickId: "g1-c", capperId: "capC", betType: "MONEYLINE", betDetail: "Rays ML", odds: 130, line: null, category: "DOG_ML", league: [7, 5], market: [40, 10] },
  { game: G1, pickId: "g1-d", capperId: "capD", betType: "PLAYER_PROP", betDetail: "Seiya Suzuki over 1.5 total bases", odds: -115, line: null, category: "TD_PROP", league: [9, 6], market: [30, 20] },
  // Exactly 55.0%.
  { game: G1, pickId: "g1-e", capperId: "capE", betType: "PLAYER_PROP", betDetail: "Yandy Diaz over 0.5 hits", odds: -200, line: null, category: "TD_PROP", league: [5, 5], market: [11, 9] },
  // 54.5%: under the gate.
  { game: G1, pickId: "g1-f", capperId: "capF", betType: "TEAM_TOTAL", betDetail: "Rays team total over 3.5", odds: -105, line: 3.5, category: "TEAM_TOTAL", league: [4, 6], market: [6, 5] },

  { game: G2, pickId: "g2-a", capperId: "capG", betType: "MONEYLINE", betDetail: "Yankees ML", odds: -130, line: null, category: "FAV_ML", league: [26, 14], market: [26, 14] },
  { game: G2, pickId: "g2-b", capperId: "capH", betType: "TOTAL", betDetail: "Under 7.5", odds: -110, line: 7.5, category: "UNDER", league: [6, 4], market: [33, 17] },
  { game: G2, pickId: "g2-c", capperId: "capI", betType: "PLAYER_PROP", betDetail: "Aaron Judge over 1.5 total bases", odds: 105, line: null, category: "TD_PROP", league: [5, 4], market: [28, 12] },
  { game: G2, pickId: "g2-d", capperId: "capJ", betType: "PLAYER_PROP", betDetail: "Aaron Judge under 0.5 home runs", odds: -260, line: null, category: "TD_PROP", league: [4, 4], market: [12, 8] },

  { game: G3, pickId: "g3-a", capperId: "capK", betType: "MONEYLINE", betDetail: "Dodgers ML", odds: -140, line: null, category: "FAV_ML", league: [31, 19], market: [31, 19] },

  { game: G4, pickId: "g4-a", capperId: "capL", betType: "MONEYLINE", betDetail: "Mets ML", odds: -120, line: null, category: "FAV_ML", league: [18, 12], market: [18, 12], gameNumber: 1 },
  { game: G4, pickId: "g4-b", capperId: "capM", betType: "TOTAL", betDetail: "Over 8", odds: -110, line: 8, category: "OVER", league: [5, 5], market: [20, 10], gameNumber: 1 },
  { game: G5, pickId: "g5-a", capperId: "capN", betType: "MONEYLINE", betDetail: "Braves ML", odds: 110, line: null, category: "DOG_ML", league: [14, 11], market: [14, 11], gameNumber: 2 },
  // Qualifies, but never said which game of the doubleheader it is on.
  { game: G5, pickId: "g5-b", capperId: "capO", betType: "TOTAL", betDetail: "Under 9", odds: -110, line: 9, category: "UNDER", league: [5, 6], market: [18, 12], gameNumber: null },
];

function toPick(r: Row): GeneratorPick {
  return {
    pickId: r.pickId,
    capperId: r.capperId,
    capperName: r.capperId,
    capperColorTag: null,
    capperIsFavorite: false,
    category: r.category,
    leagueName: "MLB",
    gameId: r.game.gameId,
    gameLabel: r.game.awayTeam + " @ " + r.game.homeTeam,
    betDetail: r.betDetail,
    odds: r.odds,
    units: 1,
    status: "PENDING",
    betType: r.betType,
    period: "FULL_GAME",
    rawBetDetail: r.betDetail,
    line: r.line,
    homeTeam: r.game.homeTeam,
    awayTeam: r.game.awayTeam,
    gameTime: r.game.gameTime,
    teamGroup: "OTHER",
    teamLabel: "",
    teamColor: null,
    datePosted: "2026-09-23T15:00:00.000Z",
    ...(r.gameNumber === undefined ? {} : { gameNumber: r.gameNumber }),
  };
}

export const FROZEN_GAMES: GeneratorGame[] = [G1, G2, G3, G4, G5].map((g) => ({
  gameId: g.gameId,
  gameLabel: g.awayTeam + " @ " + g.homeTeam,
  gameTime: g.gameTime,
  leagueName: "MLB",
  picks: ROWS.filter((r) => r.game === g).map(toPick),
  ...(g.doubleheader ? { doubleheader: true } : {}),
}));

const column = ([wins, losses]: [number, number]) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });

export const FROZEN_LEAGUE_RECORDS: CapperLeagueRecords = {
  records: Object.fromEntries(
    ROWS.filter((r) => r.league).map((r) => [
      r.capperId + "|MLB|" + r.category,
      { category: r.category, label: "", overall: column(r.league!), league: column(r.league!) },
    ])
  ),
  streaks: {},
  last20: {},
};

export const FROZEN_CATEGORY_RECORDS: Record<string, CategoryBreakdownItem | null> = Object.fromEntries(
  ROWS.filter((r) => r.market).map((r) => [r.capperId + "|" + r.category, { key: r.category, label: "", ...column(r.market!) }])
);

export const FROZEN_LEG_COUNTS = [3, 5, 20];
