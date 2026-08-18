// Pure data transform, no fetch/DB - safe to call from both the server
// (initial render) and the client (recomputing on each live-score poll tick,
// using the same static odds/favorite/total data plus whatever scores just
// came back).

// Cited historical MLB moneyline underdog win rate (~42.7% since 2021,
// ~44% over the longer run) - see
// https://www.boydsbets.com/betting-underdogs-in-baseball/ and
// https://www.sportsbettingexperts.com/baseball-betting/the-math-behind-moneyline-underdogs/.
// Used as the multiplier for "expected upsets today" - re-derive from a real
// source if this ever needs updating, not a guessed round number.
export const MLB_UNDERDOG_WIN_RATE = 0.427;

// A total line rarely covers extra innings the way the pregame number was
// set for 9 - pace projection past inning 9 gets unreliable fast, so this is
// a soft ceiling on how far the "completed innings" denominator counts, not
// a hard cutoff on which games are included.
const REGULATION_INNINGS = 9;

// Below this many completed innings, a pace projection is dominated by noise
// (a single 1st-inning run projects to an absurd full-game pace) - games
// this early are excluded from over/under trending entirely, same as
// not-yet-started games.
const MIN_INNINGS_FOR_TREND = 2;

// Below this many completed-or-in-progress games, an upset RATE is too noisy
// to call "running hot" or "running cold" off of - a single early upset
// swings a 1- or 2-game sample from 0% to 50%/100%, nowhere near a real
// signal against the ~43% baseline. Below this, the panel shows a neutral
// "not enough games yet" state instead of a verdict.
export const MIN_GAMES_FOR_VERDICT = 3;

export type BoardPulseVerdict = "hot" | "cold" | "insufficient";

export type BoardPulseGame = {
  id: string;
  status: "preview" | "live" | "final";
  homeScore: number | null;
  awayScore: number | null;
  inningHalf: string | null;
  inningOrdinal: string | null;
  favorite: "home" | "away" | null;
  totalLine: number | null;
};

export type BoardPulseStats = {
  gameCount: number;
  upsetsSoFar: number;
  expectedUpsets: number;
  // Games with a decided leader right now (favsLeading + dogsLeading, ties
  // and not-yet-started games excluded) - the denominator for upsetRate
  // below, and the population "running hot/cold" is actually judged against.
  gamesSoFar: number;
  // upsetsSoFar / gamesSoFar - null when gamesSoFar is 0 (nothing to divide).
  // This, not upsetsSoFar vs expectedUpsets, is what the panel should compare
  // against MLB_UNDERDOG_WIN_RATE: a raw running count is almost always well
  // under a full-day total early on regardless of true pace (most games
  // simply haven't happened yet), which made the old comparison look
  // "below average" by default for most of the day no matter how the
  // completed games actually went. A rate stays meaningful at any point in
  // the day, including game 1.
  upsetRate: number | null;
  // "insufficient" below MIN_GAMES_FOR_VERDICT, regardless of what the raw
  // rate happens to say - see that constant's comment.
  verdict: BoardPulseVerdict;
  favsLeading: number;
  dogsLeading: number;
  trendingOver: number;
  trendingUnder: number;
};

// How many innings are "in the books" right now, as a fraction that can land
// on a half-inning (e.g. "Bottom 6th" -> 5.5) - Top/Middle/Bottom/End are the
// only inningHalf values the MLB Stats API ever sends (see getMlbLiveScores).
// Middle and Bottom both mean "the top half is fully done" - without
// out-by-out data there's no finer signal available than that to tell them
// apart, so they're treated the same here.
function completedInnings(inningHalf: string | null, inningOrdinal: string | null): number | null {
  if (!inningOrdinal) return null;
  const n = parseInt(inningOrdinal, 10);
  if (Number.isNaN(n)) return null;

  if (inningHalf === "Top") return n - 1;
  if (inningHalf === "Middle" || inningHalf === "Bottom") return n - 0.5;
  if (inningHalf === "End") return n;
  return n - 1;
}

export function computeBoardPulse(games: BoardPulseGame[]): BoardPulseStats {
  let upsetsSoFar = 0;
  let favsLeading = 0;
  let dogsLeading = 0;
  let trendingOver = 0;
  let trendingUnder = 0;

  for (const g of games) {
    if (g.status === "preview") continue;
    if (g.homeScore === null || g.awayScore === null) continue;

    if (g.favorite) {
      const favScore = g.favorite === "home" ? g.homeScore : g.awayScore;
      const dogScore = g.favorite === "home" ? g.awayScore : g.homeScore;
      if (favScore > dogScore) {
        favsLeading++;
      } else if (dogScore > favScore) {
        dogsLeading++;
        upsetsSoFar++;
      }
      // A tie counts toward neither - the favorite isn't "losing" yet.
    }

    if (g.totalLine === null) continue;
    const combined = g.homeScore + g.awayScore;

    if (g.status === "final") {
      // Final score is the real total, not a pace - no projection needed.
      if (combined > g.totalLine) trendingOver++;
      else if (combined < g.totalLine) trendingUnder++;
      continue;
    }

    const completed = completedInnings(g.inningHalf, g.inningOrdinal);
    if (completed === null || completed < MIN_INNINGS_FOR_TREND) continue;

    const projected = combined / (completed / REGULATION_INNINGS);
    if (projected > g.totalLine) trendingOver++;
    else if (projected < g.totalLine) trendingUnder++;
  }

  const gamesSoFar = favsLeading + dogsLeading;
  const upsetRate = gamesSoFar > 0 ? upsetsSoFar / gamesSoFar : null;
  const verdict: BoardPulseVerdict =
    gamesSoFar < MIN_GAMES_FOR_VERDICT || upsetRate === null
      ? "insufficient"
      : upsetRate > MLB_UNDERDOG_WIN_RATE
        ? "hot"
        : "cold";

  return {
    gameCount: games.length,
    upsetsSoFar,
    // Unchanged - still the full day's raw expectation (games.length x the
    // historical rate). Only the comparison this gets used for changes; the
    // number itself is a legitimate, separate fact ("here's how many upsets
    // today should have by the time every game is final").
    expectedUpsets: games.length * MLB_UNDERDOG_WIN_RATE,
    gamesSoFar,
    upsetRate,
    verdict,
    favsLeading,
    dogsLeading,
    trendingOver,
    trendingUnder,
  };
}
