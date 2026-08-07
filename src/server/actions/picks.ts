"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createPick, updatePickStatus } from "@/server/data/picks";
import type { BetType, PickStatus, Period } from "@prisma/client";

export type ActionResult = { success: true } | { success: false; error: string };

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

  if (!capperId || !sportId || !homeTeam || !awayTeam || !betType) {
    return { success: false, error: "Please fill in all required fields." };
  }

  const odds = parseInt(oddsRaw, 10);
  const units = parseFloat(unitsRaw);
  const line = lineRaw.trim() ? parseFloat(lineRaw) : null;

  if (isNaN(odds) || odds === 0) {
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

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

  revalidatePath("/picks");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");
  revalidatePath("/cappers/[capperId]", "page");
  revalidatePath("/live/[gameId]", "page");
  return { success: true };
}
