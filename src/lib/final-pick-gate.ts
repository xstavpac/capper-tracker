// Which finished games persistFinalScores writes a GameResult row for, in the
// sports that only persist games somebody has a pick on.
//
// Every other sport persists every final on its feed. NCAAB's feed is ~180
// Division I games on a busy day (verified live 2026-11-02: 182), and a
// GameResult row exists to grade a pick or to feed team tendencies from; a game
// nobody picked is a write, a later read and storage that serves neither. So
// NCAAB persists a final only while a PENDING pick names its two teams.
//
// Pure (no DB, no network): grading.ts reads the pending picks' team pairs and
// hands them here.
import { teamNamesMatch } from "@/lib/team-name-match";

export const NCAAB_SPORT_KEY = "basketball_ncaab";

// Sports whose GameResult rows are written only for games with a pending pick.
export const PICK_GATED_SPORT_KEYS: ReadonlySet<string> = new Set([NCAAB_SPORT_KEY]);

export type PickTeamPair = { homeTeam: string; awayTeam: string };

// The finals some pick names, in either orientation: the Odds API and ESPN can
// disagree on home/away for a neutral-site game, and the pick carries whichever
// feed resolved it. Names compare the way every other cross-feed join does
// (teamNamesMatch: case, accents, "St." / "St").
export function finalsWithPicks<T extends PickTeamPair>(finals: T[], pairs: PickTeamPair[], sportKey: string): T[] {
  if (finals.length === 0 || pairs.length === 0) return [];
  return finals.filter((g) =>
    pairs.some(
      (p) =>
        (teamNamesMatch(p.homeTeam, g.homeTeam, sportKey) && teamNamesMatch(p.awayTeam, g.awayTeam, sportKey)) ||
        (teamNamesMatch(p.homeTeam, g.awayTeam, sportKey) && teamNamesMatch(p.awayTeam, g.homeTeam, sportKey))
    )
  );
}
