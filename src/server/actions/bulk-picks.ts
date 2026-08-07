"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { createCapper } from "@/server/data/cappers";
import { createPick } from "@/server/data/picks";
import { resolveMlbGameForNickname, findMlbMarketPrice } from "@/server/data/odds";
import { findTeamNickname } from "@/lib/parse-catalog";
import type { BetType } from "@prisma/client";

export type BulkImportItem = {
  capperName: string;
  sportName: string;
  description: string;
  betType: BetType;
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  units: number;
  isFirstFive: boolean;
};

export type BulkImportResult =
  | { success: true; imported: number; skipped: number; errors: string[]; unmatchedGames: string[] }
  | { success: false; error: string };

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function bulkImportPicksAction(items: BulkImportItem[]): Promise<BulkImportResult> {
  const user = await requireUser();

  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id } });

  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();
  const errors: string[] = [];
  const unmatchedGames: string[] = [];
  let imported = 0;

  for (const item of items) {
    try {
      const normalizedName = normalizeName(item.capperName);
      let capperId = capperCache.get(normalizedName);

      if (!capperId) {
        const existing = existingCappers.find((c) => normalizeName(c.name) === normalizedName);
        if (existing) {
          capperId = existing.id;
        } else {
          const created = await createCapper(user.id, {
            name: item.capperName,
            source: "OTHER",
            customSource: "Bulk import",
          });
          capperId = created.id;
          existingCappers.push(created);
        }
        capperCache.set(normalizedName, capperId);
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

      let homeTeam = item.description;
      let awayTeam = "-";
      let gameTime = new Date();
      let odds = item.odds;

      if (item.sportName.toUpperCase() === "MLB") {
        const nickname = findTeamNickname(item.description, "MLB");
        const game = nickname ? await resolveMlbGameForNickname(nickname) : null;
        if (game) {
          homeTeam = game.homeTeam;
          awayTeam = game.awayTeam;
          gameTime = new Date(game.commenceTime);

          if (!item.hasExplicitOdds) {
            const side =
              item.betType === "TOTAL"
                ? item.totalSide
                : game.homeTeam.toLowerCase().endsWith(nickname!)
                ? "home"
                : "away";

            const marketPrice = side ? await findMlbMarketPrice(game, item.betType, side) : null;
            if (marketPrice !== null) {
              odds = marketPrice;
            }
          }
        } else {
          unmatchedGames.push(item.capperName + " - " + item.description);
        }
      }

      await createPick(user.id, {
        capperId,
        sportId,
        homeTeam,
        awayTeam,
        betType: item.betType,
        betDetail: item.description,
        odds,
        units: item.units,
        gameTime,
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

  return { success: true, imported, skipped: items.length - imported, errors, unmatchedGames };
}
