// contrarian-match.ts: the "other side of the same bet" rule, market by market, with every tolerance boundary
// just inside, exactly at and just past. Pure - no DB.
import { contrarianMatch, propTolerance, sideTolerance, totalTolerance, type ContrarianMatch } from "@/lib/parlay/contrarian-match";
import type { ParlayCandidate } from "@/lib/parlay/relationship-classifier";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const GAMES = {
  NBA: { homeTeam: "Chicago Bulls", awayTeam: "Indiana Pacers" },
  NFL: { homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers" },
  MLB: { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox" },
  NHL: { homeTeam: "Boston Bruins", awayTeam: "Toronto Maple Leafs" },
  EPL: { homeTeam: "Arsenal", awayTeam: "Chelsea" },
  ATP: { homeTeam: "Jannik Sinner", awayTeam: "Carlos Alcaraz" },
} as const;
type League = keyof typeof GAMES;
const at = new Date("2026-11-08T23:00:00.000Z");
const pick = (league: League, betType: string, betDetail: string, line: number | null = null, period = "FULL_GAME", gameId: string | null = "g1"): ParlayCandidate => ({
  pick: { betType, period, betDetail, line },
  game: { ...GAMES[league], gameTime: at, sportName: league, gameId },
});
const match = (a: ParlayCandidate, b: ParlayCandidate): ContrarianMatch => contrarianMatch(a, b);
const short = (m: ContrarianMatch) => (m.match ? `MATCH${m.lineGap === null ? "" : ` ${m.lineGap}`}` : m.why);
const symmetric = (label: string, a: ParlayCandidate, b: ParlayCandidate, expected: string) => {
  check(label, short(match(a, b)), expected);
  check(`${label} (reversed)`, short(match(b, a)), expected);
};

// ---- Moneyline ----------------------------------------------------------------
symmetric("ML: Bulls ML vs Pacers ML (the example)", pick("NBA", "MONEYLINE", "Bulls ML"), pick("NBA", "MONEYLINE", "Pacers ML"), "MATCH");
symmetric("ML: the same team is not the other side", pick("NBA", "MONEYLINE", "Bulls ML"), pick("NBA", "MONEYLINE", "Chicago Bulls ML"), "NOT_OPPOSITE");
symmetric("ML vs spread never matches (same betType only)", pick("NBA", "MONEYLINE", "Bulls ML"), pick("NBA", "SPREAD", "Pacers +4.5", 4.5), "MARKET_MISMATCH");
symmetric("soccer ML is never a Contrarian", pick("EPL", "MONEYLINE", "Arsenal ML"), pick("EPL", "MONEYLINE", "Chelsea ML"), "EXCLUDED_MARKET");
symmetric("ML with no readable team is not guessed", pick("NBA", "MONEYLINE", "Bulls ML"), pick("NBA", "MONEYLINE", "the dog ML"), "UNVERIFIED");

// ---- Spread -------------------------------------------------------------------
check("tolerances: NBA/NFL spreads 1, MLB/NHL exact, other leagues exact", [sideTolerance("NBA"), sideTolerance("NFL"), sideTolerance("NCAAB"), sideTolerance("MLB"), sideTolerance("NHL"), sideTolerance("EPL")], [1, 1, 1, 0, 0, 0]);
symmetric("spread: Bulls -5 vs Pacers +5 (exact)", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers +5", 5), "MATCH 0");
symmetric("spread: Bulls -5 vs Pacers +4.5 (0.5, inside)", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers +4.5", 4.5), "MATCH 0.5");
symmetric("spread: Bulls -5 vs Pacers +6 (1.0, at the tolerance)", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers +6", 6), "MATCH 1");
symmetric("spread: Bulls -5 vs Pacers +6.5 (1.5, past it)", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers +6.5", 6.5), "LINE_TOO_FAR");
symmetric("spread: Bulls -5 vs Pacers +3.5 (1.5 the other way, past it)", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers +3.5", 3.5), "LINE_TOO_FAR");
symmetric("spread: both laying points is not the other side's line", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers -1", -1), "LINE_TOO_FAR");
symmetric("spread: the same team at another line is not the other side", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Bulls -4.5", -4.5), "NOT_OPPOSITE");
symmetric("NFL spread: Chiefs -3 vs Chargers +3.5 (inside)", pick("NFL", "SPREAD", "Chiefs -3", -3), pick("NFL", "SPREAD", "Chargers +3.5", 3.5), "MATCH 0.5");
symmetric("run line: Yankees -1.5 vs Red Sox +1.5 (exact)", pick("MLB", "SPREAD", "Yankees -1.5", -1.5), pick("MLB", "SPREAD", "Red Sox +1.5", 1.5), "MATCH 0");
symmetric("run line: Yankees -1.5 vs Red Sox +2.5 (alt line: exact only)", pick("MLB", "SPREAD", "Yankees -1.5", -1.5), pick("MLB", "SPREAD", "Red Sox +2.5", 2.5), "LINE_TOO_FAR");
symmetric("puck line: Bruins -1.5 vs Leafs +1.5 (exact)", pick("NHL", "SPREAD", "Bruins -1.5", -1.5), pick("NHL", "SPREAD", "Maple Leafs +1.5", 1.5), "MATCH 0");
symmetric("puck line: Bruins -1.5 vs Leafs +2 (exact only)", pick("NHL", "SPREAD", "Bruins -1.5", -1.5), pick("NHL", "SPREAD", "Maple Leafs +2", 2), "LINE_TOO_FAR");
symmetric("spread with no line is not guessed", pick("NBA", "SPREAD", "Bulls -5", -5), pick("NBA", "SPREAD", "Pacers cover", null), "UNVERIFIED");

// ---- Game total ------------------------------------------------------------------
check("tolerances: NBA/NFL totals 1, MLB/NHL/soccer 0.5, other leagues exact", [totalTolerance("NBA"), totalTolerance("NFL"), totalTolerance("MLB"), totalTolerance("NHL"), totalTolerance("EPL"), totalTolerance("ATP")], [1, 1, 0.5, 0.5, 0.5, 0]);
symmetric("total: Over 220.5 vs Under 221 (0.5, inside)", pick("NBA", "TOTAL", "Over 220.5", 220.5), pick("NBA", "TOTAL", "Under 221", 221), "MATCH 0.5");
symmetric("total: Over 220.5 vs Under 221.5 (1.0, at the tolerance)", pick("NBA", "TOTAL", "Over 220.5", 220.5), pick("NBA", "TOTAL", "Under 221.5", 221.5), "MATCH 1");
symmetric("total: Over 220.5 vs Under 222 (1.5, past it)", pick("NBA", "TOTAL", "Over 220.5", 220.5), pick("NBA", "TOTAL", "Under 222", 222), "LINE_TOO_FAR");
symmetric("total: Over vs Over is not the other side", pick("NBA", "TOTAL", "Over 220.5", 220.5), pick("NBA", "TOTAL", "Over 221", 221), "NOT_OPPOSITE");
symmetric("MLB total: Over 8.5 vs Under 9 (0.5, at the tolerance)", pick("MLB", "TOTAL", "Over 8.5", 8.5), pick("MLB", "TOTAL", "Under 9", 9), "MATCH 0.5");
symmetric("MLB total: Over 8.5 vs Under 9.5 (1.0, past it)", pick("MLB", "TOTAL", "Over 8.5", 8.5), pick("MLB", "TOTAL", "Under 9.5", 9.5), "LINE_TOO_FAR");
symmetric("soccer total: Over 2.5 vs Under 2.5", pick("EPL", "TOTAL", "Over 2.5", 2.5), pick("EPL", "TOTAL", "Under 2.5", 2.5), "MATCH 0");
symmetric("soccer total: Over 2.5 vs Under 3 (0.5, at the tolerance)", pick("EPL", "TOTAL", "Over 2.5", 2.5), pick("EPL", "TOTAL", "Under 3", 3), "MATCH 0.5");
symmetric("soccer total: Over 2.5 vs Under 3.5 (past it)", pick("EPL", "TOTAL", "Over 2.5", 2.5), pick("EPL", "TOTAL", "Under 3.5", 3.5), "LINE_TOO_FAR");
symmetric("a total vs a team total never matches", pick("MLB", "TOTAL", "Over 8.5", 8.5), pick("MLB", "TEAM_TOTAL", "Yankees Under 4.5", 4.5), "MARKET_MISMATCH");

// ---- Team total ------------------------------------------------------------------
symmetric("team total: Yankees Over 4.5 vs Yankees Under 4.5", pick("MLB", "TEAM_TOTAL", "Yankees Over 4.5", 4.5), pick("MLB", "TEAM_TOTAL", "Yankees Under 4.5", 4.5), "MATCH 0");
symmetric("team total: Yankees Over 4.5 vs Yankees Under 5 (0.5, at the tolerance)", pick("MLB", "TEAM_TOTAL", "Yankees Over 4.5", 4.5), pick("MLB", "TEAM_TOTAL", "Yankees Under 5", 5), "MATCH 0.5");
symmetric("team total: Yankees Over 4.5 vs Yankees Under 5.5 (past it)", pick("MLB", "TEAM_TOTAL", "Yankees Over 4.5", 4.5), pick("MLB", "TEAM_TOTAL", "Yankees Under 5.5", 5.5), "LINE_TOO_FAR");
symmetric("team total: another team's Under is another bet", pick("MLB", "TEAM_TOTAL", "Yankees Over 4.5", 4.5), pick("MLB", "TEAM_TOTAL", "Red Sox Under 4.5", 4.5), "MARKET_MISMATCH");

// ---- NRFI ------------------------------------------------------------------------
symmetric("NRFI vs YRFI", pick("MLB", "NRFI", "NRFI"), pick("MLB", "NRFI", "YRFI"), "MATCH");
symmetric("NRFI vs NRFI is not the other side", pick("MLB", "NRFI", "NRFI"), pick("MLB", "NRFI", "No Run First Inning"), "NOT_OPPOSITE");

// ---- Props -----------------------------------------------------------------------
check("prop tolerances: yards 2.5, basketball points/combos 1, the rest 0.5", [propTolerance("PASS_YDS", "NFL"), propTolerance("RUSH_REC_YDS", "NFL"), propTolerance("POINTS", "NBA"), propTolerance("POINTS_REBOUNDS_ASSISTS", "NBA"), propTolerance("POINTS", "NHL"), propTolerance("REBOUNDS", "NBA"), propTolerance("STRIKEOUTS", "MLB")], [2.5, 2.5, 1, 1, 0.5, 0.5, 0.5]);
symmetric("prop: Tatum Over 27.5 Points vs Tatum Under 28 Points", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jayson Tatum Under 28 Points"), "MATCH 0.5");
symmetric("prop: points 1.0 apart (at the tolerance)", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jayson Tatum Under 28.5 Points"), "MATCH 1");
symmetric("prop: points 1.5 apart (past it)", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jayson Tatum Under 29 Points"), "LINE_TOO_FAR");
symmetric("prop: rebounds 0.5 apart (at the tolerance)", pick("NBA", "PLAYER_PROP", "Jaylen Brown Over 5.5 Rebounds"), pick("NBA", "PLAYER_PROP", "Jaylen Brown Under 6 Rebounds"), "MATCH 0.5");
symmetric("prop: rebounds 1.0 apart (past it)", pick("NBA", "PLAYER_PROP", "Jaylen Brown Over 5.5 Rebounds"), pick("NBA", "PLAYER_PROP", "Jaylen Brown Under 6.5 Rebounds"), "LINE_TOO_FAR");
symmetric("prop: passing yards 2.5 apart (at the tolerance)", pick("NFL", "PLAYER_PROP", "Patrick Mahomes Over 250.5 Passing Yards"), pick("NFL", "PLAYER_PROP", "Patrick Mahomes Under 253 Passing Yards"), "MATCH 2.5");
symmetric("prop: passing yards 3.0 apart (past it)", pick("NFL", "PLAYER_PROP", "Patrick Mahomes Over 250.5 Passing Yards"), pick("NFL", "PLAYER_PROP", "Patrick Mahomes Under 253.5 Passing Yards"), "LINE_TOO_FAR");
symmetric("prop: another player is another bet", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jaylen Brown Under 27.5 Points"), "MARKET_MISMATCH");
symmetric("prop: another stat is another bet", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jayson Tatum Under 8.5 Rebounds"), "MARKET_MISMATCH");
symmetric("prop: the same direction is not the other side", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 28 Points"), "NOT_OPPOSITE");
symmetric("prop: a last name alone with no team is not guessed as the same player", pick("NBA", "PLAYER_PROP", "Jayson Tatum Over 27.5 Points"), pick("NBA", "PLAYER_PROP", "Tatum Under 28 Points"), "UNVERIFIED");
symmetric("prop: anytime TD (yes/no) is never a Contrarian", pick("NFL", "PLAYER_PROP", "Travis Kelce Anytime TD"), pick("NFL", "PLAYER_PROP", "Travis Kelce Anytime TD"), "EXCLUDED_MARKET");

// ---- Period and game -------------------------------------------------------------
symmetric("1H spread vs full-game spread never matches", pick("NBA", "SPREAD", "Bulls -2.5", -2.5, "FIRST_HALF"), pick("NBA", "SPREAD", "Pacers +2.5", 2.5), "PERIOD_MISMATCH");
symmetric("1H total vs full-game total never matches", pick("NBA", "TOTAL", "1H Over 110.5", 110.5, "FIRST_HALF"), pick("NBA", "TOTAL", "Under 110.5", 110.5), "PERIOD_MISMATCH");
symmetric("F5 ML vs full-game ML never matches", pick("MLB", "MONEYLINE", "Yankees F5 ML", null, "FIRST_HALF"), pick("MLB", "MONEYLINE", "Red Sox ML"), "PERIOD_MISMATCH");
symmetric("1H vs 1H matches", pick("NBA", "SPREAD", "Bulls -2.5", -2.5, "FIRST_HALF"), pick("NBA", "SPREAD", "Pacers +2.5", 2.5, "FIRST_HALF"), "MATCH 0");
symmetric("another game never matches", pick("NBA", "MONEYLINE", "Bulls ML", null, "FULL_GAME", "g1"), pick("NBA", "MONEYLINE", "Pacers ML", null, "FULL_GAME", "g2"), "NOT_SAME_GAME");

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
