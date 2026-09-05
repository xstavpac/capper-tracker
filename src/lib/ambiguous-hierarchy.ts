import {
  type ParsedPick,
  type AmbiguousOption,
  ambiguousOptionsFor,
  inferSportFromPickContext,
  resolveAmbiguousPick,
} from "@/lib/parse-catalog";
import { isSportLabelInSeason } from "@/lib/sport-seasons";

// Pure decision core for the catalog-import ambiguous-nickname hierarchy.
//
// This module deliberately imports ONLY parse-catalog + sport-seasons (both
// dependency-free of React/Prisma/server code) so it can be exercised
// directly under `tsx` in the acceptance tests. The live-schedule lookup is
// injected as `runScheduleCheck` rather than imported, because the real
// implementation (checkAmbiguousTeamSchedules) is a "use server" action that
// transitively pulls React `cache()` and cannot load under tsx. The thin
// wrapper in resolve-ambiguous-catalog.ts supplies the real checker; tests
// supply a fake.
//
// Ordering (changed 2026-09 from season-first to schedule-first): a live
// game today is a far stronger signal than a static calendar window, and the
// two seasons that motivated this - WNBA and NCAAF both list a "Liberty" -
// overlap for ~5 months every year, so the calendar can't tell them apart at
// all during that window. The hierarchy is now:
//   1. memory      - already answered earlier in this same import
//   2. schedule    - exactly one candidate has a game today (primary signal)
//   3. season      - calendar fallback: exactly one candidate is in season
//                    (used only when the schedule check was inconclusive or
//                    the feed errored out)
//   4. pick_context- pick text matched one candidate's terminology
//   5. still ambiguous - surface for a manual choice

export type ResolutionMethod = "schedule" | "season" | "pick_context" | "remembered" | "user";

export type ScheduleCheckQuery = { nickname: string; sport: string };

// Injected live-schedule lookup. Returns a map keyed `${nickname}|${sport}`
// -> whether that team has a game on the live schedule right now. May reject
// (feed outage / network error) - callers treat a rejection as "schedule
// inconclusive" and fall through to the calendar check.
export type ScheduleChecker = (queries: ScheduleCheckQuery[]) => Promise<Record<string, boolean>>;

export type HierarchyDeps = {
  runScheduleCheck: ScheduleChecker;
  // Overridable reference date for the season (calendar) fallback - defaults
  // to now. Tests pin it so the calendar-fallback path is deterministic.
  now?: Date;
};

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

type Decision = { choice: AmbiguousOption; method: ResolutionMethod; reason: string };

// Runs the full disambiguation hierarchy over every ambiguous pick produced
// by parseCatalog, resolving as many as it honestly can without guessing.
// `priorChoices` is the caller's running memory of answers already given
// earlier in this same catalog paste (or an earlier "Drop Catalog" pass on
// edited text within the same import session) - anything in there resolves
// immediately with no re-check, which is what makes "Cardinals = MLB" stick
// for the rest of the import once established, whether that came from a user
// answer or an earlier automatic decision.
export async function runAmbiguousHierarchy(
  picks: ParsedPick[],
  priorChoices: Record<string, AmbiguousOption>,
  deps: HierarchyDeps
): Promise<AutoResolveResult> {
  const now = deps.now ?? new Date();

  const ambiguousEntries = picks
    .map((p, idx) => ({ p, idx }))
    .filter((e): e is { p: ParsedPick; idx: number } => Boolean(e.p.ambiguous && e.p.ambiguousKey));

  const uniqueKeys = Array.from(new Set(ambiguousEntries.map((e) => e.p.ambiguousKey!)));
  const countByKey = new Map<string, number>();
  for (const { p } of ambiguousEntries) {
    countByKey.set(p.ambiguousKey!, (countByKey.get(p.ambiguousKey!) ?? 0) + 1);
  }

  const decided = new Map<string, Decision>();

  // ---- Step 1: memory - anything already answered earlier in this import.
  for (const key of uniqueKeys) {
    const remembered = priorChoices[key];
    if (remembered) {
      decided.set(key, {
        choice: remembered,
        method: "remembered",
        reason: "already resolved earlier in this import",
      });
    }
  }

  // ---- Step 2: schedule check (primary signal), batched into one round-trip.
  // Every candidate of every still-undecided key is checked - not just the
  // in-season ones - because a live game today outranks the calendar
  // outright (the whole point of schedule-first). A checker rejection means
  // the feed is unavailable: `scheduleResults` stays empty and every key
  // falls through to the calendar step, exactly as if the check had come
  // back inconclusive.
  const keysNeedingResolution = uniqueKeys.filter((key) => !decided.has(key));
  let scheduleResults: Record<string, boolean> = {};
  let scheduleCheckFailed = false;
  if (keysNeedingResolution.length > 0) {
    const queries = keysNeedingResolution.flatMap((key) =>
      ambiguousOptionsFor(key).map((o) => ({ nickname: o.nickname, sport: o.sport }))
    );
    try {
      scheduleResults = await deps.runScheduleCheck(queries);
    } catch (err) {
      scheduleCheckFailed = true;
      // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
      console.log(
        "[catalog-disambiguation] schedule check failed, falling back to calendar:",
        err instanceof Error ? err.message : err
      );
    }

    for (const key of keysNeedingResolution) {
      const options = ambiguousOptionsFor(key);
      const withGameToday = options.filter((o) => scheduleResults[o.nickname + "|" + o.sport]);
      if (withGameToday.length === 1) {
        decided.set(key, {
          choice: withGameToday[0],
          method: "schedule",
          reason: "only " + withGameToday[0].sport + " has a game scheduled today",
        });
      }
      // 0 or 2+ matches - schedule inconclusive, falls through to the
      // calendar step below.
    }
  }

  // ---- Step 3: season (calendar) fallback - only for keys the schedule
  // check could not settle. Resolves only when exactly one candidate is in
  // its calendar season window right now.
  for (const key of uniqueKeys) {
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport, now));
    if (inSeason.length === 1) {
      const other = options.find((o) => o.sport !== inSeason[0].sport);
      const suffix = scheduleCheckFailed
        ? " (schedule feed unavailable, used calendar)"
        : "";
      decided.set(key, {
        choice: inSeason[0],
        method: "season",
        reason: (other?.sport ?? "the other candidate") + " is not currently in season" + suffix,
      });
    }
    // inSeason.length !== 1 - falls through to pick context / user.
  }

  // ---- Step 4: pick context, evaluated per pick (context is pick-specific)
  // but the first pick to resolve a given key establishes it for the rest,
  // same as a user answer would.
  for (const { p } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport, now));
    const candidates = inSeason.length > 0 ? inSeason : options;
    const contextSport = inferSportFromPickContext(
      p.raw,
      candidates.map((o) => o.sport)
    );
    if (contextSport) {
      const chosen = options.find((o) => o.sport === contextSport)!;
      decided.set(key, {
        choice: chosen,
        method: "pick_context",
        reason: "pick text matched " + contextSport + "-specific terminology",
      });
    }
  }

  // Apply every decision to its picks, and build one log line per key (not
  // per pick - a Cardinals decision that applied to 12 picks is one log
  // entry with pickCount: 12, not 12 near-identical lines).
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
      return {
        key,
        options: ambiguousOptionsFor(key),
        sampleRaw: entries[0].p.raw,
        count: entries.length,
      };
    });

  const decisions: Record<string, AmbiguousOption> = {};
  for (const [key, decision] of decided.entries()) decisions[key] = decision.choice;

  return { picks, logs, stillAmbiguous, decisions };
}
