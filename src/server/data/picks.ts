import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { findTeamNickname } from "@/lib/parse-catalog";
import { computeStats, computeScorecard, type ScorecardBucket, type ScorecardBucketKey } from "@/server/data/stats";

const FREE_PLAN_PICK_LIMIT = 1000;

export async function getPickPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const pickCount = await prisma.pick.count({ where: { userId } });

  return {
    isPro,
    pickCount,
    pickLimit: isPro ? null : FREE_PLAN_PICK_LIMIT,
    atLimit: !isPro && pickCount >= FREE_PLAN_PICK_LIMIT,
  };
}

export async function getSportsWithLeagues() {
  return prisma.sport.findMany({
    include: { leagues: true },
    orderBy: { name: "asc" },
  });
}

export async function createPick(
  userId: string,
  data: {
    capperId: string;
    sportId: string;
    leagueId?: string;
    homeTeam: string;
    awayTeam: string;
    betType: BetType;
    betDetail?: string;
    odds: number;
    line?: number | null;
    period?: Period;
    sportsbook?: string;
    units: number;
    gameTime: Date;
    notes?: string;
  }
) {
  const capper = await prisma.capper.findFirst({
    where: { id: data.capperId, userId },
  });
  if (!capper) {
    throw new Error("Capper not found.");
  }

  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  if (!isPro) {
    const pickCount = await prisma.pick.count({ where: { userId } });
    if (pickCount >= FREE_PLAN_PICK_LIMIT) {
      throw new Error(
        "Free plan is limited to " + FREE_PLAN_PICK_LIMIT + " picks. Upgrade to Pro for unlimited picks."
      );
    }
  }

  return prisma.pick.create({
    data: { ...data, userId, status: "PENDING" },
  });
}

export async function updatePickStatus(userId: string, pickId: string, status: PickStatus) {
  const pick = await prisma.pick.findFirst({ where: { id: pickId, userId } });
  if (!pick) {
    throw new Error("Pick not found.");
  }

  const wasPending = pick.status === "PENDING";

  return prisma.pick.update({
    where: { id: pickId },
    data: { status, ...(wasPending && status !== "PENDING" ? { gradedAt: new Date() } : {}) },
  });
}

export async function getPicksForCapper(userId: string, capperId: string) {
  return prisma.pick.findMany({
    where: { userId, capperId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "asc" },
  });
}

export type PickFilters = {
  capperId?: string;
  sportId?: string;
  status?: PickStatus;
  betType?: BetType;
  period?: Period;
};

export async function getFilteredPicksForUser(userId: string, filters: PickFilters) {
  return prisma.pick.findMany({
    where: {
      userId,
      ...(filters.capperId ? { capperId: filters.capperId } : {}),
      ...(filters.sportId ? { sportId: filters.sportId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.betType ? { betType: filters.betType } : {}),
      ...(filters.period ? { period: filters.period } : {}),
    },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

export async function getPicksForUser(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

// Finds this user's logged picks for one specific game. Tries an exact
// home/away team-name match first (reliable for MLB picks resolved to a
// real schedule game - see resolveMlbGameForNickname), then falls back to
// a nickname text search against betDetail/homeTeam/awayTeam for picks
// with free-text team data (manual entries, non-MLB sports).
export async function getPicksForGame(
  userId: string,
  params: { sportName: string; homeTeam: string; awayTeam: string; commenceTime: Date }
) {
  const sport = await prisma.sport.findFirst({
    where: { name: { equals: params.sportName, mode: "insensitive" } },
  });
  if (!sport) return [];

  const windowStart = new Date(params.commenceTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(params.commenceTime.getTime() + 2 * 86400000);

  const candidates = await prisma.pick.findMany({
    where: { userId, sportId: sport.id, gameTime: { gte: windowStart, lt: windowEnd } },
    include: { capper: true },
  });
  if (candidates.length === 0) return [];

  const exact = candidates.filter((p) => p.homeTeam === params.homeTeam && p.awayTeam === params.awayTeam);
  if (exact.length > 0) return exact;

  const homeNickname = findTeamNickname(params.homeTeam, params.sportName);
  const awayNickname = findTeamNickname(params.awayTeam, params.sportName);
  if (!homeNickname && !awayNickname) return [];

  return candidates.filter((p) => {
    const text = ((p.betDetail ?? "") + " " + p.homeTeam + " " + p.awayTeam).toLowerCase();
    return (homeNickname && text.includes(homeNickname)) || (awayNickname && text.includes(awayNickname));
  });
}

// A capper's record broken down by bet category (see computeScorecard), or
// narrowed to a single category when `filter` is given - e.g. "8-3 on
// Moneyline picks" for context on how much weight to give their pick on a
// specific game, independent of their overall record across every category.
export async function getCapperScorecard(
  userId: string,
  capperId: string,
  filter?: { betType: BetType; period: Period }
): Promise<ScorecardBucket[]> {
  const picks = await prisma.pick.findMany({ where: { userId, capperId } });
  const buckets = computeScorecard(picks);
  if (!filter) return buckets;

  const key: ScorecardBucketKey = filter.period === "FIRST_HALF" ? "F5" : (filter.betType as ScorecardBucketKey);
  return buckets.filter((b) => b.key === key);
}
