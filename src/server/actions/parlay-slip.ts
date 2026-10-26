"use server";

// Current-DB-state lookup for the Parlay slip (see parlay-pool-context.tsx).
// The slip is persisted client-side as a snapshot of ExpanderPicks; this is
// the single place the client asks "what is actually true about these picks
// right now" - status, odds and whether the game is over all come from
// here, never from the stored snapshot. Scoped to the signed-in user's own
// picks, so a pick id that belongs to someone else (or was deleted) reads as
// missing.
import { requireUser } from "@/server/auth";
import { getOwnedSlipPickRows, loadSlipBoards, picksOnBoards } from "@/server/data/parlay-slip-picks";
import type { PickStatus } from "@prisma/client";
import { hasKickedOff, isGameOver, type GameFeedStatus } from "@/lib/parlay/game-over";

export type SlipPickState = {
  status: PickStatus;
  odds: number;
  // The game's real start (ISO): the commenceTime of the board game this pick
  // is on, or - with no board game - the pick's own stored time when that is
  // still ahead (an import time never is). null when neither is known.
  kickoff: string | null;
  // The score feed's status for the game, null when the board has no row for it.
  gameStatus: GameFeedStatus | null;
  // Decided server-side against the server clock (isGameOver), so a skewed
  // client clock can't keep a finished game on the slip. A game that is merely
  // live stays. null when the kickoff isn't known here; the slip then goes by
  // the kickoff it captured when the pick was added (see reconcileSlip).
  over: boolean | null;
};

// Keyed by pickId; an id absent from the result no longer exists (deleted).
export async function getSlipPickStatesAction(pickIds: string[]): Promise<Record<string, SlipPickState>> {
  const user = await requireUser();
  const ids = Array.from(new Set(pickIds)).slice(0, 500);
  if (ids.length === 0) return {};

  const rows = await getOwnedSlipPickRows(user.id, ids);
  // Only a pending pick's kickoff matters - a graded one is pruned for its
  // result - so only their leagues' boards are loaded.
  const pending = rows.filter((r) => r.status === "PENDING");
  // A board that can't be loaded must not fail the whole check (status and
  // odds are still known): those picks just read as "kickoff not known here".
  const boards = await loadSlipBoards(user.id, pending).catch(() => []);
  const onBoard = picksOnBoards(
    boards,
    pending.map((r) => r.id)
  );

  const now = new Date();
  const out: Record<string, SlipPickState> = {};
  for (const r of rows) {
    const board = onBoard.get(r.id);
    const kickoff = board?.gameTime ?? (hasKickedOff(r.gameTime.toISOString(), now) ? null : r.gameTime.toISOString());
    const gameStatus = board?.gameStatus ?? null;
    out[r.id] = {
      status: r.status,
      odds: r.odds,
      kickoff,
      gameStatus,
      over: kickoff === null ? null : isGameOver({ gameTime: kickoff, gameStatus }, now),
    };
  }
  return out;
}
