import { type ParsedPick, type AmbiguousOption } from "@/lib/parse-catalog";
import { runAmbiguousHierarchy, type AutoResolveResult } from "@/lib/ambiguous-hierarchy";
import {
  checkAmbiguousTeamSchedules,
  checkAmbiguousTeamWideSchedules,
} from "@/server/actions/disambiguate-catalog";

// Thin server-facing wrapper around the pure decision core in
// ambiguous-hierarchy.ts. The only thing added here is the real
// live-schedule checkers (checkAmbiguousTeamSchedules / -WideSchedules, both
// "use server" actions); all the actual hierarchy logic - memory -> schedule
// (with its wide-schedule tiebreaker) -> season (calendar fallback) -> pick
// context, plus the plausibility floor on every resolution - lives in the
// pure module so it can be tested under tsx with fake checkers. Types are
// re-exported so existing importers keep working unchanged.
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
  });
}
