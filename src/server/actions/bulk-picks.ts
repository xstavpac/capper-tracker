"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { createCapper } from "@/server/data/cappers";
import { createPick } from "@/server/data/picks";
import type { BetType } from "@prisma/client";

export type BulkImportItem = {
  capperName: string;
  sportName: string;
  description: string;
  betType: BetType;
  odds: number;
  units: number;
  isFirstFive: boolean;
};

export type BulkImportResult =
  | { success: true; imported: number; skipped: number; errors: string[] }
  | { success: false; error: string };

export async function bulkImportPicksAction(items: BulkImportItem[]): Promise<BulkImportResult> {
  const user = await requireUser();

  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();
  const errors: string[] = [];
  let imported = 0;

  for (const item of items) {
    try {
      const capperKey = item.capperName.toLowerCase();
      let capperId = capperCache.get(capperKey);
      if (!capperId) {
        let capper = await prisma.capper.findFirst({
          where: { userId: user.id, name: { equals: item.capperName, mode: "insensitive" } },
        });
        if (!capper) {
          capper = await createCapper(user.id, {
            name: item.capperName,
            source: "OTHER",
            customSource: "Bulk import",
          });
        }
        capperId = capper.id;
        capperCache.set(capperKey, capperId);
      }

      const sportKey = item.sportName.toLowerCase();
      let sportId = sportCache.get(sportKey);
      if (!sportId) {
        let sport = await prisma.sport.findFirst({
          where: { name: { equals: item.sportName, mode: "insensitive" } },
        });
        if (!sport) {
          sport = await prisma.sport.create({ data: { name: item.sportName } });
        }
        sportId = sport.id;
        sportCache.set(sportKey, sportId);
      }

      await createPick(user.id, {
        capperId,
        sportId,
        homeTeam: item.description,
        awayTeam: "-",
        betType: item.betType,
        betDetail: item.description,
        odds: item.odds,
        units: item.units,
        gameTime: new Date(),
        notes: item.isFirstFive ? "First 5 / first half" : undefined,
      });
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(item.capperName + " - " + item.description + ": " + message);
    }
  }

  revalidatePath("/picks");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  revalidatePath("/reports");

  return { success: true, imported, skipped: items.length - imported, errors };
}
