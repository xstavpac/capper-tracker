"use server";

import { requireUser } from "@/server/auth";
import {
  runTeamScheduleCheck,
  runTeamWideScheduleCheck,
  runLeagueActivityCheck,
  runCollegeLineCheck,
  runCapperLeagueHistory,
  type ScheduleCheckQuery,
} from "@/server/data/catalog-disambiguation-checks";

import type { CapperLeagueHistory, CollegeLineQuery, PostedLinesByTeam } from "@/lib/college-line-signal";

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

export async function checkCollegePostedLines(queries: CollegeLineQuery[]): Promise<PostedLinesByTeam> {
  await requireUser();
  return runCollegeLineCheck(queries);
}

export async function getCapperCollegeHistory(capperNames: string[]): Promise<CapperLeagueHistory> {
  const user = await requireUser();
  return runCapperLeagueHistory(user.id, capperNames);
}
