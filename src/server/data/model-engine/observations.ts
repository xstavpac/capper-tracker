// The DATA layer's dated game-observation series - resolveGameObservations
// returns canonical per-game facts only (what happened), never team-
// bucketed, accumulated, or weighted (how a calculation uses them). That
// separation belongs to the calculation layer (Build Step 3), the same way
// resolver.ts's resolveVariable stays a pure point-in-time value lookup and
// leaves everything downstream of it to later steps.
//
// Grounded directly in the original Decay Delta source
// (StavsPredictiveAnalytics (70).jsx:260-308, computeDecayGameDelta),
// already traced and cited exactly during the fact-finding pass - see
// resolveGameObservations' own comments below for the one deliberate,
// permanent divergence from it.
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";

export type GameObservation = {
  gameId: string;
  gameDate: Date;
  favTeam: string;
  dogTeam: string;
  favWon: boolean;
  wentOver: boolean | null;
  isPush: boolean;
};

// sportKey-scoped, ascending by gameDate - not filtered by team, since the
// calculation layer decides which team(s) a given historical game is
// relevant to (see Build Step 3), not this function.
export async function resolveGameObservations(sportKey: string, asOf: Date): Promise<GameObservation[]> {
  const asOfKey = easternDateKey(asOf);

  const rows = await prisma.gameResult.findMany({
    where: { sportKey },
    orderBy: { gameDate: "asc" },
  });

  const observations: GameObservation[] = [];

  for (const row of rows) {
    // This deliberately diverges from 3 of 4 original Decay Delta call
    // sites, which included same-day games. This function enforces strict
    // gameDate < asOf unconditionally, per this project's temporal-integrity
    // invariant (no model may resolve a value using information that
    // wouldn't have existed at evaluation time). The original call site that
    // excluded same-day games (for exactly this reason) establishes the
    // intended behavior; the other three did not consistently follow their
    // own principle.
    //
    // Compared as Eastern calendar days (easternDateKey), not raw
    // millisecond timestamps - matching the DATA layer's existing
    // point-in-time convention (findLatestAtOrBefore/snapshot-utils.ts
    // compares snapshotDate strings the same way, and TeamTendencySnapshot's
    // own daily-snapshot boundary is day-granular, not sub-day). A game on
    // asOf's own Eastern calendar day is excluded even if its timestamp is
    // technically earlier in the day than asOf.
    if (easternDateKey(row.gameDate) >= asOfKey) continue;

    // GameResult.favTeam is this project's established canonical favorite
    // field (see grading.ts's deriveLedgerFields) - used directly, not
    // re-derived, so this function doesn't become a fourth "who's the
    // favorite" implementation. A null favTeam means no odds snapshot could
    // be matched to this game at persist time - excluded, not guessed.
    if (row.favTeam === null) continue;

    // deriveLedgerFields' own matching logic guarantees favTeam is
    // byte-identical to homeTeam or awayTeam for any row it actually set -
    // but a row sourced some other way (e.g. a differently-populated seed
    // import) isn't guaranteed to hold that invariant. Defend against it
    // rather than silently mis-deriving dogTeam/favWon: real data checked
    // during this step's acceptance test had zero such rows, but the guard
    // costs nothing and "missing beats wrong" is this app's existing
    // convention (see mlb-stats.ts's captureTeamStatSnapshots).
    const favIsHome = row.favTeam === row.homeTeam;
    const favIsAway = row.favTeam === row.awayTeam;
    if (!favIsHome && !favIsAway) continue;

    // A tied final score has no true favWon value - neither "the favorite
    // won" nor "the favorite lost" is correct. The original source's
    // `if (r.favWon) {...} else {...}` had no guard for this either (a tie
    // would silently fall into the "favorite lost" branch) - this closes
    // that same class of bug the fact-finding pass flagged for the
    // ungraded-row case, applied here to the one other place a plain
    // boolean can't honestly represent what happened. MLB games can't end
    // tied (extra innings), but this app's LIVE_SPORTS also includes NFL,
    // which can.
    if (row.homeScore === row.awayScore) continue;

    const favWon = favIsHome ? row.homeScore > row.awayScore : row.awayScore > row.homeScore;
    const dogTeam = favIsHome ? row.awayTeam : row.homeTeam;

    // wentOver/isPush derive from GameResult.totalLine and the actual final
    // score - there's no separate stored push flag for either the total or
    // the moneyline, so both are computed here, not read off an existing
    // field. A null totalLine means no line could be matched to this game
    // (same "no snapshot" reasoning as favTeam) - wentOver stays null rather
    // than guessing a side, and isPush is false (the concept doesn't apply
    // without a line to push against, not "known not to have pushed").
    const actualTotal = row.homeScore + row.awayScore;
    let wentOver: boolean | null;
    let isPush: boolean;
    if (row.totalLine === null) {
      wentOver = null;
      isPush = false;
    } else if (actualTotal === row.totalLine) {
      // Exactly on the line - neither over nor under is true.
      wentOver = null;
      isPush = true;
    } else {
      wentOver = actualTotal > row.totalLine;
      isPush = false;
    }

    observations.push({
      gameId: row.id,
      gameDate: row.gameDate,
      favTeam: row.favTeam,
      dogTeam,
      favWon,
      wentOver,
      isPush,
    });
  }

  return observations;
}
