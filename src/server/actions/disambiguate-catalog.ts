"use server";

import { requireUser } from "@/server/auth";
import {
  runTeamScheduleCheck,
  runTeamWideScheduleCheck,
  runLeagueActivityCheck,
  type ScheduleCheckQuery,
} from "@/server/data/catalog-disambiguation-checks";

export type { ScheduleCheckQuery };

// Session-checked wrappers; the logic and its comments live in
// server/data/catalog-disambiguation-checks.ts.
export async function checkAmbiguousTeamSchedules(queries: ScheduleCheckQuery[]): Promise<Record<string, boolean>> {
  await requireUser();
  return runTeamScheduleCheck(queries);
}

export async function checkAmbiguousTeamWideSchedules(queries: ScheduleCheckQuery[]): Promise<Record<string, boolean>> {
  await requireUser();
  return runTeamWideScheduleCheck(queries);
}

export async function checkAmbiguousLeagueActivity(sports: string[], referenceIso: string): Promise<Record<string, boolean>> {
  await requireUser();
  return runLeagueActivityCheck(sports, referenceIso);
}
