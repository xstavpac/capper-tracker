import { prisma } from "@/lib/prisma";
import type { Source } from "@prisma/client";
import { computeStats, type OverallStats } from "@/server/data/stats";

export async function getCappersForUser(userId: string) {
  return prisma.capper.findMany({
    where: { userId },
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
  options?: { days?: number; minGradedPicks?: number; limit?: number }
): Promise<WeeklyLeaderboardEntry[]> {
  const days = options?.days ?? 7;
  const minGradedPicks = options?.minGradedPicks ?? 3;
  const limit = options?.limit ?? 5;
  const windowStart = new Date(Date.now() - days * 86400000);

  const picks = await prisma.pick.findMany({
    where: { userId, status: { in: ["WIN", "LOSS", "PUSH"] }, gradedAt: { gte: windowStart } },
    include: { capper: true },
  });

  const byCapper = new Map<string, { name: string; colorTag: string | null; picks: typeof picks }>();
  for (const pick of picks) {
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
