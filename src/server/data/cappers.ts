import { prisma } from "@/lib/prisma";
import type { Source } from "@prisma/client";

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

const FREE_PLAN_CAPPER_LIMIT = 2;

export async function getPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const capperCount = await prisma.capper.count({ where: { userId } });

  return {
    isPro,
    capperCount,
    capperLimit: isPro ? null : FREE_PLAN_CAPPER_LIMIT,
    atLimit: !isPro && capperCount >= FREE_PLAN_CAPPER_LIMIT,
  };
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
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";

  if (!isPro) {
    const existingCount = await prisma.capper.count({ where: { userId } });
    if (existingCount >= FREE_PLAN_CAPPER_LIMIT) {
      throw new Error("Free plan is limited to " + FREE_PLAN_CAPPER_LIMIT + " cappers. Upgrade to Pro for unlimited cappers.");
    }
  }

  return prisma.capper.create({
    data: { ...data, userId },
  });
}
