import { type ParsedPick, type AmbiguousOption } from "@/lib/parse-catalog";
import { runAmbiguousHierarchy, type AutoResolveResult } from "@/lib/ambiguous-hierarchy";
import { checkAmbiguousTeamSchedules } from "@/server/actions/disambiguate-catalog";

// Thin server-facing wrapper around the pure decision core in
// ambiguous-hierarchy.ts. The only thing added here is the real
// live-schedule checker (checkAmbiguousTeamSchedules, a "use server" action);
// all the actual hierarchy logic - memory -> schedule -> season (calendar
// fallback) -> pick context - lives in the pure module so it can be tested
// under tsx with a fake checker. Types are re-exported so existing importers
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
  });
}
