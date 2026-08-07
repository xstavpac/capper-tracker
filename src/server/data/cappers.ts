import { prisma } from "@/lib/prisma";
import type { Source } from "@prisma/client";
import { computeStats, pickCategory, type OverallStats, type PickCategoryKey } from "@/server/data/stats";

export type CapperLeagueFilter = { sportName?: string; category?: PickCategoryKey };

export async function getCappersForUser(userId: string, filter?: CapperLeagueFilter) {
  if (!filter?.sportName && !filter?.category) {
    return prisma.capper.findMany({
      where: { userId },
      orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
    });
  }

  // Membership-only filter for now (Phase 2) - narrows which cappers show up
  // for the active league/bet-type chips. The grid itself doesn't display
  // per-filter stats yet; that's the Phase 3 ranked-list rebuild.
  const picks = await prisma.pick.findMany({
    where: { userId, ...(filter.sportName ? { sport: { name: filter.sportName } } : {}) },
    select: { capperId: true, betType: true, period: true, betDetail: true, odds: true, line: true },
  });
  const matchingCapperIds = new Set(
    picks.filter((p) => !filter.category || pickCategory(p) === filter.category).map((p) => p.capperId)
  );

  return prisma.capper.findMany({
    where: { userId, id: { in: Array.from(matchingCapperIds) } },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
}

export async function getCapperById(userId: string, capperId: string) {
  return prisma.capper.findFirst({
    where: { id: capperId, userId },
  });
}

export async function getPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const capperCount = await prisma.capper.count({ where: { userId } });

  return { isPro, capperCount };
}

export type WeeklyLeaderboardEntry = {
  capperId: string;
  name: string;
  colorTag: string | null;
  stats: OverallStats;
};

// Top performers over a trailing window, ranked by ROI - "who's hot right
// now" alongside the all-time record on the capper's own page. Requires a
// minimum number of graded picks in the window so one lucky bet can't rank
// someone who's barely been tracked that week.
export async function getWeeklyCapperLeaderboard(
  userId: string,
  options?: { days?: number; minGradedPicks?: number; limit?: number } & CapperLeagueFilter
): Promise<WeeklyLeaderboardEntry[]> {
  const days = options?.days ?? 7;
  const minGradedPicks = options?.minGradedPicks ?? 3;
  const limit = options?.limit ?? 5;
  const windowStart = new Date(Date.now() - days * 86400000);

  const picks = await prisma.pick.findMany({
    where: {
      userId,
      status: { in: ["WIN", "LOSS", "PUSH"] },
      gradedAt: { gte: windowStart },
      ...(options?.sportName ? { sport: { name: options.sportName } } : {}),
    },
    include: { capper: true },
  });

  const scoped = options?.category ? picks.filter((p) => pickCategory(p) === options.category) : picks;

  const byCapper = new Map<string, { name: string; colorTag: string | null; picks: typeof picks }>();
  for (const pick of scoped) {
    const existing = byCapper.get(pick.capperId);
    if (existing) existing.picks.push(pick);
    else byCapper.set(pick.capperId, { name: pick.capper.name, colorTag: pick.capper.colorTag, picks: [pick] });
  }

  return Array.from(byCapper.entries())
    .map(([capperId, g]) => ({ capperId, name: g.name, colorTag: g.colorTag, stats: computeStats(g.picks) }))
    .filter((e) => e.stats.wins + e.stats.losses + e.stats.pushes >= minGradedPicks)
    .sort((a, b) => b.stats.roi - a.stats.roi)
    .slice(0, limit);
}

export async function createCapper(
  userId: string,
  data: {
    name: string;
    source: Source;
    customSource?: string;
    photoUrl?: string;
    notes?: string;
    sportSpecialization?: string;
    colorTag?: string;
  }
) {
  return prisma.capper.create({
    data: { ...data, userId },
  });
}
