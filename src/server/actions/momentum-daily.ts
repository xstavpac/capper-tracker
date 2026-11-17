"use server";

import { requireUser } from "@/server/auth";
import { easternDefaultDayKey } from "@/lib/dates";
import { getMomentumDaily } from "@/server/data/momentum-daily";
import { MOMENTUM_RANGES, type DailyNet, type MomentumRange } from "@/lib/momentum-daily";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];

// Fired only when the viewer taps 7D or 30D (the Today view never calls it): one grouped query,
// at most 30 rows. The window's end is the server's own "today" - a client can't ask for another one.
// userId is the session's, so another user's capper or sport id matches nothing.
// `unique` is the card's Unique Picks mode: each distinct bet counted once (getMomentumDaily explains the rule).
export async function loadMomentumDailyAction(
  range: unknown,
  filters: unknown,
  unique: unknown = false
): Promise<{ success: true; rows: DailyNet[] } | { success: false; error: string }> {
  const user = await requireUser();
  if (typeof range !== "string" || !(MOMENTUM_RANGES as readonly string[]).includes(range)) return { success: false, error: "Couldn't load the range." };
  if (typeof unique !== "boolean") return { success: false, error: "Couldn't load the range." };
  const f: { capperId?: string; sportId?: string; status?: string } = {};
  if (filters && typeof filters === "object") {
    for (const [k, v] of Object.entries(filters as Record<string, unknown>)) {
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string") return { success: false, error: "Couldn't load the range." };
      if ((k === "capperId" || k === "sportId") && ID.test(v)) f[k] = v;
      else if (k === "status" && STATUSES.includes(v)) f.status = v;
      else return { success: false, error: "Couldn't load the range." };
    }
  }
  try {
    const rows = await getMomentumDaily(user.id, range as MomentumRange, easternDefaultDayKey(new Date()), f, { unique });
    return { success: true, rows };
  } catch {
    return { success: false, error: "Couldn't load the range." };
  }
}
