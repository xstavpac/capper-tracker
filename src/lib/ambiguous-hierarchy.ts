import {
  type ParsedPick,
  type AmbiguousOption,
  ambiguousOptionsFor,
  matchingSportsForPickContext,
  resolveAmbiguousPick,
} from "@/lib/parse-catalog";
import { isSportLabelInSeason } from "@/lib/sport-seasons";
import { filterPlausibleCandidates } from "@/lib/ambiguous-line-plausibility";

// Pure decision core for the catalog-import ambiguous-nickname hierarchy.
//
// This module deliberately imports ONLY parse-catalog + sport-seasons +
// ambiguous-line-plausibility (all dependency-free of React/Prisma/server
// code) so it can be exercised directly under `tsx` in the acceptance
// tests. The live-schedule lookup is injected as `runScheduleCheck` rather
// than imported, because the real implementation
// (checkAmbiguousTeamSchedules) is a "use server" action that transitively
// pulls React `cache()` and cannot load under tsx. The thin wrapper in
// resolve-ambiguous-catalog.ts supplies the real checker; tests supply a
// fake.
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
//   5. line plausibility - evaluated PER PICK (not per key, since two picks
//                    sharing a bare nickname can have different lines): the
//                    pick's own parsed spread/total is compared against each
//                    remaining candidate's realistic range
//                    (ambiguous-line-plausibility.ts). If that narrows the
//                    field to exactly one candidate, it's cross-checked
//                    against whatever partial (even if individually
//                    inconclusive) evidence steps 2-4 already gathered for
//                    this same key/pick before trusting it alone - see
//                    "cross-check" below. A narrowed-but-still-2+ list is
//                    never auto-resolved; it's surfaced with the implausible
//                    option(s) already dropped.
//   6. still ambiguous - surface for a manual choice
//
// Cross-check (step 5): steps 2-4 only ever fully DECIDE a key when they
// narrow to exactly one candidate on their own - anything less (0, or 2+
// matches) is "inconclusive" today and simply falls through, but the
// specific candidates that a 2+ match DID or DID NOT include is still real,
// checked evidence, not nothing. When line-plausibility narrows a key's
// remaining candidates to exactly one, that partial evidence is consulted
// one more time to classify the relationship as one of three states -
// AGREES (another step's own partial result also included this candidate,
// having excluded at least one other), NO_SIGNAL (no other step produced
// any narrowing at all - inconclusive, not a disagreement), or CONFLICTS
// (another step's own partial result positively excluded this candidate
// while including a different one). Only CONFLICTS blocks the auto-resolve
// - the same "don't trust one signal alone when another actively disagrees,
// but don't manufacture a prompt just because a second signal never fired"
// principle the schedule-check tiebreaker uses elsewhere in this hierarchy.

export type ResolutionMethod = "schedule" | "season" | "pick_context" | "remembered" | "user" | "plausibility";

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
  // Deliberately does NOT include plausibility-only resolutions (step 5):
  // those are decided per PICK from that pick's own line, not per key, so
  // memoizing one onto the whole key would wrongly apply one pick's
  // line-specific reasoning to a different pick sharing the same bare
  // nickname but a different line - exactly the kind of batch-wide
  // over-generalization the pick_context step (a separate, already-known
  // issue) has today.
  decisions: Record<string, AmbiguousOption>;
};

type Decision = { choice: AmbiguousOption; method: ResolutionMethod; reason: string };

// The three cross-check states step 5 classifies another hierarchy step's
// (individually inconclusive) partial evidence into, relative to the one
// candidate line-plausibility narrowed a pick down to.
type SignalRelationship = "AGREES" | "NO_SIGNAL" | "CONFLICTS";

// `survivors` is the subset of `fullOptions` a step's own (possibly
// inconclusive) check left standing - e.g. schedule's withGameToday, or
// season's inSeason. An empty subset, or one that didn't narrow anything at
// all (still equal to the full candidate set), is uninformative on its own
// and classifies as NO_SIGNAL - only a genuine, narrower-than-full subset
// counts as this step having "produced a decision either way".
function relationshipToWinner(
  survivors: AmbiguousOption[] | undefined,
  fullOptions: AmbiguousOption[],
  winner: AmbiguousOption
): SignalRelationship {
  if (!survivors || survivors.length === 0 || survivors.length >= fullOptions.length) return "NO_SIGNAL";
  const includesWinner = survivors.some((o) => o.sport === winner.sport && o.nickname === winner.nickname);
  return includesWinner ? "AGREES" : "CONFLICTS";
}

// Same idea as relationshipToWinner, but for pick_context's raw sport-name
// matches (matchingSportsForPickContext) against the specific candidate
// subset that pick_context itself considered for this pick (which may
// already be season-narrowed - see step 4 below), not necessarily the key's
// full original candidate list.
function contextRelationshipToWinner(
  matchedSports: string[] | undefined,
  consideredSports: string[],
  winnerSport: string
): SignalRelationship {
  if (!matchedSports || matchedSports.length === 0 || matchedSports.length >= consideredSports.length) {
    return "NO_SIGNAL";
  }
  return matchedSports.includes(winnerSport) ? "AGREES" : "CONFLICTS";
}

function overallRelationship(states: SignalRelationship[]): SignalRelationship {
  if (states.includes("CONFLICTS")) return "CONFLICTS";
  if (states.includes("AGREES")) return "AGREES";
  return "NO_SIGNAL";
}

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
  // Every key's own withGameToday subset, captured even when inconclusive
  // (0 or 2+ matches) - step 5's cross-check needs this partial evidence,
  // not just whether it was decisive enough to fully resolve the key.
  const scheduleSignalByKey = new Map<string, AmbiguousOption[]>();
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
      if (!scheduleCheckFailed) scheduleSignalByKey.set(key, withGameToday);
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
  const seasonSignalByKey = new Map<string, AmbiguousOption[]>();
  for (const key of uniqueKeys) {
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport, now));
    seasonSignalByKey.set(key, inSeason);
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
  // Per-pick raw match evidence, captured even when inconclusive - step 5's
  // cross-check needs it. `consideredSports` is the exact candidate subset
  // this pick's own check ran against (season-narrowed when available, same
  // as the decision logic below), since that's what "narrower than the full
  // set" needs to be measured against for this step specifically.
  const contextSignalByPickIdx = new Map<number, { matched: string[]; consideredSports: string[] }>();
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (decided.has(key)) continue;
    const options = ambiguousOptionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport, now));
    const candidates = inSeason.length > 0 ? inSeason : options;
    const consideredSports = candidates.map((o) => o.sport);
    const matched = matchingSportsForPickContext(p.raw, consideredSports);
    contextSignalByPickIdx.set(idx, { matched, consideredSports });
    if (matched.length === 1) {
      const chosen = options.find((o) => o.sport === matched[0])!;
      decided.set(key, {
        choice: chosen,
        method: "pick_context",
        reason: "pick text matched " + matched[0] + "-specific terminology",
      });
    }
  }

  // Apply every KEY-level decision (steps 1-4) to its picks. Step 5 (line
  // plausibility) runs next, per pick, only on whatever's left ambiguous
  // after this.
  for (const { p, idx } of ambiguousEntries) {
    const decision = decided.get(p.ambiguousKey!);
    if (decision) picks[idx] = resolveAmbiguousPick(p, decision.choice);
  }

  // ---- Step 5: line plausibility, evaluated per pick (not per key - see
  // this module's header comment for why). Only considers picks whose key
  // steps 1-4 left undecided.
  const plausibilityLog = new Map<string, { key: string; sport: string; count: number; relationship: SignalRelationship }>();
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (decided.has(key)) continue; // already resolved above

    const options = ambiguousOptionsFor(key);
    const plausible = filterPlausibleCandidates(options, p.ambiguousBetType, p.ambiguousLine);

    if (plausible.length === 0 || plausible.length === options.length) {
      // Nothing to narrow (no line, or every candidate is plausible) -
      // existing fallback: leave the pick exactly as parseCatalog produced
      // it, full candidate list intact.
      continue;
    }

    if (plausible.length >= 2) {
      // Narrowed, but not down to one - never auto-resolve; just drop the
      // implausible option(s) from what gets shown.
      picks[idx] = { ...p, ambiguous: plausible };
      continue;
    }

    // Narrowed to exactly one - cross-check against whatever partial
    // evidence steps 2-4 already gathered for this key/pick before trusting
    // it alone.
    const winner = plausible[0];
    const scheduleState = relationshipToWinner(scheduleSignalByKey.get(key), options, winner);
    const seasonState = relationshipToWinner(seasonSignalByKey.get(key), options, winner);
    const contextSignal = contextSignalByPickIdx.get(idx);
    const contextState = contextSignal
      ? contextRelationshipToWinner(contextSignal.matched, contextSignal.consideredSports, winner.sport)
      : "NO_SIGNAL";
    const relationship = overallRelationship([scheduleState, seasonState, contextState]);

    if (relationship === "CONFLICTS") {
      // Another signal actively disagrees - don't guess between them, show
      // the (single-option) narrowed prompt instead of auto-resolving.
      picks[idx] = { ...p, ambiguous: plausible };
      continue;
    }

    picks[idx] = resolveAmbiguousPick(p, winner);
    const logKey = key + "::" + winner.sport;
    const existing = plausibilityLog.get(logKey);
    if (existing) existing.count += 1;
    else plausibilityLog.set(logKey, { key, sport: winner.sport, count: 1, relationship });
  }

  // One log line per key (not per pick - a Cardinals decision that applied
  // to 12 picks is one log entry with pickCount: 12, not 12 near-identical
  // lines) for steps 1-4's key-level decisions, plus one per (key, sport)
  // pair for step 5's per-pick plausibility resolutions.
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
  for (const { key, sport, count, relationship } of plausibilityLog.values()) {
    const relationshipReason =
      relationship === "AGREES"
        ? "another hierarchy signal independently agreed"
        : "no other hierarchy signal disagreed";
    logs.push({
      ambiguousName: key,
      resolvedSport: sport,
      method: "plausibility",
      reason: sport + " is the only candidate whose line is realistic for that league (" + relationshipReason + ")",
      pickCount: count,
    });
  }
  // eslint-disable-next-line no-console -- deliberate, user-requested audit trail for auto-resolutions
  console.log("[catalog-disambiguation] auto-resolved:", logs);

  // Still ambiguous: a key/pick nothing above resolved, using each pick's
  // own (possibly line-plausibility-narrowed) `ambiguous` list rather than
  // the key's full original candidate list - a pick narrowed to 2 of 3
  // candidates should only ever show those 2. "First pick wins" as the
  // group's representative options, same as sampleRaw already does; picks
  // sharing a key with genuinely different narrowed lists (different lines)
  // are a known display limitation, not attempted here.
  const stillAmbiguous: StillAmbiguousGroup[] = uniqueKeys
    .map((key) => {
      const entries = ambiguousEntries.filter((e) => e.p.ambiguousKey === key && Boolean(picks[e.idx].ambiguous));
      if (entries.length === 0) return null;
      return {
        key,
        options: picks[entries[0].idx].ambiguous!,
        sampleRaw: entries[0].p.raw,
        count: entries.length,
      };
    })
    .filter((g): g is StillAmbiguousGroup => g !== null);

  const decisions: Record<string, AmbiguousOption> = {};
  for (const [key, decision] of decided.entries()) decisions[key] = decision.choice;

  return { picks, logs, stillAmbiguous, decisions };
}
