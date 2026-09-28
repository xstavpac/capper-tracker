import { prisma } from "@/lib/prisma";
import type { Pick } from "@prisma/client";
import { filterPicksByGameWindow, SCORECARD_WINDOWS, type ScorecardWindow } from "@/server/data/stats";

export type PickWithSport = Pick & { sport: { name: string } };

export type PickAggregateDataset = {
  all: PickWithSport[];
  byCapperId: Map<string, PickWithSport[]>;
};

export type PickAggregateFilter = { sportName?: string; capperIds?: string[] };

// Layer 1 (acquisition): the raw-pick fetch behind the /cappers legacy JS path
// (see pick-aggregates-cappers-adapter.ts - now only the fallback for a user with
// unstamped picks / a category filter; the page's normal path aggregates in SQL
// and never calls this). Always full history - no take/limit, no window - so
// every caller windows/filters this SAME in-memory dataset rather than
// re-querying the DB with its own narrower scope. `byCapperId` is a grouping
// convenience over `all`, not a second query.
//
// Returned sorted by (createdAt, id): findMany without an orderBy has no
// defined order, and stable sorts downstream (computeStats' gameTime sort,
// Map-insertion-ordered ties) inherit it. Fixing it here makes createdAt, id the
// tie-break everywhere order matters, matching the SQL path.
export async function getCapperPickDataset(userId: string, filter?: PickAggregateFilter): Promise<PickAggregateDataset> {
  const all = await prisma.pick.findMany({
    where: {
      userId,
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
      ...(filter?.capperIds ? { capperId: { in: filter.capperIds } } : {}),
    },
    include: { sport: true },
  });
  all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byCapperId = new Map<string, PickWithSport[]>();
  for (const pick of all) {
    const list = byCapperId.get(pick.capperId);
    if (list) list.push(pick);
    else byCapperId.set(pick.capperId, [pick]);
  }

  return { all, byCapperId };
}

// Layer 2 (windowing): a thin wrapper over filterPicksByGameWindow - adds no
// filtering logic of its own, so every window's slice is byte-identical to
// calling filterPicksByGameWindow(picks, window) directly. Defaults to every
// ScorecardWindow so a caller that wants the full set doesn't have to spell
// out the list; a caller only after one window's slice (e.g. the leaderboard
// table's per-window signature) passes a single-element array and indexes it.
export function sliceIntoWindows<T extends { gameTime: Date; gradedAt: Date | null }>(
  picks: T[],
  windows: ScorecardWindow[] = SCORECARD_WINDOWS
): Record<ScorecardWindow, T[]> {
  const out = {} as Record<ScorecardWindow, T[]>;
  for (const window of windows) {
    out[window] = filterPicksByGameWindow(picks, window);
  }
  return out;
}
