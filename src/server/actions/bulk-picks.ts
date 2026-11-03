"use server";

import { requireUser } from "@/server/auth";
import {
  importPicksForUser,
  previewBulkImportMatchesCore,
  previewMissingTotalLinesCore,
  checkDuplicatePicksForUser,
  type BulkImportItem,
  type SkippedDuplicateItem,
  type BulkImportResult,
  type ResolvableItem,
  type PreviewMatchedGame,
  type MissingTotalLineResult,
  type DuplicateCheckItem,
  resolveGameAndOdds,
} from "@/server/data/bulk-import-core";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { resolveOrCreateCapperId, resolveOrCreateSportId } from "@/server/data/import-refs";
import { revalidateCapperRoster } from "@/server/data/capper-roster";
import { LIVE_SPORTS, createRequestOddsLoader, findMarketPrice, findMarketSpreadLine, findMarketTotalLine, type OddsLoader } from "@/server/data/odds";
import { extractLine } from "@/lib/bet-line";
import { createParlayBet, type LegCreateInput } from "@/server/data/parlays";
import type { Period } from "@prisma/client";
import type { DuplicateFlag } from "@/lib/duplicate-pick-detection";

export type {
  BulkImportItem,
  SkippedDuplicateItem,
  BulkImportResult,
  PreviewMatchedGame,
  MissingTotalLineResult,
  DuplicateCheckItem,
  DuplicateFlag,
};

export async function previewBulkImportOdds(items: ResolvableItem[]): Promise<Record<number, number>> {
  return (await previewBulkImportMatches(items)).odds;
}

export async function previewBulkImportMatches(
  items: ResolvableItem[]
): Promise<{ odds: Record<number, number>; games: Record<number, PreviewMatchedGame> }> {
  await requireUser();
  return previewBulkImportMatchesCore(items);
}

export async function previewMissingTotalLines(items: ResolvableItem[]): Promise<Record<number, MissingTotalLineResult>> {
  await requireUser();
  return previewMissingTotalLinesCore(items);
}

export async function checkDuplicatePicksAction(items: DuplicateCheckItem[]): Promise<Record<number, DuplicateFlag>> {
  const user = await requireUser();
  return checkDuplicatePicksForUser(user.id, items);
}

export async function bulkImportPicksAction(
  items: BulkImportItem[],
  skippedDuplicates: SkippedDuplicateItem[] = [],
  ambiguity: unknown = []
): Promise<BulkImportResult> {
  const user = await requireUser();
  return importPicksForUser(user.id, items, skippedDuplicates, ambiguity);
}

// ---- MLP (moneyline parlay) import ----
//
// Two independently-resolvable picks coupled into one heads-up bet (e.g.
// "Lions +12.5 + Lions/Bills o47 mlp") - each leg is resolved to a real
// scheduled game exactly the way a normal single pick is (resolveGameAndOdds,
// unchanged), and persisted as a ParlayBet + 2 Legs (see
// server/data/parlays.ts) instead of 2 separate Picks. The parlay's combined
// price is intentionally never stored here - see the Leg model's own comment
// in schema.prisma - it's computed live from surviving (non-PUSH) legs'
// individual Leg.odds at grading/display time.

export type BulkImportParlayLegItem = ResolvableItem & { period: Period };

export type BulkImportParlayItem = {
  capperName: string;
  units: number;
  legs: [BulkImportParlayLegItem, BulkImportParlayLegItem];
};

export type BulkImportParlaysResult =
  | { success: true; imported: number; skipped: number; errors: string[]; unmatchedParlays: string[] }
  | { success: false; error: string };

// The one deliberate divergence from resolveGameAndOdds: for a SPREAD/TOTAL
// leg, the number written next to it in the paste is a leg label pointing at
// a real pick, NOT gradable truth (see ParsedParlay's own comment in
// parse-catalog.ts - a capper's "Lions +12.5" can really mean the live
// "Lions +4.5"). So the persisted `line` for those two bet types always
// comes from today's live market point, via the same findMarketSpreadLine/
// findMarketTotalLine lookups used elsewhere for a missing/garbled number -
// applied here unconditionally, never gated on the text having no number at
// all. `lineUnresolved` tells the caller when that live lookup itself came
// up empty (no market for this exact game/side yet) - the whole parlay must
// be rejected then, never falling back to trusting the leg's own written
// number instead (see the "bad data worse than unresolved" project rule).
//
// MONEYLINE/TEAM_TOTAL/PLAYER_PROP/NRFI legs have no live line to force (a
// TEAM_TOTAL leg has no real market source at all, same limitation as a
// normal single TEAM_TOTAL pick) - line stays null here, and the caller
// falls back to extractLine(betType, description) same as a normal pick.
async function resolveLegAndOdds(item: ResolvableItem, getOdds: OddsLoader): Promise<{
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  odds: number;
  line: number | null;
  resolvable: boolean;
  matched: boolean;
  pickedSide: "HOME" | "AWAY" | "DRAW" | null;
  mlFavoredSide: "HOME" | "AWAY" | null;
  lineUnresolved: boolean;
}> {
  const base = await resolveGameAndOdds(item, getOdds);
  if (!base.matched || (item.betType !== "SPREAD" && item.betType !== "TOTAL")) {
    return { ...base, line: null, lineUnresolved: false };
  }

  const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())!.key;
  const game = { homeTeam: base.homeTeam, awayTeam: base.awayTeam, commenceTime: base.gameTime.toISOString() };

  let line: number | null;
  if (item.betType === "SPREAD") {
    // pickedSide can be null for a same-mascot matchup - same "don't guess"
    // rule resolveGameAndOdds itself already follows; without a determined
    // side there's no live spread line to look up for it.
    const side = base.pickedSide === "HOME" ? "home" : base.pickedSide === "AWAY" ? "away" : null;
    line = side ? await findMarketSpreadLine(liveSportKey, game, side, getOdds) : null;
  } else {
    line = item.totalSide ? await findMarketTotalLine(liveSportKey, game, item.totalSide, getOdds) : null;
  }

  // base.odds was priced against the number in the leg's own text, which here
  // is only a label (see above) - the leg's real line is the live one just
  // looked up, so that is the line its price has to be read at.
  let odds = base.odds;
  if (!item.hasExplicitOdds && line !== null) {
    const side = item.betType === "SPREAD" ? (base.pickedSide === "HOME" ? "home" : "away") : item.totalSide!;
    const price = await findMarketPrice(liveSportKey, game, item.betType, side, { line, period: item.period ?? "UNKNOWN" }, getOdds);
    odds = price ?? item.odds;
  }

  return { ...base, odds, line, lineUnresolved: line === null };
}

export async function bulkImportParlaysAction(items: BulkImportParlayItem[]): Promise<BulkImportParlaysResult> {
  const user = await requireUser();
  const getOdds = createRequestOddsLoader();

  // Only id and name: resolveOrCreateCapperId matches on the name (CapperRef).
  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id }, select: { id: true, name: true } });
  const rosterSizeBefore = existingCappers.length;
  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();
  const errors: string[] = [];
  const unmatchedParlays: string[] = [];
  let imported = 0;

  for (const item of items) {
    try {
      const capperId = await resolveOrCreateCapperId(user.id, item.capperName, existingCappers, capperCache);

      const legsData: LegCreateInput[] = [];
      let rejected = false;

      for (const legItem of item.legs) {
        const resolved = await resolveLegAndOdds(legItem, getOdds);
        if ((resolved.resolvable && !resolved.matched) || resolved.lineUnresolved) {
          rejected = true;
          break;
        }

        const sportId = await resolveOrCreateSportId(legItem.sportName, sportCache);
        // resolved.line only carries a real value when a live lookup was
        // actually attempted (resolved.matched - see resolveLegAndOdds).
        // For a sport with no live score source at all (resolvable: false,
        // never matched, never rejected above), there's nothing to look up
        // against, so this falls back to the leg's own written number, same
        // as a normal single pick in an unresolvable sport already does -
        // never silently drops a real number just because MLP normally
        // distrusts it.
        const line =
          resolved.matched && (legItem.betType === "SPREAD" || legItem.betType === "TOTAL")
            ? resolved.line
            : extractLine(legItem.betType, legItem.description);

        legsData.push({
          sportId,
          homeTeam: resolved.homeTeam,
          awayTeam: resolved.awayTeam,
          betType: legItem.betType,
          betDetail: legItem.description,
          odds: resolved.odds,
          line,
          period: legItem.period,
          gameTime: resolved.gameTime,
        });
      }

      if (rejected || legsData.length !== item.legs.length) {
        unmatchedParlays.push(item.capperName + " - " + item.legs.map((l) => l.description).join(" + "));
        continue;
      }

      await createParlayBet(user.id, { capperId, units: item.units, legs: legsData });
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(item.capperName + ": " + message);
    }
  }

  // Parlays themselves are in no cached read, but this import can create
  // cappers, and the cached roster / cappers bundle carry the capper list.
  // A capper is created before its parlay is validated, so the roster can have grown even when every parlay was
  // rejected: compare the list's size, not the parlays imported.
  revalidateTag(cacheKeys.dashboard(user.id));
  if (existingCappers.length > rosterSizeBefore) revalidateCapperRoster(user.id);
  revalidatePath("/picks");
  revalidatePath("/dashboard");

  return { success: true, imported, skipped: items.length - imported, errors, unmatchedParlays };
}
