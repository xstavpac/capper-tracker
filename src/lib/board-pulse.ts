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

// Below this many FINISHED games the pace signal is too noisy to call "running
// hot" or "running cold" off of at all - a hard floor on top of the dynamic
// +/-sigma dead band (which already widens the "on pace" zone at small samples,
// but a 1- or 2-game sample is worth no verdict regardless). In-progress games
// are excluded from this count entirely (a lead can evaporate). Below this, the
// panel shows a neutral "not enough games yet" state instead of a verdict.
export const MIN_GAMES_FOR_VERDICT = 3;

export type BoardPulseVerdict = "hot" | "cold" | "on pace" | "insufficient";

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
  // The full fixed slate: every game passed in, including not-yet-started ones.
  // This is what expectedUpsets is based on, and it must stay constant through
  // the day - the caller feeds computeBoardPulse a today-scoped list built off
  // the odds snapshot, never the Live board's filtered/rendered list (which
  // drops finished games). See live/page.tsx and live-scoreboard-ordering.ts.
  gameCount: number;
  expectedUpsets: number;

  // ---- Confirmed: game is Final ----
  favsWon: number;
  dogsWon: number;
  upsetsConfirmed: number; // === dogsWon - a favorite that actually lost
  // favsWon + dogsWon (final ties, which MLB can't have anyway, excluded).
  // The verdict denominator and the sample the MIN_GAMES_FOR_VERDICT guard
  // counts - an in-progress lead is not a result and never feeds this.
  decidedGames: number;

  // ---- Live: game in progress, has a current leader ----
  favsLeadingLive: number;
  dogsLeadingLive: number;
  upsetsLive: number; // === dogsLeadingLive - a favorite currently trailing

  // upsetsConfirmed / decidedGames - null when decidedGames is 0 (nothing to
  // divide). The panel's "+N pts vs avg" line still shows this against
  // MLB_UNDERDOG_WIN_RATE; the verdict itself no longer uses it (see paceDelta).
  upsetRate: number | null;

  // ---- Pace: confirmed upsets vs what the historical rate predicts for the
  //      games finished SO FAR (not the whole day - that's expectedUpsets) ----
  // decidedGames * MLB_UNDERDOG_WIN_RATE - the pro-rated yardstick.
  expectedUpsetsSoFar: number;
  // upsetsConfirmed - expectedUpsetsSoFar. Signed: positive = more upsets than
  // the baseline predicts at this many finished games, negative = fewer.
  paceDelta: number;
  // One binomial standard deviation on the confirmed-upset count at this sample
  // size: sqrt(decidedGames * p * (1 - p)), p = MLB_UNDERDOG_WIN_RATE. The
  // dead band the verdict uses - |paceDelta| within one sigma is "on pace".
  // Grows with sample size, so a raw +1 upset reads as noise at 3 games and as
  // signal at 15.
  sigma: number;

  // "insufficient" below MIN_GAMES_FOR_VERDICT decided (final) games. Otherwise
  // paceDelta against the +/-sigma band: strictly above -> "hot", strictly
  // below -> "cold", on-or-within -> "on pace". Judged only on finished games;
  // a live lead can evaporate. See classifyPace.
  verdict: BoardPulseVerdict;

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

// The verdict decision, split out so the exact dead-band boundaries are
// directly testable (paceDelta === +/-sigma etc. can't be hit with an integer
// upset count from a real fixture). "insufficient" below MIN_GAMES_FOR_VERDICT
// finished games; otherwise paceDelta against the +/-sigma band - strictly
// outside it is "hot"/"cold", exactly on or inside it is "on pace".
export function classifyPace(paceDelta: number, sigma: number, decidedGames: number): BoardPulseVerdict {
  if (decidedGames < MIN_GAMES_FOR_VERDICT) return "insufficient";
  if (paceDelta > sigma) return "hot";
  if (paceDelta < -sigma) return "cold";
  return "on pace";
}

export function computeBoardPulse(games: BoardPulseGame[]): BoardPulseStats {
  let favsWon = 0;
  let dogsWon = 0;
  let favsLeadingLive = 0;
  let dogsLeadingLive = 0;
  let trendingOver = 0;
  let trendingUnder = 0;

  for (const g of games) {
    if (g.status === "preview") continue;
    if (g.homeScore === null || g.awayScore === null) continue;

    if (g.favorite) {
      const favScore = g.favorite === "home" ? g.homeScore : g.awayScore;
      const dogScore = g.favorite === "home" ? g.awayScore : g.homeScore;
      // A tie counts toward neither - the favorite isn't "losing" yet.
      if (g.status === "final") {
        if (favScore > dogScore) favsWon++;
        else if (dogScore > favScore) dogsWon++;
      } else {
        if (favScore > dogScore) favsLeadingLive++;
        else if (dogScore > favScore) dogsLeadingLive++;
      }
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

  const upsetsConfirmed = dogsWon;
  const upsetsLive = dogsLeadingLive;
  const decidedGames = favsWon + dogsWon;
  const upsetRate = decidedGames > 0 ? upsetsConfirmed / decidedGames : null;
  const expectedUpsetsSoFar = decidedGames * MLB_UNDERDOG_WIN_RATE;
  const paceDelta = upsetsConfirmed - expectedUpsetsSoFar;
  const sigma = Math.sqrt(decidedGames * MLB_UNDERDOG_WIN_RATE * (1 - MLB_UNDERDOG_WIN_RATE));
  const verdict = classifyPace(paceDelta, sigma, decidedGames);

  return {
    // games.length is the full fixed slate (every game handed in, including
    // not-yet-started ones) - the caller guarantees this list does not shrink
    // as games finalize, so expectedUpsets is a constant for the whole day.
    gameCount: games.length,
    expectedUpsets: games.length * MLB_UNDERDOG_WIN_RATE,
    favsWon,
    dogsWon,
    upsetsConfirmed,
    decidedGames,
    favsLeadingLive,
    dogsLeadingLive,
    upsetsLive,
    upsetRate,
    expectedUpsetsSoFar,
    paceDelta,
    sigma,
    verdict,
    trendingOver,
    trendingUnder,
  };
}
