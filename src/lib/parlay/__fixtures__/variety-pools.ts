// Fixture pools for the Parlay Generator variety measurements (generator-variety-acceptance-test.ts and
// scripts/variety-harness/measure.ts). Shaped on real prod runs: Max legs per game 1, a pick's combined
// win % following the measured gap-to-top curve (Regenerate traces, 2026-11: rank 2-3 ~3 pts behind the
// top, rank 7-10 ~7, rank 16-20 ~10, rank 21+ ~13). Pure - no DB.
import type { GeneratorSettings, GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

export const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";

type Kind = "HML" | "AML" | "ASP" | "O85" | "U85" | "O95" | "HTT" | "ATT";
const KINDS: Kind[] = ["HML", "AML", "ASP", "O85", "U85", "O95", "HTT", "ATT"];

// mulberry32, local so the fixture never depends on the code under test.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The measured curve: gap to the top pick at rank r (0-based), in points.
export const gapAtRank = (r: number) => 14 * (1 - Math.exp(-r / 12));
const TOP = 70;

// teams: real [home, away, home nickname, away nickname] per game, for a pool whose same-game rules must
// resolve (the Relationship Classifier knows real team names only; the made-up ones read UNVERIFIED, so
// two legs never share a game - fine at Max legs per game 1).
export type PoolSpec = { name: string; games: number; picks: number; legs: number; seed: number; teams?: [string, string, string, string][] };

export const MLB_TEAMS: [string, string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays", "Rays"],
  ["Houston Astros", "Baltimore Orioles", "Astros", "Orioles"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians", "Tigers"],
  ["Seattle Mariners", "Texas Rangers", "Mariners", "Rangers"],
  ["Los Angeles Dodgers", "San Francisco Giants", "Dodgers", "Giants"],
];

// (a) game-bound, (b)-(e) more games than legs. Picks per game ~2.7 unless stated.
export const POOLS: PoolSpec[] = [
  { name: "a 12g/12L (game-bound)", games: 12, picks: 32, legs: 12, seed: 11 },
  { name: "b 17g/14L", games: 17, picks: 46, legs: 14, seed: 12 },
  { name: "c 16g/12L", games: 16, picks: 43, legs: 12, seed: 13 },
  { name: "d 41p/16g/12L", games: 16, picks: 41, legs: 12, seed: 14 },
  { name: "e 16g/8L", games: 16, picks: 43, legs: 8, seed: 15 },
];

export function makePool(spec: PoolSpec): GeneratorSnapshot {
  const r = rng(spec.seed);
  // Picks per game: one each, the rest spread at random (at most 8, one per kind).
  const perGame = Array.from({ length: spec.games }, () => 1);
  for (let left = spec.picks - spec.games; left > 0; ) {
    const g = Math.floor(r() * spec.games);
    if (perGame[g] < KINDS.length) {
      perGame[g]++;
      left--;
    }
  }
  // Scores on the curve, with a little jitter, handed out to the picks in a random order.
  const scores = Array.from({ length: spec.picks }, (_, i) => TOP - gapAtRank(i) - r() * 0.4);
  for (let i = scores.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [scores[i], scores[j]] = [scores[j], scores[i]];
  }
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const games: GeneratorGame[] = [];
  let next = 0;
  for (let g = 0; g < spec.games; g++) {
    const [home, away, homeNick, awayNick] = spec.teams?.[g] ?? [`Home${g} City`, `Away${g} City`, `Home${g}`, `Away${g}`];
    const picks = KINDS.slice(0, perGame[g]).map((k) => {
      const id = `g${g}-${k}`;
      const score = scores[next++];
      const detail = { HML: `${homeNick} ML`, AML: `${awayNick} ML`, ASP: `${awayNick} +1.5`, O85: "Over 8.5", U85: "Under 8.5", O95: "Over 9.5", HTT: `${homeNick} team total over 4.5`, ATT: `${awayNick} team total over 3.5` }[k];
      const betType = k === "HML" || k === "AML" ? "MONEYLINE" : k === "ASP" ? "SPREAD" : k === "HTT" || k === "ATT" ? "TEAM_TOTAL" : "TOTAL";
      const category = (k === "HML" ? "FAV_ML" : k === "AML" ? "DOG_ML" : k === "ASP" ? "SPREAD_PLUS" : k === "U85" ? "UNDER" : k === "HTT" || k === "ATT" ? "TEAM_TOTAL" : "OVER") as PickCategoryKey;
      const line = k === "ASP" ? 1.5 : k === "O95" ? 9.5 : k === "HTT" ? 4.5 : k === "ATT" ? 3.5 : betType === "TOTAL" ? 8.5 : null;
      const capperId = "cap-" + id;
      // 1000 decided picks, so record-score's shrinkage barely moves the combined win %.
      const wins = Math.round(score * 10);
      const rec = { wins, losses: 1000 - wins, pushes: 0, winPct: wins / 10, count: 1000 };
      categoryRecords[capperId + "|" + category] = { key: category, label: category, ...rec };
      leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: rec, league: rec };
      return {
        pickId: id, capperId, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
        gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, oddsSource: "STATED", units: 1, status: "PENDING", betType, period: "FULL_GAME",
        rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime: START,
        teamGroup: k === "AML" || k === "ASP" || k === "ATT" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
      } as GeneratorPick;
    });
    games.push({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks });
  }
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

export const settingsFor = (spec: PoolSpec): GeneratorSettings => ({ legCount: spec.legs, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" });
