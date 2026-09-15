import { prisma } from "@/lib/prisma";
import type { Pick } from "@prisma/client";
import { filterPicksByGameWindow, SCORECARD_WINDOWS, type ScorecardWindow } from "@/server/data/stats";

export type PickWithSport = Pick & { sport: { name: string } };

export type PickAggregateDataset = {
  all: PickWithSport[];
  byCapperId: Map<string, PickWithSport[]>;
};

export type PickAggregateFilter = { sportName?: string; capperIds?: string[] };

// Layer 1 (acquisition): the one query every Cappers-page data function that
// needs a user's picks now goes through, instead of each hand-rolling its own
// prisma.pick.findMany. Always full history - no take/limit, no window - so
// every caller windows/filters this SAME in-memory dataset rather than
// re-querying the DB with its own narrower scope. `byCapperId` is a grouping
// convenience over `all`, not a second query.
export async function getCapperPickDataset(userId: string, filter?: PickAggregateFilter): Promise<PickAggregateDataset> {
  const all = await prisma.pick.findMany({
    where: {
      userId,
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
      ...(filter?.capperIds ? { capperId: { in: filter.capperIds } } : {}),
    },
    include: { sport: true },
  });

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
