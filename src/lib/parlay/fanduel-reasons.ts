// The sentences Send to FanDuel gives for a leg it didn't send. Each opens with
// the kind of problem, then the detail that makes it fixable - the two times,
// the player's name, the stat. Pure.
//
//   Game not on FanDuel         no event for these two teams
//   Game time mismatch          the same teams, but not at that time
//   Two games found             a doubleheader: which one is the pick's?
//   Market not offered          FanDuel has the game, not this bet on it
//   Player not matched          no one, or more than one, on FanDuel is that player
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
export const marketNotOffered = (what: string) => "Market not offered by FanDuel — " + what + ".";

export const playerNotMatched = (typed: string, market: string) => "Player not matched — no \"" + typed + "\" with " + market + " on FanDuel for this game.";

export const playersAmbiguous = (typed: string, names: string[]) =>
  "Player not matched — more than one player on FanDuel fits \"" + typed + "\": " + names.slice(0, 3).join(", ") + ".";

export const marketNotSupported = (league: string, what: string) => "Market not supported for " + league + " yet — " + what + ".";
