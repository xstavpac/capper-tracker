// A small MLB slate for the slip-build tests (slip-build-acceptance-test.ts):
// four games, each pick by its own capper so each pick's record - and so its
// rank - is set per pick through that capper's last-20 record (the fallback
// bestAvailableRecord reaches when a pick has no category).
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";

const GAME_TIME = "2099-06-01T23:00:00.000Z";

export const GAMES = {
  G1: { home: "New York Yankees", away: "Boston Red Sox", homeNick: "Yankees", awayNick: "Red Sox" },
  G2: { home: "Toronto Blue Jays", away: "Tampa Bay Rays", homeNick: "Blue Jays", awayNick: "Rays" },
  G3: { home: "Houston Astros", away: "Baltimore Orioles", homeNick: "Astros", awayNick: "Orioles" },
  G4: { home: "Cleveland Guardians", away: "Detroit Tigers", homeNick: "Guardians", awayNick: "Tigers" },
  G5: { home: "Seattle Mariners", away: "Texas Rangers", homeNick: "Mariners", awayNick: "Rangers" },
} as const;
export type GameKey = keyof typeof GAMES;

// HOME / AWAY: that team's moneyline. OVER / UNDER: the full-game total 8.5.
export type Bet = "HOME" | "AWAY" | "OVER" | "UNDER";

export function slatePick(id: string, game: GameKey, bet: Bet): GeneratorPick {
  const g = GAMES[game];
  const isTotal = bet === "OVER" || bet === "UNDER";
  const detail = bet === "HOME" ? g.homeNick + " ML" : bet === "AWAY" ? g.awayNick + " ML" : (bet === "OVER" ? "Over" : "Under") + " 8.5";
  return {
    pickId: id,
    capperId: "capper-" + id,
    capperName: "Capper " + id,
    capperColorTag: null,
    capperIsFavorite: false,
    category: null,
    leagueName: "MLB",
    gameId: game,
    gameLabel: g.away + " @ " + g.home,
    betDetail: detail,
    odds: -110,
    units: 1,
    status: "PENDING",
    betType: isTotal ? "TOTAL" : "MONEYLINE",
    period: "FULL_GAME",
    rawBetDetail: detail,
    line: isTotal ? 8.5 : null,
    homeTeam: g.home,
    awayTeam: g.away,
    gameTime: GAME_TIME,
    teamGroup: bet === "AWAY" ? "AWAY" : "HOME",
    teamLabel: isTotal ? null : bet === "HOME" ? g.homeNick : g.awayNick,
    teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}

export function slateGame(game: GameKey, picks: GeneratorPick[]): GeneratorGame {
  const g = GAMES[game];
  return { gameId: game, gameLabel: g.away + " @ " + g.home, gameTime: GAME_TIME, leagueName: "MLB", picks };
}

// Win % per pick id, on a 20-pick sample - higher win % ranks first.
export function slateRecords(winPctById: Record<string, number>): CapperLeagueRecords {
  const last20: CapperLeagueRecords["last20"] = {};
  for (const [id, pct] of Object.entries(winPctById)) {
    const wins = Math.round((pct / 100) * 20);
    last20["capper-" + id] = { wins, losses: 20 - wins, pushes: 0, winPct: (wins / 20) * 100, count: 20 };
  }
  return { records: {}, streaks: {}, last20 };
}
