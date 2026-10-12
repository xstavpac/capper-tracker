"use server";

// Current-DB-state lookup for the Parlay slip (see parlay-pool-context.tsx).
// The slip is persisted client-side as a snapshot of ExpanderPicks; this is
// the single place the client asks "what is actually true about these picks
// right now" - status, odds and whether the game has started all come from
// here, never from the stored snapshot. Scoped to the signed-in user's own
// picks, so a pick id that belongs to someone else (or was deleted) reads as
// missing.
import { requireUser } from "@/server/auth";
import { getOwnedSlipPickRows, loadSlipBoards, picksOnBoards } from "@/server/data/parlay-slip-picks";
import type { PickStatus } from "@prisma/client";

export type SlipPickState = {
  status: PickStatus;
  odds: number;
  // The game's real start (ISO): the commenceTime of the board game this pick
  // is on, or - with no board game - the pick's own stored time when that is
  // still ahead (an import time never is). null when neither is known.
  kickoff: string | null;
  // Decided server-side against the server clock, so a skewed client clock
  // can't keep a started game on the slip. null when the kickoff isn't known
  // here; the slip then goes by the kickoff it captured when the pick was
  // added (see reconcileSlip).
  started: boolean | null;
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

  const now = Date.now();
  const out: Record<string, SlipPickState> = {};
  for (const r of rows) {
    const kickoff = onBoard.get(r.id)?.gameTime ?? (r.gameTime.getTime() > now ? r.gameTime.toISOString() : null);
    out[r.id] = {
      status: r.status,
      odds: r.odds,
      kickoff,
      started: kickoff === null ? null : new Date(kickoff).getTime() <= now,
    };
  }
  return out;
}
