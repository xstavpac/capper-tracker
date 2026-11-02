"use server";

import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { dismissReviewItem, resolveReviewItem } from "@/server/data/ingest-review";

// The review queue's two answers. The session user is the only identity used: the data layer filters every query by
// (itemId, userId), so another user's item answers "not found" exactly like a missing one.
export type AnswerResult = { ok: true; pickLabel?: string } | { ok: false; message: string };

export async function resolveReviewItemAction(itemId: string, choiceId: string): Promise<AnswerResult> {
  const user = await requireUser();
  if (typeof itemId !== "string" || typeof choiceId !== "string") return { ok: false, message: "Bad request." };
  const res = await resolveReviewItem(user.id, itemId, choiceId);
  if (!res.ok) return { ok: false, message: res.message };
  // The one created pick's label for the confirmation line: one row by primary key.
  const pick = await prisma.pick.findFirst({ where: { id: res.pickId, userId: user.id }, select: { betDetail: true, awayTeam: true, homeTeam: true } });
  return { ok: true, pickLabel: pick ? (pick.betDetail ?? pick.awayTeam + " @ " + pick.homeTeam) : undefined };
}

export async function dismissReviewItemAction(itemId: string): Promise<AnswerResult> {
  const user = await requireUser();
  if (typeof itemId !== "string") return { ok: false, message: "Bad request." };
  const res = await dismissReviewItem(user.id, itemId);
  if (!res.ok) return { ok: false, message: res.error === "not_pending" ? "This item was already answered." : "No such review item." };
  return { ok: true };
}
