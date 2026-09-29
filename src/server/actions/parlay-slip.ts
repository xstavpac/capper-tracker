"use server";

// Current-DB-state lookup for the Parlay slip (see parlay-pool-context.tsx).
// The slip is persisted client-side as a snapshot of ExpanderPicks; this is
// the single place the client asks "what is actually true about these picks
// right now" - status, odds and game time all come from here, never from the
// stored snapshot. Scoped to the signed-in user's own picks, so a pick id that
// belongs to someone else (or was deleted) reads as missing.
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import type { PickStatus } from "@prisma/client";

export type SlipPickState = {
  status: PickStatus;
  odds: number;
  gameTime: string; // ISO
  // Decided server-side against the server clock, so a skewed client clock
  // can't keep a started game on the slip.
  started: boolean;
};

// Keyed by pickId; an id absent from the result no longer exists (deleted).
export async function getSlipPickStatesAction(pickIds: string[]): Promise<Record<string, SlipPickState>> {
  const user = await requireUser();
  const ids = Array.from(new Set(pickIds)).slice(0, 500);
  if (ids.length === 0) return {};

  const rows = await prisma.pick.findMany({
    where: { userId: user.id, id: { in: ids } },
    select: { id: true, status: true, odds: true, gameTime: true },
  });
  const now = Date.now();
  const out: Record<string, SlipPickState> = {};
  for (const r of rows) {
    out[r.id] = {
      status: r.status,
      odds: r.odds,
      gameTime: r.gameTime.toISOString(),
      started: r.gameTime.getTime() <= now,
    };
  }
  return out;
}
