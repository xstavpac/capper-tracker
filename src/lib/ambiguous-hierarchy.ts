import {
  type ParsedPick,
  type AmbiguousOption,
  ambiguousOptionsFor,
  inferSportFromPickContext,
  resolveAmbiguousPick,
} from "@/lib/parse-catalog";
import { isSportLabelInSeason } from "@/lib/sport-seasons";
import { extractLine } from "@/lib/bet-line";
import { checkResolutionPlausibility } from "@/lib/disambiguation-plausibility";

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
//   2. schedule    - exactly one candidate has a game today (primary signal),
//                    UNLESS another candidate also has a real game just
//                    outside today's window (see the tiebreaker note on step
//                    2 below) - a daily-cadence league (e.g. WNBA) shouldn't
//                    out-vote a weekly one (e.g. NCAAF) just by playing more
//                    often.
//   3. season      - calendar fallback: exactly one candidate is in season
//                    (used only when the schedule check was inconclusive or
//                    the feed errored out)
//   4. pick_context- pick text matched one candidate's terminology
//   5. still ambiguous - surface for a manual choice
//
// Whatever step decides a key, the decision is also run through a
// plausibility floor (disambiguation-plausibility.ts) before it's actually
// applied to a given pick: if that pick's own bet line is unrealistic for
// the resolved league (a double-digit-plus spread resolved to WNBA), the
// pick is NOT silently finalized - it's left unresolved and falls into
// stillAmbiguous instead, same as if nothing had decided it.

export type ResolutionMethod = "schedule" | "season" | "pick_context" | "remembered" | "user";

export type ScheduleCheckQuery = { nickname: string; sport: string };

// Injected live-schedule lookup. Returns a map keyed `${nickname}|${sport}`
// -> whether that team has a game on the live schedule right now. May reject
// (feed outage / network error) - callers treat a rejection as "schedule
// inconclusive" and fall through to the calendar check.
export type ScheduleChecker = (queries: ScheduleCheckQuery[]) => Promise<Record<string, boolean>>;

export type HierarchyDeps = {
  runScheduleCheck: ScheduleChecker;
  // Tiebreaker for step 2 (schedule check): answers "does this candidate have
  // a real game ANYWHERE on the posted schedule" (not just today/tomorrow),
  // i.e. the same question runScheduleCheck answers but without nearTermOnly.
  // Only ever called for the "losing" candidate(s) of a key that
  // runScheduleCheck already narrowed to exactly one near-term match - if
  // that runner-up also has a real game (just not today), a lone near-term
  // match is no longer decisive on its own, and the key falls through to the
  // season/pick-context steps instead. A checker rejection is treated as
  // "can't confirm the runner-up has anything" - inconclusive, not a
  // reason to block the near-term decision, so it resolves via schedule as
  // it would have before this tiebreaker existed.
  runWideScheduleCheck: ScheduleChecker;
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

    // A lone near-term match per key is only TENTATIVE until the tiebreaker
    // below confirms none of that key's other candidates has a real game
    // just outside the window - collected first, rather than decided
    // immediately, so the tiebreaker's wide check can be batched into one
    // round-trip instead of one per key.
    const tentativeWinners = new Map<string, AmbiguousOption>();
    for (const key of keysNeedingResolution) {
      const options = ambiguousOptionsFor(key);
      const withGameToday = options.filter((o) => scheduleResults[o.nickname + "|" + o.sport]);
      if (withGameToday.length === 1) {
        tentativeWinners.set(key, withGameToday[0]);
      }
      // 0 or 2+ matches - schedule inconclusive, falls through to the
      // calendar step below.
    }

    // Tiebreaker: a lone near-term match doesn't win outright if another
    // candidate for the same key also has a real, scheduled game - just not
    // today/tomorrow. Without this, a daily-cadence league (WNBA) out-votes a
    // weekly one (NCAAF) purely because it happens to play more often, not
    // because the pick's own signal actually points that way. Checked only
    // for the runner-up candidates of keys the near-term check tentatively
    // settled - not a wider window, the same nearTermOnly:false question
    // asked of a narrower set of teams.
    if (tentativeWinners.size > 0) {
      const runnerUpQueries: ScheduleCheckQuery[] = [];
      for (const [key, winner] of tentativeWinners) {
        for (const o of ambiguousOptionsFor(key)) {
          if (o.sport === winner.sport && o.nickname === winner.nickname) continue;
          runnerUpQueries.push({ nickname: o.nickname, sport: o.sport });
        }
      }
      let wideResults: Record<string, boolean> = {};
      try {
        wideResults = runnerUpQueries.length > 0 ? await deps.runWideScheduleCheck(runnerUpQueries) : {};
      } catch (err) {
        // Feed outage on the wide check - can't confirm the runner-up has a
        // real game, so don't block the near-term decision over it.
        // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
        console.log(
          "[catalog-disambiguation] wide schedule tiebreaker check failed, trusting the near-term match:",
          err instanceof Error ? err.message : err
        );
      }

      for (const [key, winner] of tentativeWinners) {
        const runnerUpHasRealGame = ambiguousOptionsFor(key).some(
          (o) => !(o.sport === winner.sport && o.nickname === winner.nickname) && wideResults[o.nickname + "|" + o.sport]
        );
        if (runnerUpHasRealGame) {
          // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
          console.log(
            "[catalog-disambiguation] schedule tiebreaker: runner-up has a real game outside the window, falling through:",
            key
          );
          continue;
        }
        decided.set(key, {
          choice: winner,
          method: "schedule",
          reason: "only " + winner.sport + " has a game scheduled today",
        });
      }
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

  // Apply every decision to its picks - but gated by a plausibility floor
  // (disambiguation-plausibility.ts): a decision resolves the KEY, but each
  // pick sharing that key is checked individually against its own bet line
  // before the resolution actually lands on it. A pick whose line is
  // unrealistic for the resolved league (e.g. a -44 "spread" landing on
  // WNBA) is left unresolved rather than silently finalized - it falls into
  // stillAmbiguous below exactly as if its key had never been decided, even
  // though other picks sharing that same key may resolve normally. This
  // matters regardless of which step produced the decision - a remembered
  // answer from an earlier, differently-lined pick in the same import is no
  // more trustworthy here than a fresh schedule/season/context decision.
  const implausible: { key: string; raw: string; sport: string; reason: string }[] = [];
  for (const { p, idx } of ambiguousEntries) {
    const decision = decided.get(p.ambiguousKey!);
    if (!decision) continue;
    const resolved = resolveAmbiguousPick(p, decision.choice);
    const line = extractLine(resolved.betType, resolved.description);
    const plausibility = checkResolutionPlausibility(resolved.sportName, resolved.betType, line);
    if (!plausibility.plausible) {
      implausible.push({ key: p.ambiguousKey!, raw: p.raw, sport: resolved.sportName, reason: plausibility.reason });
      continue;
    }
    picks[idx] = resolved;
  }
  if (implausible.length > 0) {
    // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
    console.log("[catalog-disambiguation] resolution failed plausibility floor, routed to manual review:", implausible);
  }

  // One log line per key (not per pick - a Cardinals decision that applied
  // to 12 picks is one log entry with pickCount: 12, not 12 near-identical
  // lines), counting only the picks actually resolved - a key every one of
  // whose picks got held back by the plausibility floor above logs nothing,
  // since nothing was actually auto-resolved.
  const logs: ResolutionLog[] = [];
  for (const key of uniqueKeys) {
    const decision = decided.get(key);
    if (!decision) continue;
    const resolvedCount = ambiguousEntries.filter((e) => e.p.ambiguousKey === key && !picks[e.idx].ambiguous).length;
    if (resolvedCount === 0) continue;
    logs.push({
      ambiguousName: key,
      resolvedSport: decision.choice.sport,
      method: decision.method,
      reason: decision.reason,
      pickCount: resolvedCount,
    });
  }
  // eslint-disable-next-line no-console -- deliberate, user-requested audit trail for auto-resolutions
  console.log("[catalog-disambiguation] auto-resolved:", logs);

  // Still ambiguous: a key nothing decided, OR one or more of its individual
  // picks were held back by the plausibility floor above - determined by
  // whether the pick itself still carries `ambiguous` after the apply loop,
  // not by whether its key is in `decided`, so a key can legitimately
  // contribute both a log entry (its plausible picks) and a stillAmbiguous
  // entry (its flagged ones).
  const stillAmbiguous: StillAmbiguousGroup[] = uniqueKeys
    .map((key) => {
      const entries = ambiguousEntries.filter((e) => e.p.ambiguousKey === key && Boolean(picks[e.idx].ambiguous));
      if (entries.length === 0) return null;
      return {
        key,
        options: ambiguousOptionsFor(key),
        sampleRaw: entries[0].p.raw,
        count: entries.length,
      };
    })
    .filter((g): g is StillAmbiguousGroup => g !== null);

  // Same plausibility gate applies to what gets remembered: a decision that
  // never actually resolved any pick (every one of its picks was held back
  // above) isn't carried into the caller's same-import memory either, so a
  // later pick sharing that key still gets a fresh run through the hierarchy
  // instead of inheriting a decision nothing ever confirmed.
  const decisions: Record<string, AmbiguousOption> = {};
  for (const [key, decision] of decided.entries()) {
    const resolvedCount = ambiguousEntries.filter((e) => e.p.ambiguousKey === key && !picks[e.idx].ambiguous).length;
    if (resolvedCount > 0) decisions[key] = decision.choice;
  }

  return { picks, logs, stillAmbiguous, decisions };
}
