import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus } from "@prisma/client";

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

  return prisma.pick.update({
    where: { id: pickId },
    data: { status },
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
};

export async function getFilteredPicksForUser(userId: string, filters: PickFilters) {
  return prisma.pick.findMany({
    where: {
      userId,
      ...(filters.capperId ? { capperId: filters.capperId } : {}),
      ...(filters.sportId ? { sportId: filters.sportId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.betType ? { betType: filters.betType } : {}),
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
