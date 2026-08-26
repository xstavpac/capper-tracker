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
  findMarketTotalLine,
  LIVE_SPORTS,
  RESOLVABLE_SPORT_KEYS,
} from "@/server/data/odds";
import { extractLine } from "@/lib/bet-line";
import { NCAAF_CANONICAL_SUFFIX } from "@/lib/parse-catalog";
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
  // Set only once the client has shown the user the auto-filled total line
  // (see previewMissingTotalLines) and they've confirmed it - never set for
  // a TOTAL pick that already has a real, valid number in its own text, and
  // never trusted server-side unless the pick's own text genuinely has no
  // parseable number (see bulkImportPicksAction).
  inferredLine?: number;
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

function lookupGame(liveSportKey: string, nicknames: string[]) {
  if (nicknames.length >= 2) return resolveGameForTeams(liveSportKey, nicknames[0], nicknames[1]);
  if (nicknames.length === 1) return resolveGameForNickname(liveSportKey, nicknames[0]);
  return Promise.resolve(null);
}

// Shared by the real import (bulkImportPicksAction) and the read-only preview
// enrichment (previewBulkImportOdds) below - only attempts resolution for
// sports with a real score source wired up (see RESOLVABLE_SPORT_KEYS),
// otherwise every pick in an unsupported sport would spuriously get flagged
// as unmatched when resolution was never actually possible for it.
//
// IMPORTANT: homeTeam/awayTeam/gameTime below are only ever meaningful when
// `matched` is true. bulkImportPicksAction must not persist a Pick using
// these fields when matched is false - they're return-shape placeholders,
// not usable data (previously this fell back to dumping the raw bet text
// into homeTeam and "-" into awayTeam, which silently created picks that
// could never be graded or re-matched, since the real opponent was never
// captured anywhere on the row - see the Porter PICKS/Cardinals incident).
async function resolveGameAndOdds(item: ResolvableItem): Promise<{
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  odds: number;
  resolvable: boolean; // sport has a real score source wired up at all
  matched: boolean; // and a specific game was actually found in it
  // Which side of homeTeam/awayTeam this pick is actually on, captured once
  // here (see schema.prisma's Pick.pickedSide comment) rather than re-derived
  // from betDetail text at grading time. Deliberately MORE conservative than
  // the odds-lookup `side` below: only set for a single-nickname ML/SPREAD/
  // TEAM_TOTAL pick, and only when exactly one of home/away ends with that
  // nickname - a same-mascot NCAAF matchup (Clemson Tigers @ LSU Tigers)
  // makes both true at once, and there's no way to tell them apart from a
  // bare nickname alone, so this stays null rather than guessing. TEAM_TOTAL
  // needs this exactly as much as ML/SPREAD does - gradePick's TEAM_TOTAL
  // branch reads the SAME pickedHome/pickedAway they do, so without this a
  // team-total pick would only ever get the weaker mascot/school text-match
  // fallback at grading time, never the authoritative side captured here.
  pickedSide: "HOME" | "AWAY" | null;
}> {
  let homeTeam = item.description;
  let awayTeam = "-";
  let gameTime = new Date();
  let odds = item.odds;
  let matched = false;
  let pickedSide: "HOME" | "AWAY" | null = null;

  const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())?.key;
  const resolvable = Boolean(liveSportKey && RESOLVABLE_SPORT_KEYS.includes(liveSportKey));
  if (liveSportKey && resolvable) {
    // NCAAF's parse-catalog nicknames are school names (a PREFIX of the real
    // team name, e.g. "lsu"), not bare mascots (a SUFFIX, e.g. "tigers") the
    // way every other sport's are - translated once here to the canonical
    // "school mascot" suffix (see NCAAF_CANONICAL_SUFFIX's own comment) so
    // every endsWith check below (lookupGame's game-resolution, pickedSide,
    // and the existing odds-lookup side) keeps working unchanged. A no-op
    // for every other sport, and a no-op for any NCAAF nickname that
    // somehow isn't in the table (falls back to itself, same as today -
    // just won't match, which is the existing safe behavior for an
    // unresolvable nickname).
    const nicknames =
      item.sportName.toUpperCase() === "NCAAF"
        ? item.teamNicknames.map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n)
        : item.teamNicknames;
    let game = await lookupGame(liveSportKey, nicknames);
    // One retry before giving up - covers a transient miss/blip against the
    // live schedule source rather than treating it as a genuine non-match.
    if (!game) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      game = await lookupGame(liveSportKey, nicknames);
    }
    if (game) {
      matched = true;
      homeTeam = game.homeTeam;
      awayTeam = game.awayTeam;
      gameTime = new Date(game.commenceTime);

      if (
        (item.betType === "MONEYLINE" || item.betType === "SPREAD" || item.betType === "TEAM_TOTAL") &&
        nicknames.length === 1
      ) {
        const homeMatch = game.homeTeam.toLowerCase().endsWith(nicknames[0]);
        const awayMatch = game.awayTeam.toLowerCase().endsWith(nicknames[0]);
        pickedSide = homeMatch && !awayMatch ? "HOME" : awayMatch && !homeMatch ? "AWAY" : null;
      }

      if (!item.hasExplicitOdds) {
        // Unchanged from before pickedSide existed - always resolves to
        // "home" or "away" for a non-TOTAL bet, same as it always has, for
        // the market-price lookup only. Deliberately NOT reused for
        // pickedSide above: this always picks a side even when ambiguous,
        // which is fine for "which market price to fetch" (worst case, a
        // same-mascot pick's auto-filled odds come from the wrong side's
        // price) but not for the DB field grading depends on to decide
        // WIN/LOSS, which must stay null rather than guess.
        const side =
          item.betType === "TOTAL" || item.betType === "TEAM_TOTAL"
            ? item.totalSide
            : game.homeTeam.toLowerCase().endsWith(nicknames[0])
            ? "home"
            : "away";

        // No real market exists for team totals in this app's cached odds
        // (getOddsForSport only fetches h2h/spreads/totals) - findMarketPrice
        // has no TEAM_TOTAL case and returns null for it, same as it already
        // does for PLAYER_PROP/NRFI, so this is a no-op price lookup rather
        // than a real one; team-total picks keep whatever odds the capper
        // typed (or the -110 default), same as before this bet type existed.
        const marketPrice =
          side && item.betType !== "TEAM_TOTAL" ? await findMarketPrice(liveSportKey, game, item.betType, side) : null;
        if (marketPrice !== null) {
          odds = marketPrice;
        }
      }
    }
  }

  return { homeTeam, awayTeam, gameTime, odds, resolvable, matched, pickedSide };
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

export type MissingTotalLineResult = {
  inferredLine: number;
  reason: "missing" | "garbled"; // no digit anywhere in the text vs. some non-parseable number-ish token
};

// Read-only preview, same shape as previewBulkImportOdds: flags TOTAL picks
// whose raw bet text had no parseable number at all (e.g. "Cubs under a")
// and looks up today's real market total for that specific game, so the UI
// can show it to the user for explicit confirm/reject before import - see
// bulkImportPicksAction, which refuses to persist a TOTAL pick with no
// number unless the client already confirmed an inferredLine for it.
//
// Deliberately never touches a TOTAL pick that already has a real, valid
// number - extractLine returning non-null means the capper specified an
// actual (possibly alternate) line, which must never be overridden.
export async function previewMissingTotalLines(items: ResolvableItem[]): Promise<Record<number, MissingTotalLineResult>> {
  await requireUser();

  const results: Record<number, MissingTotalLineResult> = {};
  await Promise.all(
    items.map(async (item, i) => {
      if (item.betType !== "TOTAL" || !item.totalSide) return;
      if (extractLine("TOTAL", item.description) !== null) return;

      const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())?.key;
      if (!liveSportKey || !RESOLVABLE_SPORT_KEYS.includes(liveSportKey)) return;

      const { matched, homeTeam, awayTeam, gameTime } = await resolveGameAndOdds(item);
      if (!matched) return;

      const point = await findMarketTotalLine(
        liveSportKey,
        { homeTeam, awayTeam, commenceTime: gameTime.toISOString() },
        item.totalSide
      );
      if (point === null) return;

      results[i] = { inferredLine: point, reason: /\d/.test(item.description) ? "garbled" : "missing" };
    })
  );
  return results;
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
      const category = pickCategory({
        betType: item.betType,
        period,
        betDetail: item.description,
        odds,
        line,
        sportName: item.sportName,
      });
      // Can't determine a comparable side for this bet (e.g. a player prop,
      // or a first-half spread) - don't guess at a match either way.
      if (!category) return;

      const windowStart = new Date(gameTime.getTime() - MAX_GAME_TIME_DRIFT_MS);
      const windowEnd = new Date(gameTime.getTime() + MAX_GAME_TIME_DRIFT_MS);
      const existingPicks = await prisma.pick.findMany({
        where: { userId: user.id, capperId: capper.id, homeTeam, awayTeam, gameTime: { gte: windowStart, lte: windowEnd } },
      });

      // existingPicks are matched to this exact game (same homeTeam/awayTeam
      // window as item), so item.sportName is correct for all of them too.
      const duplicate = existingPicks.find((p) => pickCategory({ ...p, sportName: item.sportName }) === category);
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

      const { homeTeam, awayTeam, gameTime, odds, resolvable, matched, pickedSide } = await resolveGameAndOdds(item);
      if (resolvable && !matched) {
        // Don't persist this item at all - homeTeam/awayTeam/gameTime from
        // resolveGameAndOdds are just placeholders when matched is false,
        // and a Pick written with them can never be graded or re-matched
        // later (the real opponent/game time was never actually resolved).
        // Surfacing it in unmatchedGames instead lets the user notice and
        // re-paste/add it correctly rather than it silently going stuck.
        unmatchedGames.push(item.capperName + " - " + item.description);
        continue;
      }

      const extractedLine = extractLine(item.betType, item.description);
      if (item.betType === "TOTAL" && extractedLine === null && item.inferredLine === undefined) {
        // No number anywhere in this pick's own text, and the client never
        // confirmed an auto-filled market line for it (either it bypassed
        // the confirmation step, or the lookup itself found nothing to
        // propose) - refuse to persist an ungradeable TOTAL pick, same
        // principle as the unmatched-game rejection above.
        unmatchedGames.push(item.capperName + " - " + item.description);
        continue;
      }

      toInsert.push({
        capperId,
        sportId,
        homeTeam,
        awayTeam,
        betType: item.betType,
        betDetail: item.description,
        odds,
        line: extractedLine ?? item.inferredLine ?? null,
        period: item.isFirstFive ? "FIRST_HALF" : "FULL_GAME",
        units: item.units,
        gameTime,
        pickedSide,
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
