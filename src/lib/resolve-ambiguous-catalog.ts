import { type ParsedPick, type AmbiguousOption } from "@/lib/parse-catalog";
import { runAmbiguousHierarchy, type AutoResolveResult } from "@/lib/ambiguous-hierarchy";
import {
  checkAmbiguousTeamSchedules,
  checkAmbiguousTeamWideSchedules,
  checkAmbiguousLeagueActivity,
} from "@/server/actions/disambiguate-catalog";

// Thin server-facing wrapper around the pure decision core in
// ambiguous-hierarchy.ts. The only thing added here is the real
// live-schedule and league-activity checkers ("use server" actions);
// all the actual hierarchy logic - memory -> league activity -> schedule ->
// season (calendar fallback) -> pick context -> line plausibility - lives in
// the pure module so it can be tested under tsx with fake checkers. Types are re-exported so existing importers
// keep working unchanged.
export type {
  ResolutionMethod,
  ResolutionLog,
  StillAmbiguousGroup,
  AutoResolveResult,
} from "@/lib/ambiguous-hierarchy";

export async function autoResolveAmbiguousPicks(
  picks: ParsedPick[],
  priorChoices: Record<string, AmbiguousOption>
): Promise<AutoResolveResult> {
  return runAmbiguousHierarchy(picks, priorChoices, {
    runScheduleCheck: checkAmbiguousTeamSchedules,
    runWideScheduleCheck: checkAmbiguousTeamWideSchedules,
    runLeagueActivityCheck: (sports, referenceDate) => checkAmbiguousLeagueActivity(sports, referenceDate.toISOString()),
  });
}
