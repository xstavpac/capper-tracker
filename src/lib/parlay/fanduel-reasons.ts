// The sentences Send to FanDuel gives for a leg it didn't send. Each opens with
// the kind of problem, then the detail that makes it fixable - the two times,
// the player's name, the stat. Pure.
//
//   Game not on FanDuel         no event for these two teams
//   Game time mismatch          the same teams, but not at that time
//   Two games found             a doubleheader: which one is the pick's?
//   Market unavailable          FanDuel has the game, not this bet on it (or not this period)
//   Line unavailable            FanDuel has the market, not this line (or only one past the allowed move)
//   Potentially incorrect market match   FanDuel's price is far from the pick's: not sent
//   Player not matched          no one, or more than one, on FanDuel is that player
//   Needs clarification         a supported bet, but which team it is on isn't settled - or the stored
//                               game looks wrong (league out of season, a line that league never posts,
//                               or the same school playing another sport today)
//   Market not supported        this app doesn't send that bet for the league yet
// A leg's line (closest line is X, more than N away) and a selection with no
// betslip link keep their own sentences; they are already specific.

const BASE_MARKETS: Record<string, string> = {
  h2h_3_way: "3-way moneyline",
  h2h: "moneyline",
  spreads: "spread",
  totals: "total",
  team_totals: "team total",
};
const PERIODS: Record<string, string> = {
  h1: "1st half",
  h2: "2nd half",
  q1: "1st quarter",
  q2: "2nd quarter",
  q3: "3rd quarter",
  q4: "4th quarter",
  p1: "1st period",
  p2: "2nd period",
  p3: "3rd period",
  "1st_5_innings": "first 5 innings",
};
const PLAYER_MARKETS: Record<string, string> = {
  player_points: "points",
  player_rebounds: "rebounds",
  player_assists: "assists",
  player_threes: "threes",
  player_steals: "steals",
  player_blocks: "blocks",
  player_points_rebounds_assists: "points + rebounds + assists",
  player_points_rebounds: "points + rebounds",
  player_points_assists: "points + assists",
  player_rebounds_assists: "rebounds + assists",
  player_pass_tds: "passing touchdowns",
  player_pass_yds: "passing yards",
  player_rush_yds: "rushing yards",
  player_reception_yds: "receiving yards",
  player_receptions: "receptions",
  player_rush_reception_yds: "rushing + receiving yards",
  player_pass_rush_yds: "passing + rushing yards",
  player_anytime_td: "anytime touchdown",
  player_goal_scorer_anytime: "anytime goal",
  player_shots_on_goal: "shots on goal",
  player_total_saves: "saves",
};

// An Odds API market key in words: "totals_p1" -> "total (1st period)".
export function marketLabel(key: string): string {
  const k = key.replace(/^alternate_/, "");
  if (PLAYER_MARKETS[k]) return PLAYER_MARKETS[k];
  const m = k.match(/^(h2h_3_way|h2h|spreads|totals|team_totals)(?:_(.+))?$/);
  if (m) return BASE_MARKETS[m[1]] + (m[2] && PERIODS[m[2]] ? " (" + PERIODS[m[2]] + ")" : "");
  return k.replace(/^player_/, "").replace(/_/g, " ");
}

// A stored player-prop market in words: "PASS_ATTEMPTS" -> "pass attempts".
export function propMarketLabel(propMarket: string): string {
  return propMarket
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\byds\b/, "yards")
    .replace(/\btds\b/, "touchdowns")
    .replace(/\brbis\b/, "RBIs");
}

export const gameNotOnFanDuel = (awayTeam: string, homeTeam: string) => "Game not on FanDuel — couldn't find " + awayTeam + " @ " + homeTeam + ".";

export const gameTimeMismatch = (fanDuelTime: string, pickTime: string) =>
  "Game time mismatch — FanDuel has this game at " + fanDuelTime + "; your pick is at " + pickTime + ".";

export const twoGamesFound = (times: string[]) => "Two games found — couldn't tell which" + (times.length > 0 ? " (" + times.join(" and ") + ")" : "") + ".";

// `what`: the market in words, with the player when it is a prop's.
export const marketNotOffered = (what: string) => "Market unavailable — " + what + ".";

// The line is the bet's identity, so a move past the cap is not a smaller version of the same bet.
export const lineUnavailable = (detail: string) => "Line unavailable — " + detail + ".";

const fmt = (o: number) => (o > 0 ? "+" : "") + o;

// FanDuel's price for the selection is nowhere near the pick's: most likely not the same bet. pickOdds null = the
// pick had no real price of its own.
export const priceMismatch = (what: string, pickOdds: number | null, fanDuelOdds: number) =>
  "Potentially incorrect market match — FanDuel's " +
  what +
  " is " +
  fmt(fanDuelOdds) +
  (pickOdds === null ? ", a price no ordinary line carries." : " but your pick is " + fmt(pickOdds) + ".") +
  " Not sent: check the bet on FanDuel.";

export const priceMovedWarning = (pickOdds: number | null, fanDuelOdds: number) =>
  "Price moved a lot — " + (pickOdds === null ? "your pick has no stated price" : "your pick was " + fmt(pickOdds)) + ", FanDuel has " + fmt(fanDuelOdds) + ".";

export const playerNotMatched = (typed: string, market: string) => "Player not matched — no \"" + typed + "\" with " + market + " on FanDuel for this game.";

export const playersAmbiguous = (typed: string, names: string[]) =>
  "Player not matched — more than one player on FanDuel fits \"" + typed + "\": " + names.slice(0, 3).join(", ") + ".";

// The pick is a supported bet, but nothing settles which of the two teams it is on.
export const sideNeedsClarification = (awayTeam: string, homeTeam: string) =>
  "Needs clarification — which team is this pick on, " + awayTeam + " or " + homeTeam + "? Fix the pick's team and send again.";

// The final check before sending (fanduel-link.ts storedGameProblem / slate check): the stored game itself looks wrong.
export const storedLeagueOutOfSeason = (league: string) =>
  "Needs clarification — this pick is stored as a " + league + " game, and " + league + " isn't in season. Fix the pick's game and send again.";

export const storedLineImplausible = (league: string, what: string, line: number) =>
  "Needs clarification — " + what + " of " + line + " isn't a real " + league + " line, so this pick may be stored on the wrong game. Fix the pick and send again.";

// `stored` / `others`: "NCAAF: Clemson Tigers @ South Carolina Gamecocks, Sat, Nov 14".
export const sameNameOtherSport = (stored: string, others: string[]) =>
  "Needs clarification — this pick is stored on " + stored + ", but the same team also plays today: " + others.join("; ") + ". Which game is it? Fix the pick's game and send again.";

export const marketNotSupported =(league: string, what: string) => "Market not supported for " + league + " yet — " + what + ".";
