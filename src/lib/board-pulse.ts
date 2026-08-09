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

  return {
    gameCount: games.length,
    upsetsSoFar,
    expectedUpsets: games.length * MLB_UNDERDOG_WIN_RATE,
    favsLeading,
    dogsLeading,
    trendingOver,
    trendingUnder,
  };
}
