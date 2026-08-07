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

export async function getPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const capperCount = await prisma.capper.count({ where: { userId } });

  return { isPro, capperCount };
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
