"use server";

import { revalidateTag } from "next/cache";
import { requireUser } from "@/server/auth";
import { cacheKeys } from "@/lib/cache-keys";
import { RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { gradeUserPagePicks } from "@/server/data/page-grading";

// On-view grading, called after paint by GradeDuePicks when the page it is on
// loaded a pending pick whose game is over (see lib/gradeable-picks.ts). Runs
// exactly what the /picks and /live/[gameId] renders used to run inline -
// gradeUserPagePicks, with its own demand gate and fleet-wide persist throttle
// - so a caller that invokes this with nothing due still costs one query.
//
// Being an action (not a render) it can do what the inline version could not:
// bust the viewer's cached dashboard aggregates when a status changed, instead
// of leaving them to the 60 s TTL (docs/cache-invalidation-contract.md, P9).
//
// sportKeys comes from the client, so it is only ever used to NARROW the fixed
// list of gradeable sports - an unknown key is dropped, never looked up.
export async function gradeDuePicksAction(sportKeys?: string[]): Promise<{ graded: number }> {
  const user = await requireUser();
  const requested = Array.isArray(sportKeys)
    ? RESOLVABLE_SPORT_KEYS.filter((k) => sportKeys.includes(k))
    : RESOLVABLE_SPORT_KEYS;
  if (requested.length === 0) return { graded: 0 };

  const graded = await gradeUserPagePicks(user.id, requested);
  if (graded > 0) revalidateTag(cacheKeys.dashboard(user.id));
  return { graded };
}
