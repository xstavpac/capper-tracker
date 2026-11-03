// Contrarian's one question: is pick B the other side of the SAME bet as pick A?
// Pure and client-safe. The Relationship Classifier is left as it is: Hedge and
// the same-game rules read it, and its R2/R3 are wider than this (any side vs any
// side, any total line).
//
// Always: the same game, the same betType and the same period. Then per market:
//   ML          the other team. Soccer ML never: the other team isn't the whole
//               other side (the draw).
//   SPREAD      the other team, |lineA + lineB| <= tolerance (-5 vs +4.5 = 0.5).
//   TOTAL       Over vs Under, |lineA - lineB| <= tolerance (220.5 vs 221 = 0.5).
//   TEAM_TOTAL  the same resolved team, Over vs Under, the TOTAL tolerance.
//   NRFI        NRFI vs YRFI.
//   PROP        the same player and market, Over vs Under, the prop tolerance.
//               A yes/no market (anytime TD / goal, double-double) has no Under:
//               never a Contrarian.
// Tolerances are inclusive and approved 2026-11-03: books and posting times differ
// by a hook or a point, so exact-only would leave Contrarian nearly empty, while
// anything wider is a different bet. A missing or unreadable line, team or player
// is never guessed: no match (UNVERIFIED).
import { describePick, describeProp, sameGame, samePropPlayer, type ParlayCandidate } from "@/lib/parlay/relationship-classifier";
import { propTeam } from "@/lib/parlay/same-game-rules";

export type ContrarianMarket = "ML" | "SPREAD" | "TOTAL" | "TEAM_TOTAL" | "NRFI" | "PROP";
export const CONTRARIAN_MARKETS: readonly ContrarianMarket[] = ["ML", "SPREAD", "TOTAL", "TEAM_TOTAL", "NRFI", "PROP"];

export type ContrarianMiss =
  | "NOT_SAME_GAME"
  | "MARKET_MISMATCH" // another betType, or another player / stat / team-total team
  | "PERIOD_MISMATCH"
  | "NOT_OPPOSITE" // the same side
  | "LINE_TOO_FAR"
  | "EXCLUDED_MARKET" // soccer ML, a yes/no prop
  | "UNVERIFIED";

export type ContrarianMatch =
  | { match: true; market: ContrarianMarket; lineGap: number | null }
  | { match: false; market: ContrarianMarket | null; why: ContrarianMiss };

const MARKET_BY_BET_TYPE: Record<string, ContrarianMarket> = {
  MONEYLINE: "ML",
  SPREAD: "SPREAD",
  TOTAL: "TOTAL",
  TEAM_TOTAL: "TEAM_TOTAL",
  NRFI: "NRFI",
  PLAYER_PROP: "PROP",
};

export function contrarianMarketOf(betType: string): ContrarianMarket | null {
  return MARKET_BY_BET_TYPE[betType] ?? null;
}

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------
// Basketball and football: a point either way on spreads and totals.
const WIDE_LEAGUES: ReadonlySet<string> = new Set(["NBA", "WNBA", "NCAAB", "NFL", "NCAAF"]);
// Low-scoring: half a run / goal on totals. Their spreads (run line, puck line) are exact.
const HALF_TOTAL_LEAGUES: ReadonlySet<string> = new Set(["MLB", "NHL"]);
export const SOCCER_LEAGUES: ReadonlySet<string> = new Set([
  "SOCCER", "MLS", "EPL", "LA LIGA", "SERIE A", "BUNDESLIGA", "LIGUE 1", "UCL", "UEFA", "CHAMPIONS LEAGUE", "EUROPA LEAGUE", "LIGA MX",
]);

const league = (sportName: string) => sportName.trim().toUpperCase();
export const isSoccer = (sportName: string) => SOCCER_LEAGUES.has(league(sportName));

export function sideTolerance(sportName: string): number {
  return WIDE_LEAGUES.has(league(sportName)) ? 1 : 0;
}

export function totalTolerance(sportName: string): number {
  const l = league(sportName);
  if (WIDE_LEAGUES.has(l)) return 1;
  if (HALF_TOTAL_LEAGUES.has(l) || SOCCER_LEAGUES.has(l)) return 0.5;
  return 0;
}

const YARDS_MARKETS: ReadonlySet<string> = new Set(["PASS_YDS", "RUSH_YDS", "REC_YDS", "RUSH_REC_YDS", "PASS_RUSH_YDS"]);
// Basketball's big-number markets. NHL "POINTS" is a 0.5 / 1.5 line: the default.
const BASKETBALL_POINT_MARKETS: ReadonlySet<string> = new Set(["POINTS", "POINTS_REBOUNDS_ASSISTS", "POINTS_REBOUNDS", "POINTS_ASSISTS", "REBOUNDS_ASSISTS"]);
const BASKETBALL: ReadonlySet<string> = new Set(["NBA", "WNBA", "NCAAB"]);
export const YES_NO_PROP_MARKETS: ReadonlySet<string> = new Set(["TD", "ANYTIME_GOAL", "FIRST_GOAL", "DOUBLE_DOUBLE"]);

export function propTolerance(market: string, sportName: string): number {
  if (YARDS_MARKETS.has(market)) return 2.5;
  if (BASKETBALL_POINT_MARKETS.has(market) && BASKETBALL.has(league(sportName))) return 1;
  return 0.5;
}

// Lines are halves and wholes; the epsilon only absorbs float noise.
const within = (gap: number, tolerance: number) => gap <= tolerance + 1e-9;
const round = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------
export function contrarianMatch(a: ParlayCandidate, b: ParlayCandidate): ContrarianMatch {
  const market = contrarianMarketOf(a.pick.betType);
  if (!sameGame(a.game, b.game)) return { match: false, market, why: "NOT_SAME_GAME" };
  if (a.pick.betType !== b.pick.betType || market === null) return { match: false, market, why: "MARKET_MISMATCH" };
  if (a.pick.period !== b.pick.period) return { match: false, market, why: "PERIOD_MISMATCH" };
  const sport = a.game.sportName;
  const miss = (why: ContrarianMiss): ContrarianMatch => ({ match: false, market, why });
  const hit = (lineGap: number | null): ContrarianMatch => ({ match: true, market, lineGap });

  if (market === "PROP") {
    const da = describeProp(a.pick, sport);
    const db = describeProp(b.pick, sport);
    if (da.status !== "OK" || db.status !== "OK") return miss("UNVERIFIED");
    if (da.market !== db.market) return miss("MARKET_MISMATCH");
    if (YES_NO_PROP_MARKETS.has(da.market)) return miss("EXCLUDED_MARKET");
    // The same player: the same name, or one name inside the other with both
    // picks naming the same team. A last name alone with no team is two players
    // as often as one (Jalen / Jaylin Williams): not guessed.
    const teamA = propTeam(a);
    const teamB = propTeam(b);
    if (teamA !== null && teamB !== null && teamA !== teamB) return miss("MARKET_MISMATCH");
    const samePlayer = da.player === db.player || (samePropPlayer(da, db) && teamA !== null && teamA === teamB);
    if (!samePlayer) return samePropPlayer(da, db) ? miss("UNVERIFIED") : miss("MARKET_MISMATCH");
    if (da.direction === db.direction) return miss("NOT_OPPOSITE");
    if (da.line === null || db.line === null) return miss("UNVERIFIED");
    const gap = Math.abs(da.line - db.line);
    return within(gap, propTolerance(da.market, sport)) ? hit(round(gap)) : miss("LINE_TOO_FAR");
  }

  if (market === "ML" && isSoccer(sport)) return miss("EXCLUDED_MARKET");
  const da = describePick(a.pick, a.game);
  const db = describePick(b.pick, b.game);
  if (da.status !== "OK" || db.status !== "OK" || !da.direction || !db.direction) return miss("UNVERIFIED");

  switch (market) {
    case "ML":
      return da.direction === db.direction ? miss("NOT_OPPOSITE") : hit(null);
    case "SPREAD": {
      if (da.direction === db.direction) return miss("NOT_OPPOSITE");
      if (da.line === null || db.line === null) return miss("UNVERIFIED");
      // The other side of Bulls -5 is Pacers +5: the two lines sum to zero.
      const gap = Math.abs(da.line + db.line);
      return within(gap, sideTolerance(sport)) ? hit(round(gap)) : miss("LINE_TOO_FAR");
    }
    case "TEAM_TOTAL":
      if (da.teamTarget === null || db.teamTarget === null) return miss("UNVERIFIED");
      if (da.teamTarget !== db.teamTarget) return miss("MARKET_MISMATCH");
    // falls through: the same team, now a total
    case "TOTAL": {
      if (da.direction === db.direction) return miss("NOT_OPPOSITE");
      if (da.line === null || db.line === null) return miss("UNVERIFIED");
      const gap = Math.abs(da.line - db.line);
      return within(gap, totalTolerance(sport)) ? hit(round(gap)) : miss("LINE_TOO_FAR");
    }
    case "NRFI":
      return da.direction === db.direction ? miss("NOT_OPPOSITE") : hit(null);
  }
}

