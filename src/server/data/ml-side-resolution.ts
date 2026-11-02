// Pure core of the moneyline-side backfill (backfill-ml-side.ts): for a legacy
// MONEYLINE pick with no stored mlFavoredSide, which side of its game was the
// favorite (GameResult.favTeam, the ledger grading already writes) and which
// side was the pick on.
//
// No database here: the engine hands in the pick and the GameResult rows it
// already read, so every decision below is testable on plain objects.
//
// Conservative on purpose - a pick resolves only when its game is unambiguous:
//   - the game is found by matchGameResult, the SAME matcher grading used, and
//     only an exact team-name match counts (a fuzzy match can be the sides
//     flipped, and a favorite read off the wrong orientation is the bug this
//     backfill exists to remove);
//   - a doubleheader's two legs that disagree on the favorite (or that have no
//     ledger entry) is not guessed at;
//   - the pick's side is its stored pickedSide, else the text-match grading
//     itself falls back to (textPickedSide); text naming both teams or neither
//     is no side.
import type { PickedSide } from "@prisma/client";
import { MAX_GAME_TIME_DRIFT_MS, matchGameResult, textPickedSide } from "@/server/data/grading";

export type LedgerGame = {
  homeTeam: string;
  awayTeam: string;
  gameDate: Date;
  gameNumber: number | null;
  homeScore: number;
  awayScore: number;
  favTeam: string | null;
};

export type MlSidePick = {
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  betDetail: string | null;
  gameNumber: number | null;
  pickedSide: PickedSide | null;
};

export type SideUnresolvedReason =
  | "NO_GAME_RESULT" // no GameResult within the grading window (ungraded, or no score feed for the sport)
  | "FUZZY_MATCH_ONLY" // matched only by nickname text, orientation not guaranteed
  | "AMBIGUOUS_GAME" // a doubleheader whose legs disagree on the favorite, or lack one
  | "NO_FAVORITE" // the game's ledger row has no favTeam (no odds snapshot that day)
  | "NO_PICK_SIDE"; // neither a stored pickedSide nor an unambiguous side in the text

export type SideResolution =
  | { resolved: true; pickedSide: "HOME" | "AWAY"; mlFavoredSide: "HOME" | "AWAY"; pickedSideWasNull: boolean; game: LedgerGame }
  | { resolved: false; reason: SideUnresolvedReason };

export function resolveMlSides(pick: MlSidePick, candidates: LedgerGame[], sportKey: string): SideResolution {
  const match = matchGameResult(candidates, pick, sportKey);
  if (!match) return { resolved: false, reason: "NO_GAME_RESULT" };
  if (match.matchType !== "exact") return { resolved: false, reason: "FUZZY_MATCH_ONLY" };
  const game = match.game;

  // Same two teams within the drift window: a doubleheader's other leg (or a
  // replayed game). Without a gameNumber on the pick, every one of them must
  // name the same favorite for the answer to be safe.
  const sameMatchup = candidates.filter(
    (c) =>
      c.homeTeam === game.homeTeam &&
      c.awayTeam === game.awayTeam &&
      Math.abs(c.gameDate.getTime() - pick.gameTime.getTime()) <= MAX_GAME_TIME_DRIFT_MS &&
      (pick.gameNumber == null || c.gameNumber === pick.gameNumber)
  );
  if (sameMatchup.length > 1 && !sameMatchup.every((c) => c.favTeam !== null && c.favTeam === sameMatchup[0].favTeam)) {
    return { resolved: false, reason: "AMBIGUOUS_GAME" };
  }

  const mlFavoredSide = game.favTeam === game.homeTeam ? "HOME" : game.favTeam === game.awayTeam ? "AWAY" : null;
  if (!mlFavoredSide) return { resolved: false, reason: "NO_FAVORITE" };

  let pickedSide: "HOME" | "AWAY" | null = pick.pickedSide === "HOME" || pick.pickedSide === "AWAY" ? pick.pickedSide : null;
  const pickedSideWasNull = pickedSide === null;
  if (pickedSide === null) {
    const text = textPickedSide(pick.betDetail ?? "", pick.homeTeam, pick.awayTeam);
    if (!text.ambiguous && text.home !== text.away) pickedSide = text.home ? "HOME" : "AWAY";
  }
  if (pickedSide === null) return { resolved: false, reason: "NO_PICK_SIDE" };

  return { resolved: true, pickedSide, mlFavoredSide, pickedSideWasNull, game };
}
