"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { createCapper } from "@/server/data/cappers";
import { createPicksWithEntitlementCheck, type PickInsertData } from "@/server/data/subscriptions";
import {
  resolveGameForNickname,
  resolveGameForTeams,
  findMarketPrice,
  LIVE_SPORTS,
  RESOLVABLE_SPORT_KEYS,
} from "@/server/data/odds";
import { extractLine } from "@/lib/bet-line";
import { normalizeName } from "@/lib/fuzzy-match";
import { pickCategory, betTypeLabel } from "@/server/data/stats";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import type { BetType } from "@prisma/client";

export type BulkImportItem = {
  capperName: string;
  sportName: string;
  description: string;
  betType: BetType;
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  units: number;
  isFirstFive: boolean;
};

export type BulkImportResult =
  | {
      success: true;
      imported: number;
      skipped: number;
      errors: string[];
      unmatchedGames: string[];
      // Set only when the ENTIRE batch was rejected by the Free-plan pick
      // limit (never a partial import) - distinct from `errors`, which is
      // per-item failures unrelated to billing (bad data, unresolved game,
      // etc). See createPicksWithEntitlementCheck.
      pickLimitBlocked?: { message: string; remaining: number };
    }
  | { success: false; error: string };

type ResolvableItem = {
  sportName: string;
  betType: BetType;
  hasExplicitOdds: boolean;
  odds: number;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  description: string;
};

// Shared by the real import (bulkImportPicksAction) and the read-only preview
// enrichment (previewBulkImportOdds) below - only attempts resolution for
// sports with a real score source wired up (see RESOLVABLE_SPORT_KEYS),
// otherwise every pick in an unsupported sport would spuriously get flagged
// as unmatched when resolution was never actually possible for it.
async function resolveGameAndOdds(item: ResolvableItem): Promise<{
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  odds: number;
  resolvable: boolean; // sport has a real score source wired up at all
  matched: boolean; // and a specific game was actually found in it
}> {
  let homeTeam = item.description;
  let awayTeam = "-";
  let gameTime = new Date();
  let odds = item.odds;
  let matched = false;

  const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())?.key;
  const resolvable = Boolean(liveSportKey && RESOLVABLE_SPORT_KEYS.includes(liveSportKey));
  if (liveSportKey && resolvable) {
    const nicknames = item.teamNicknames;
    const game =
      nicknames.length >= 2
        ? await resolveGameForTeams(liveSportKey, nicknames[0], nicknames[1])
        : nicknames.length === 1
          ? await resolveGameForNickname(liveSportKey, nicknames[0])
          : null;
    if (game) {
      matched = true;
      homeTeam = game.homeTeam;
      awayTeam = game.awayTeam;
      gameTime = new Date(game.commenceTime);

      if (!item.hasExplicitOdds) {
        const side =
          item.betType === "TOTAL"
            ? item.totalSide
            : game.homeTeam.toLowerCase().endsWith(nicknames[0])
            ? "home"
            : "away";

        const marketPrice = side ? await findMarketPrice(liveSportKey, game, item.betType, side) : null;
        if (marketPrice !== null) {
          odds = marketPrice;
        }
      }
    }
  }

  return { homeTeam, awayTeam, gameTime, odds, resolvable, matched };
}

// Read-only preview enrichment: the client-side catalog parser has no access
// to live odds (it only runs parseCatalog in the browser), so the "Drop
// Catalog" preview always showed the -110 default even when a real price was
// about to be looked up at actual import time - confusing, since the two
// numbers could silently differ. This runs the same resolution+lookup logic
// bulkImportPicksAction uses, without persisting anything, so the preview
// matches what actually gets saved.
export async function previewBulkImportOdds(items: ResolvableItem[]): Promise<Record<number, number>> {
  await requireUser();

  const enriched: Record<number, number> = {};
  await Promise.all(
    items.map(async (item, i) => {
      if (item.hasExplicitOdds) return;
      const { odds, matched } = await resolveGameAndOdds(item);
      if (matched && odds !== item.odds) enriched[i] = odds;
    })
  );
  return enriched;
}

export type DuplicateCheckItem = ResolvableItem & { capperName: string; isFirstFive: boolean };
export type DuplicateFlag = { message: string };

// A duplicate is specifically the SAME capper + SAME game + SAME bet type
// AND side (e.g. two "Cubs Moneyline" picks) - NOT just the same team, and
// NOT the same capper on the same game with a different bet (a capper can
// legitimately have both "Cubs Moneyline" and "Cubs -1.5" on one game).
// pickCategory already draws exactly that side-aware line (FAV_ML vs DOG_ML,
// SPREAD_MINUS vs SPREAD_PLUS, OVER vs UNDER) for the app's existing
// category panels, so it's reused here rather than re-deriving "same side"
// from scratch. Odds/line/units are deliberately never compared - two picks
// on the same side with different prices are still the same pick logged
// twice, per how this was scoped with the user. Read-only, same pattern as
// previewBulkImportOdds: keyed by each item's position in the input array so
// the caller can remap into `parsed` indices itself.
export async function checkDuplicatePicksAction(items: DuplicateCheckItem[]): Promise<Record<number, DuplicateFlag>> {
  const user = await requireUser();
  const flags: Record<number, DuplicateFlag> = {};

  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id } });
  const capperByNormalizedName = new Map(existingCappers.map((c) => [normalizeName(c.name), c]));

  await Promise.all(
    items.map(async (item, i) => {
      // A brand-new capper (not yet in this user's list) can't already have
      // a pick logged, by definition.
      const capper = capperByNormalizedName.get(normalizeName(item.capperName));
      if (!capper) return;

      // Only checked once resolved to a real scheduled game - without that,
      // "same game" has nothing reliable to compare against (see
      // resolveGameAndOdds; unresolved items fall back to placeholder
      // homeTeam/awayTeam values that aren't safe to match on).
      const { homeTeam, awayTeam, gameTime, odds, matched } = await resolveGameAndOdds(item);
      if (!matched) return;

      // odds (not item.odds) - for a pick with no explicit price, item.odds
      // is still the parser's un-resolved default and would misclassify a
      // moneyline's favorite/underdog side (see favoriteOrUnderdog). odds is
      // resolveGameAndOdds' resolved real market price for this exact pick.
      const period = item.isFirstFive ? "FIRST_HALF" : "FULL_GAME";
      const line = extractLine(item.betType, item.description);
      const category = pickCategory({ betType: item.betType, period, betDetail: item.description, odds, line });
      // Can't determine a comparable side for this bet (e.g. a player prop,
      // or a first-half spread) - don't guess at a match either way.
      if (!category) return;

      const windowStart = new Date(gameTime.getTime() - MAX_GAME_TIME_DRIFT_MS);
      const windowEnd = new Date(gameTime.getTime() + MAX_GAME_TIME_DRIFT_MS);
      const existingPicks = await prisma.pick.findMany({
        where: { userId: user.id, capperId: capper.id, homeTeam, awayTeam, gameTime: { gte: windowStart, lte: windowEnd } },
      });

      const duplicate = existingPicks.find((p) => pickCategory(p) === category);
      if (duplicate) {
        const label = duplicate.betDetail || betTypeLabel(duplicate.betType);
        flags[i] = { message: capper.name + " already has a " + label + " pick logged for this game." };
      }
    })
  );

  return flags;
}

export async function bulkImportPicksAction(items: BulkImportItem[]): Promise<BulkImportResult> {
  const user = await requireUser();

  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id } });

  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();
  const errors: string[] = [];
  const unmatchedGames: string[] = [];
  // Every item that resolves cleanly gets queued here, not inserted yet -
  // the pick-limit check has to see the FULL batch size before any row is
  // written, or a Free user at 995 picks importing 20 could see the first 5
  // silently succeed before the 6th trips the limit. Items that fail for
  // unrelated reasons (bad data, no matching game) still go to `errors`
  // individually and are simply never queued - that's a different kind of
  // per-item failure than the billing gate below, which is all-or-nothing
  // across whatever DID resolve.
  const toInsert: PickInsertData[] = [];

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
            customSource: "Catalog import",
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

      const { homeTeam, awayTeam, gameTime, odds, resolvable, matched } = await resolveGameAndOdds(item);
      if (resolvable && !matched) {
        unmatchedGames.push(item.capperName + " - " + item.description);
      }

      toInsert.push({
        capperId,
        sportId,
        homeTeam,
        awayTeam,
        betType: item.betType,
        betDetail: item.description,
        odds,
        line: extractLine(item.betType, item.description),
        period: item.isFirstFive ? "FIRST_HALF" : "FULL_GAME",
        units: item.units,
        gameTime,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(item.capperName + " - " + item.description + ": " + message);
    }
  }

  // The single all-or-nothing billing gate for this whole batch - see
  // createPicksWithEntitlementCheck. Nothing above this point has written a
  // Pick row yet.
  const result = await createPicksWithEntitlementCheck(user.id, toInsert);

  revalidatePath("/picks");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  revalidatePath("/reports");

  if (!result.allowed) {
    return {
      success: true,
      imported: 0,
      skipped: items.length,
      errors,
      unmatchedGames,
      pickLimitBlocked: { message: result.message, remaining: result.remaining },
    };
  }

  return {
    success: true,
    imported: result.created.length,
    skipped: items.length - result.created.length,
    errors,
    unmatchedGames,
  };
}
