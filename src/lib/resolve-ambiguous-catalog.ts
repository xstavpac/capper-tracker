import {
  type ParsedPick,
  type AmbiguousOption,
  ambiguousOptionsFor,
  inferSportFromPickContext,
  resolveAmbiguousPick,
} from "@/lib/parse-catalog";
import { isSportLabelInSeason } from "@/lib/sport-seasons";
import { checkAmbiguousTeamSchedules } from "@/server/actions/disambiguate-catalog";

export type ResolutionMethod = "season" | "schedule" | "pick_context" | "remembered" | "user";

export type ResolutionLog = {
  ambiguousName: string; // AMBIGUOUS_NICKNAMES key, e.g. "cardinals"
  resolvedSport: string;
  method: ResolutionMethod;
  reason: string;
  pickCount: number; // how many picks in this batch this decision applied to
};

export type StillAmbiguousGroup = {
  key: string;
  options: AmbiguousOption[];
  sampleRaw: string;
  count: number;
};

export type AutoResolveResult = {
  picks: ParsedPick[]; // same array, auto-resolvable entries now resolved
  logs: ResolutionLog[];
  stillAmbiguous: StillAmbiguousGroup[];
  // Every key this pass decided (by any method, including ones carried in
  // via priorChoices) - the caller merges this into its own same-import
  // memory so a re-parse of edited text still honors earlier answers.
  decisions: Record<string, AmbiguousOption>;
};

// Runs the full disambiguation hierarchy (season -> schedule -> pick context
// -> same-import memory) over every ambiguous pick produced by parseCatalog,
// resolving as many as it honestly can without guessing. `priorChoices` is
// the caller's running memory of answers already given earlier in this same
// catalog paste (or an earlier "Drop Catalog" pass on edited text within the
// same import session) - anything in there resolves immediately with no
// re-check, which is what makes "Cardinals = MLB" stick for the rest of the
// import once established, whether that came from a user answer or an
// earlier automatic decision.
export async function autoResolveAmbiguousPicks(
  picks: ParsedPick[],
  priorChoices: Record<string, AmbiguousOption>
): Promise<AutoResolveResult> {
  const ambiguousEntries = picks
    .map((p, idx) => ({ p, idx }))
    .filter((e): e is { p: ParsedPick; idx: number } => Boolean(e.p.ambiguous && e.p.ambiguousKey));

  const uniqueKeys = Array.from(new Set(ambiguousEntries.map((e) => e.p.ambiguousKey!)));
  const countByKey = new Map<string, number>();
  for (const { p } of ambiguousEntries) {
    countByKey.set(p.ambiguousKey!, (countByKey.get(p.ambiguousKey!) ?? 0) + 1);
  }

  type Decision = { choice: AmbiguousOption; method: ResolutionMethod; reason: string };
  const decided = new Map<string, Decision>();

  // Step 4 (memory) - anything already answered earlier in this same import.
  for (const key of uniqueKeys) {
    const remembered = priorChoices[key];
    if (remembered) {
      decided.set(key, { choice: remembered, method: "remembered", reason: "already resolved earlier in this import" });
    }
  }

  // Step 1 - season check.
  const needsScheduleCheck: { key: string; candidates: AmbiguousOption[] }[] = [];
  for (const key of uniqueKeys) {
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport));
    if (inSeason.length === 1) {
      const other = options.find((o) => o.sport !== inSeason[0].sport);
      decided.set(key, {
        choice: inSeason[0],
        method: "season",
        reason: (other?.sport ?? "the other candidate") + " is not currently in season",
      });
    } else if (inSeason.length > 1) {
      needsScheduleCheck.push({ key, candidates: inSeason });
    }
    // inSeason.length === 0 is a config gap, not expected - falls through to context/user below.
  }

  // Step 2 - schedule check, batched into one server round-trip.
  if (needsScheduleCheck.length > 0) {
    const queries = needsScheduleCheck.flatMap(({ candidates }) =>
      candidates.map((c) => ({ nickname: c.nickname, sport: c.sport }))
    );
    const scheduleResults = await checkAmbiguousTeamSchedules(queries);
    for (const { key, candidates } of needsScheduleCheck) {
      const withGameToday = candidates.filter((c) => scheduleResults[c.nickname + "|" + c.sport]);
      if (withGameToday.length === 1) {
        decided.set(key, {
          choice: withGameToday[0],
          method: "schedule",
          reason: "only " + withGameToday[0].sport + " has a game scheduled today",
        });
      }
      // 0 or 2+ matches - schedule inconclusive, falls through to context/user.
    }
  }

  // Step 3 - pick context, evaluated per pick (context is pick-specific) but
  // the first pick to resolve a given key establishes it for the rest, same
  // as a user answer would - see the "remembered" backfill pass below.
  for (const { p } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport));
    const candidates = inSeason.length > 0 ? inSeason : options;
    const contextSport = inferSportFromPickContext(p.raw, candidates.map((o) => o.sport));
    if (contextSport) {
      const chosen = options.find((o) => o.sport === contextSport)!;
      decided.set(key, {
        choice: chosen,
        method: "pick_context",
        reason: "pick text matched " + contextSport + "-specific terminology",
      });
    }
  }

  // Apply every decision to its picks, and build one log line per key
  // (not per pick - a Cardinals decision that applied to 12 picks is one
  // log entry with pickCount: 12, not 12 near-identical lines).
  const logs: ResolutionLog[] = [];
  for (const key of uniqueKeys) {
    const decision = decided.get(key);
    if (!decision) continue;
    logs.push({
      ambiguousName: key,
      resolvedSport: decision.choice.sport,
      method: decision.method,
      reason: decision.reason,
      pickCount: countByKey.get(key) ?? 0,
    });
  }
  // eslint-disable-next-line no-console -- deliberate, user-requested audit trail for auto-resolutions
  console.log("[catalog-disambiguation] auto-resolved:", logs);

  for (const { p, idx } of ambiguousEntries) {
    const decision = decided.get(p.ambiguousKey!);
    if (decision) picks[idx] = resolveAmbiguousPick(p, decision.choice);
  }

  const stillAmbiguous: StillAmbiguousGroup[] = uniqueKeys
    .filter((key) => !decided.has(key))
    .map((key) => {
      const entries = ambiguousEntries.filter((e) => e.p.ambiguousKey === key);
      return { key, options: ambiguousOptionsFor(key), sampleRaw: entries[0].p.raw, count: entries.length };
    });

  const decisions: Record<string, AmbiguousOption> = {};
  for (const [key, decision] of decided.entries()) decisions[key] = decision.choice;

  return { picks, logs, stillAmbiguous, decisions };
}
