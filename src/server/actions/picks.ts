"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireUser } from "@/server/auth";
import { createPick, DuplicatePickError, updatePickStatus, deletePick, getCapperLeagueRecords, type CapperLeagueRecords } from "@/server/data/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { cacheKeys } from "@/lib/cache-keys";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { isInvalidOdds } from "@/lib/pick-validation";
import { parseOlderPicksCursor, parseOlderPicksQuery, type OlderPicksCursor } from "@/lib/older-picks";
import { buildOlderLedgerRows, getOlderPicks, reloadOlderLedgerRow } from "@/server/data/picks-older";
import type { LedgerRow } from "@/components/picks/pick-ledger";

// The Dashboard page caches its pick aggregations per user (see
// getDashboardSummary). Any action that changes this user's picks must bust
// it by tag - revalidatePath alone does not reliably evict unstable_cache
// entries.
function revalidatePickStats(userId: string) {
  revalidateTag(cacheKeys.dashboard(userId));
}

// duplicate: the server refused the pick as already logged - the form offers
// "Add anyway", which resubmits with allowDuplicate.
export type ActionResult = { success: true } | { success: false; error: string; duplicate?: true };

export async function createPickAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const capperId = formData.get("capperId") as string;
  const sportId = formData.get("sportId") as string;
  const leagueId = (formData.get("leagueId") as string) || undefined;
  const homeTeam = (formData.get("homeTeam") as string)?.trim();
  const awayTeam = (formData.get("awayTeam") as string)?.trim();
  const betType = formData.get("betType") as BetType;
  const betDetail = (formData.get("betDetail") as string)?.trim() || undefined;
  const oddsRaw = formData.get("odds") as string;
  const lineRaw = (formData.get("line") as string) || "";
  const period = ((formData.get("period") as string) || "FULL_GAME") as Period;
  const unitsRaw = formData.get("units") as string;
  const sportsbook = (formData.get("sportsbook") as string)?.trim() || undefined;
  const gameTimeRaw = formData.get("gameTime") as string;
  const notes = (formData.get("notes") as string)?.trim() || undefined;
  const allowDuplicate = formData.get("allowDuplicate") === "1";

  if (!capperId || !sportId || !homeTeam || !awayTeam || !betType) {
    return { success: false, error: "Please fill in all required fields." };
  }

  const odds = parseInt(oddsRaw, 10);
  const units = parseFloat(unitsRaw);
  const line = lineRaw.trim() ? parseFloat(lineRaw) : null;

  if (isNaN(odds) || isInvalidOdds(odds)) {
    return { success: false, error: "Odds must be a valid number, e.g. -110 or +150." };
  }
  if (isNaN(units) || units <= 0) {
    return { success: false, error: "Units must be a positive number." };
  }
  if (lineRaw.trim() && isNaN(line as number)) {
    return { success: false, error: "Line must be a valid number, e.g. -4.5 or 224.5." };
  }
  if (!gameTimeRaw) {
    return { success: false, error: "Game time is required." };
  }

  try {
    await createPick(user.id, {
      capperId,
      sportId,
      leagueId,
      homeTeam,
      awayTeam,
      betType,
      betDetail,
      odds,
      line,
      period,
      units,
      sportsbook,
      gameTime: new Date(gameTimeRaw),
      notes,
    }, { allowDuplicate });
  } catch (err) {
    if (err instanceof DuplicatePickError) {
      return { success: false, error: err.message, duplicate: true };
    }
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePickStats(user.id);
  revalidatePath("/picks");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  return { success: true };
}

export async function updatePickStatusAction(
  pickId: string,
  status: PickStatus
): Promise<ActionResult> {
  const user = await requireUser();

  try {
    await updatePickStatus(user.id, pickId, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePickStats(user.id);
  revalidatePath("/picks");
  revalidatePath("/picks/pending");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  revalidatePath("/cappers/[capperId]", "page");
  revalidatePath("/live/[gameId]", "page");
  return { success: true };
}

// Permanently deletes one standalone pick. Same cache-invalidation surface as
// updatePickStatusAction - a removed pick changes every aggregate a graded
// one would (dashboard/reports by tag, plus the paths below).
export async function deletePickAction(pickId: string): Promise<ActionResult> {
  const user = await requireUser();

  try {
    await deletePick(user.id, pickId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePickStats(user.id);
  revalidatePath("/picks");
  revalidatePath("/picks/pending");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  revalidatePath("/cappers/[capperId]", "page");
  revalidatePath("/live/[gameId]", "page");
  return { success: true };
}

// Lazy-loaded on demand (a game card expanding on /live), not on page load -
// each entry requires pulling a capper's pick history and recomputing their
// records, which isn't cheap to do for every capper on every game up front.
// getCapperLeagueRecords batches: one query for every capper in the request,
// one computeLeagueRecordCards pass per (capper, league).
//
// `entries` is EVERY pick on the game card, category included when it has one.
// A null-category entry still contributes its capper to the overall-streak
// map (the 🔥/🧊 indicator shows on every pick card, category history or not);
// it just gets no record card.
export async function getLeagueRecordsAction(
  entries: { capperId: string; leagueSport: string; category: PickCategoryKey | null }[]
): Promise<CapperLeagueRecords> {
  const user = await requireUser();
  return getCapperLeagueRecords(user.id, entries);
}

export type OlderPicksResult =
  | {
      success: true;
      rows: LedgerRow[];
      // capperId -> "W-L" for cappers the request didn't list as known.
      capperRecords: Record<string, string>;
      cursor: OlderPicksCursor | null;
      hasMore: boolean;
    }
  | { success: false; error: string };

// "Load older picks" on /picks: one click's worth of picks strictly older than
// the page's window, under the page's filters (server/data/picks-older.ts).
// userId comes from the session only. Every filter is validated here
// (parseOlderPicksQuery: ids by shape, status and bet type by value, the
// window start as a date key); a capper or sport id is only ever a condition
// inside this user's own WHERE, so another user's id matches nothing.
export async function loadOlderPicksAction(query: unknown, cursor: unknown, knownCapperIds: unknown): Promise<OlderPicksResult> {
  const user = await requireUser();
  const q = parseOlderPicksQuery(query);
  const at = parseOlderPicksCursor(cursor);
  const known = Array.isArray(knownCapperIds) ? knownCapperIds.filter((id): id is string => typeof id === "string").slice(0, 500) : [];
  if (!q || at === "invalid") return { success: false, error: "Couldn't load older picks." };
  try {
    const now = new Date();
    const page = await getOlderPicks(user.id, q, at, now);
    const { rows, capperRecords } = await buildOlderLedgerRows(user.id, page.picks, known, now);
    return { success: true, rows, capperRecords, cursor: page.cursor, hasMore: page.hasMore };
  } catch {
    return { success: false, error: "Couldn't load older picks." };
  }
}

// An older row again after its menu changed the result (the page refresh only
// re-renders the first page). null row: the pick is gone.
export async function reloadOlderPickRowAction(
  pickId: string
): Promise<{ success: true; row: LedgerRow | null; capperRecord: string | null } | { success: false; error: string }> {
  const user = await requireUser();
  if (typeof pickId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pickId)) return { success: false, error: "Couldn't reload the pick." };
  try {
    const got = await reloadOlderLedgerRow(user.id, pickId, new Date());
    return { success: true, row: got?.row ?? null, capperRecord: got?.capperRecord ?? null };
  } catch {
    return { success: false, error: "Couldn't reload the pick." };
  }
}
