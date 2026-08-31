"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createParlayBet, updateLegStatus, deleteParlayBet } from "@/server/data/parlays";
import type { BetType, Period, PickStatus } from "@prisma/client";

export type ParlayActionResult = { success: true } | { success: false; error: string };

// Invoked directly with a typed object (not FormData/<form action>) - a
// parlay's leg count is dynamic, and encoding a variable-length array of
// leg objects into FormData's flat key/value shape would need its own
// parsing layer for no real benefit over just passing structured data.
export type LegActionInput = {
  sportId: string;
  leagueId?: string;
  homeTeam: string;
  awayTeam: string;
  betType: BetType;
  betDetail?: string;
  odds: number;
  line: number | null;
  period: Period;
  gameTime: string; // datetime-local string, parsed to Date below
};

export async function createParlayAction(data: {
  capperId: string;
  units: number;
  notes?: string;
  legs: LegActionInput[];
}): Promise<ParlayActionResult> {
  const user = await requireUser();

  if (!data.capperId) {
    return { success: false, error: "Please choose a capper." };
  }
  if (isNaN(data.units) || data.units <= 0) {
    return { success: false, error: "Units must be a positive number." };
  }
  if (!data.legs || data.legs.length < 2) {
    return { success: false, error: "A parlay needs at least 2 legs." };
  }

  for (let i = 0; i < data.legs.length; i++) {
    const leg = data.legs[i];
    if (!leg.sportId || !leg.homeTeam.trim() || !leg.awayTeam.trim()) {
      return { success: false, error: "Leg " + (i + 1) + ": fill in sport, home team, and away team." };
    }
    if (isNaN(leg.odds) || leg.odds === 0) {
      return { success: false, error: "Leg " + (i + 1) + ": odds must be a valid number, e.g. -110 or +150." };
    }
    if (!leg.gameTime) {
      return { success: false, error: "Leg " + (i + 1) + ": game time is required." };
    }
  }

  try {
    await createParlayBet(user.id, {
      capperId: data.capperId,
      units: data.units,
      notes: data.notes,
      legs: data.legs.map((leg) => ({
        sportId: leg.sportId,
        leagueId: leg.leagueId,
        homeTeam: leg.homeTeam.trim(),
        awayTeam: leg.awayTeam.trim(),
        betType: leg.betType,
        betDetail: leg.betDetail?.trim() || undefined,
        odds: leg.odds,
        line: leg.line,
        period: leg.period,
        gameTime: new Date(leg.gameTime),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/picks");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return { success: true };
}

export async function updateLegStatusAction(legId: string, status: PickStatus): Promise<ParlayActionResult> {
  const user = await requireUser();

  try {
    await updateLegStatus(user.id, legId, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/picks");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return { success: true };
}

// Deletes a whole parlay (legs cascade). No revalidateTag for the
// dashboard/reports caches here - those read only Pick rows; the parlay
// numbers on /reports come from getParlayReportsData, which is uncached and
// picked up by the revalidatePath below.
export async function deleteParlayAction(parlayBetId: string): Promise<ParlayActionResult> {
  const user = await requireUser();

  try {
    await deleteParlayBet(user.id, parlayBetId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/picks");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return { success: true };
}
