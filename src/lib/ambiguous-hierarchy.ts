import {
  type ParsedPick,
  type AmbiguousOption,
  ambiguousOptionsFor,
  isPlayerAmbiguityKey,
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
//   1b. league activity - a candidate whose league has no game on the feeds
//                    within LEAGUE_ACTIVITY_WINDOW_DAYS of the import is
//                    dropped before anything else looks at it. Not a
//                    signal to weigh: it removes an impossible option, for
//                    every bet type (it is the only filter a moneyline
//                    gets), and every later step works from what is left.
//                    One candidate left resolves the key. Skipped entirely
//                    when the lookup fails or finds no active league.
//   2. schedule   - exactly one candidate has a game today (primary signal)
//   3. season      - calendar fallback: exactly one candidate is in season
//                    (used only when the schedule check was inconclusive or
//                    the feed errored out)
//   4. pick_context- pick text matched one candidate's terminology. Scoped
//                    to the CAPPER whose own pick produced the match: the
//                    first pick from that capper to conclusively match
//                    establishes it for the rest of that same capper's picks
//                    sharing the key (the "Cardinals sticks as MLB for the
//                    rest of this capper's picks" convenience), but never
//                    carries over to a different capper's pick sharing the
//                    same bare nickname with no context signal of its own -
//                    see "pick_context scoping" below.
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
//                    never resolved on the line alone: the schedule question
//                    is asked again of just the survivors ("Giants over 8.5"
//                    drops NFL; of MLB and KBO only the MLB Giants play
//                    today), and it resolves only if exactly one of them has
//                    a game today, none of the others has one later on the
//                    posted schedule, and season / pick context don't
//                    disagree. Otherwise it's surfaced with the implausible
//                    option(s) already dropped.
//   6. still ambiguous - surface for a manual choice
//
// pick_context scoping (step 4, fixed 2026-09): pick text is specific to the
// pick that produced it, not to every pick sharing a bare nickname across the
// whole batch. Before this fix, one capper's football-specific pick (e.g.
// "Giants touchdown scorer Barkley") could establish an NFL resolution for
// the "giants" key that then silently applied to a completely unrelated
// capper's plain "Giants Moneyline" pick with zero football signal of its
// own - confirmed directly by running a two-capper batch through this
// module. The fix scopes each pick_context decision to `${key}::${capperName}`
// instead of just `${key}`: it still lets one capper's later, contextless
// mentions of the same nickname inherit that capper's own earlier
// established meaning (same convenience the "first pick establishes it"
// comment above describes, and the same one the "Cardinals" case relies on -
// no existing behavior depended on anything narrower, like paste-block
// adjacency, since a capper's picks were never previously scoped at all), but
// a different capper's pick with no context signal of its own now correctly
// falls through to plausibility (step 5) or the manual prompt instead of
// silently inheriting a decision that was never actually about it.
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

export type ResolutionMethod =
  | "schedule"
  | "season"
  | "pick_context"
  | "remembered"
  | "user"
  | "plausibility"
  | "league_activity";

// How far either side of the import a league's nearest game may be for the
// league to still count as a candidate.
export const LEAGUE_ACTIVITY_WINDOW_DAYS = 7;

// Injected feed lookup for step 1b. Given candidate sport labels, returns
// label -> whether that league has a game within LEAGUE_ACTIVITY_WINDOW_DAYS
// of `referenceDate`. A label left OUT of the result means "couldn't tell"
// (no feed for that league, or its read failed) and is never dropped. May
// reject - the whole step is then skipped.
export type LeagueActivityChecker = (sports: string[], referenceDate: Date) => Promise<Record<string, boolean>>;

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
  // i.e. runScheduleCheck's question without nearTermOnly. Only ever called
  // for the runner-up candidate(s) of a key runScheduleCheck already narrowed
  // to exactly one near-term match - if a runner-up also has a real game
  // (just not today), a lone near-term match is no longer decisive on its
  // own and the key falls through to the season/pick-context/plausibility
  // steps instead (the Indiana Fever vs Hoosiers case: a daily-cadence
  // league must not out-vote a weekly one just by playing more often). A
  // checker rejection is "can't confirm the runner-up has anything" -
  // inconclusive, so the near-term decision stands as it did before this
  // tiebreaker existed.
  runWideScheduleCheck: ScheduleChecker;
  // Step 1b's feed lookup. Optional: without it no candidate is ever dropped
  // for league inactivity, exactly as before the step existed.
  runLeagueActivityCheck?: LeagueActivityChecker;
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
  // Deliberately does NOT include plausibility-only resolutions (step 5) or
  // pick_context resolutions (step 4): both are decided per PICK (line
  // plausibility from that pick's own line; pick_context scoped to that
  // pick's own capper - see "pick_context scoping" above), not per key, so
  // memoizing either onto the whole key would wrongly carry one pick's (or
  // one capper's) pick-specific reasoning over to a different pick/capper
  // sharing the same bare nickname with no such signal of its own - including
  // on a later re-parse of edited text within the same import, since this
  // record is exactly what step 1 (memory) applies unconditionally next time.
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

  // A key's candidates: the static table's, or - for a key built from the
  // game feed (a mascot two feed teams share, see parseCatalog) - the list
  // the pick itself carries. Step 1b narrows an entry; every later step
  // reads the narrowed list.
  const baseOptionsByKey = new Map<string, AmbiguousOption[]>();
  for (const { p } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (baseOptionsByKey.has(key)) continue;
    const listed = ambiguousOptionsFor(key);
    baseOptionsByKey.set(key, listed.length > 0 ? listed : p.ambiguous!);
  }
  const optionsByKey = new Map(baseOptionsByKey);
  const optionsFor = (key: string): AmbiguousOption[] => optionsByKey.get(key) ?? [];

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

  // ---- Step 1b: league activity. One lookup for every candidate league of
  // every undecided key. Nothing is dropped unless the lookup answered AND
  // found at least one active league - a failed or empty lookup must never
  // cost a pick its options - and a key is never left with no candidate.
  // Team keys only: a shared-surname player key stops at step 1 (see step 2).
  const undecidedKeys = uniqueKeys.filter((key) => !decided.has(key) && !isPlayerAmbiguityKey(key));
  if (deps.runLeagueActivityCheck && undecidedKeys.length > 0) {
    const sports = Array.from(new Set(undecidedKeys.flatMap((key) => optionsFor(key).map((o) => o.sport))));
    let activity: Record<string, boolean> = {};
    try {
      activity = await deps.runLeagueActivityCheck(sports, now);
    } catch (err) {
      // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
      console.log(
        "[catalog-disambiguation] league activity check failed, keeping every candidate:",
        err instanceof Error ? err.message : err
      );
    }
    if (Object.values(activity).some(Boolean)) {
      for (const key of undecidedKeys) {
        const options = optionsFor(key);
        const active = options.filter((o) => activity[o.sport] !== false);
        if (active.length === 0 || active.length === options.length) continue;
        optionsByKey.set(key, active);
        const dropped = Array.from(new Set(options.filter((o) => !active.includes(o)).map((o) => o.sport)));
        // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
        console.log("[catalog-disambiguation] dropped leagues with no games within the window:", key, dropped);
        for (const { p, idx } of ambiguousEntries) {
          if (p.ambiguousKey === key) picks[idx] = { ...picks[idx], ambiguous: active };
        }
        // One candidate left resolves the key - but only on a league the
        // lookup positively saw games for. A lone survivor the lookup
        // couldn't speak to (KBO, CFL: no feed) is left to the steps below.
        if (active.length === 1 && activity[active[0].sport] === true) {
          decided.set(key, {
            choice: active[0],
            method: "league_activity",
            reason:
              active[0].sport +
              " is the only candidate league with a game within " +
              LEAGUE_ACTIVITY_WINDOW_DAYS +
              " days (none for " +
              dropped.join(", ") +
              ")",
          });
        }
      }
    }
  }

  // ---- Step 2: schedule check (primary signal), batched into one round-trip.
  // Every candidate of every still-undecided key is checked - not just the
  // in-season ones - because a live game today outranks the calendar
  // outright (the whole point of schedule-first). A checker rejection means
  // the feed is unavailable: `scheduleResults` stays empty and every key
  // falls through to the calendar step, exactly as if the check had come
  // back inconclusive.
  //
  // A shared-surname player key (isPlayerAmbiguityKey) stops at step 1: only
  // the user's own answer may choose between two real players. Steps 2-5 are
  // all about telling leagues apart and have nothing to say about it - both
  // McCaffreys having a game today is exactly why the question was asked.
  const teamKeys = uniqueKeys.filter((key) => !isPlayerAmbiguityKey(key));
  const keysNeedingResolution = teamKeys.filter((key) => !decided.has(key));
  let scheduleResults: Record<string, boolean> = {};
  let scheduleCheckFailed = false;
  // Every key's own withGameToday subset, captured even when inconclusive
  // (0 or 2+ matches) - step 5's cross-check needs this partial evidence,
  // not just whether it was decisive enough to fully resolve the key.
  const scheduleSignalByKey = new Map<string, AmbiguousOption[]>();
  if (keysNeedingResolution.length > 0) {
    const queries = keysNeedingResolution.flatMap((key) =>
      optionsFor(key).map((o) => ({ nickname: o.nickname, sport: o.sport }))
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
    // below confirms none of that key's other candidates has a real game just
    // outside the window - collected first so the wide check batches into one
    // round-trip instead of one per key.
    const tentativeWinners = new Map<string, AmbiguousOption>();
    for (const key of keysNeedingResolution) {
      const options = optionsFor(key);
      const withGameToday = options.filter((o) => scheduleResults[o.nickname + "|" + o.sport]);
      if (!scheduleCheckFailed) scheduleSignalByKey.set(key, withGameToday);
      if (withGameToday.length === 1) tentativeWinners.set(key, withGameToday[0]);
      // 0 or 2+ matches - schedule inconclusive, falls through to the
      // calendar step below.
    }

    if (tentativeWinners.size > 0) {
      const runnerUpQueries: ScheduleCheckQuery[] = [];
      for (const [key, winner] of tentativeWinners) {
        for (const o of optionsFor(key)) {
          if (o.sport === winner.sport && o.nickname === winner.nickname) continue;
          runnerUpQueries.push({ nickname: o.nickname, sport: o.sport });
        }
      }
      let wideResults: Record<string, boolean> = {};
      try {
        wideResults = runnerUpQueries.length > 0 ? await deps.runWideScheduleCheck(runnerUpQueries) : {};
      } catch (err) {
        // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
        console.log(
          "[catalog-disambiguation] wide schedule tiebreaker check failed, trusting the near-term match:",
          err instanceof Error ? err.message : err
        );
      }

      for (const [key, winner] of tentativeWinners) {
        const runnerUpHasRealGame = optionsFor(key).some(
          (o) => !(o.sport === winner.sport && o.nickname === winner.nickname) && wideResults[o.nickname + "|" + o.sport]
        );
        if (runnerUpHasRealGame) {
          // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
          console.log(
            "[catalog-disambiguation] schedule tiebreaker: runner-up has a real game outside the window, falling through:",
            key
          );
          continue; // scheduleSignalByKey keeps the near-term subset for step 5's cross-check
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
  const seasonSignalByKey = new Map<string, AmbiguousOption[]>();
  for (const key of teamKeys) {
    if (decided.has(key)) continue;
    const options = optionsFor(key);
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
  // and scoped to `${key}::${capperName}` - the first pick FROM THAT CAPPER
  // to conclusively match establishes it for the rest of that capper's picks
  // sharing the key, same as a user answer would, but never for a different
  // capper's pick sharing the same key (see "pick_context scoping" in this
  // module's header comment).
  // Per-pick raw match evidence, captured even when inconclusive - step 5's
  // cross-check needs it. `consideredSports` is the exact candidate subset
  // this pick's own check ran against (season-narrowed when available, same
  // as the decision logic below), since that's what "narrower than the full
  // set" needs to be measured against for this step specifically.
  const contextSignalByPickIdx = new Map<number, { matched: string[]; consideredSports: string[] }>();
  const contextDecided = new Map<string, Decision>(); // keyed by `${ambiguousKey}::${capperName}`
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (decided.has(key) || isPlayerAmbiguityKey(key)) continue;
    const scopeKey = key + "::" + p.capperName;
    if (contextDecided.has(scopeKey)) continue; // this capper's key already established by an earlier pick of theirs
    const options = optionsFor(key);
    const inSeason = options.filter((o) => isSportLabelInSeason(o.sport, now));
    const candidates = inSeason.length > 0 ? inSeason : options;
    const consideredSports = candidates.map((o) => o.sport);
    const matched = matchingSportsForPickContext(p.raw, consideredSports);
    contextSignalByPickIdx.set(idx, { matched, consideredSports });
    if (matched.length === 1) {
      const chosen = options.find((o) => o.sport === matched[0])!;
      contextDecided.set(scopeKey, {
        choice: chosen,
        method: "pick_context",
        reason: "pick text matched " + matched[0] + "-specific terminology",
      });
    }
  }

  // Apply every decision - steps 1-3's KEY-level decisions to every pick
  // sharing that key, step 4's pick_context decisions only to picks from the
  // same capper that earned them. Step 5 (line plausibility) runs next, per
  // pick, only on whatever's left ambiguous after this.
  //
  // Plausibility also gates SCHEDULE-based decisions (near-term or
  // tiebreaker): a key-level schedule decision is applied per pick, and a
  // pick whose own line is unrealistic for the chosen league (Fever-only
  // schedule + "Indiana -44") is NOT auto-resolved by it - it's left
  // ambiguous and falls to step 5 below, where that same bound has already
  // removed the implausible candidate from its candidate list. Only the
  // "schedule" method is gated, plus step 1b's "league_activity" (the one
  // league left can still be the wrong one for this pick's line): remembered
  // answers (which include user answers) and season/pick_context decisions
  // always apply as before.
  const appliedCountByKey = new Map<string, number>();
  const contextLog = new Map<string, { key: string; sport: string; count: number }>();
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    const globalDecision = decided.get(key);
    if (globalDecision) {
      if (
        (globalDecision.method === "schedule" || globalDecision.method === "league_activity") &&
        filterPlausibleCandidates([globalDecision.choice], p.ambiguousBetType, p.ambiguousLine, p.ambiguousPartialGame)
          .length === 0
      ) {
        // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
        console.log(
          "[catalog-disambiguation] " + globalDecision.method + " decision rejected by line plausibility, falling through:",
          key,
          globalDecision.choice.sport,
          p.ambiguousLine
        );
        continue;
      }
      picks[idx] = resolveAmbiguousPick(p, globalDecision.choice);
      appliedCountByKey.set(key, (appliedCountByKey.get(key) ?? 0) + 1);
      continue;
    }
    const contextDecision = contextDecided.get(key + "::" + p.capperName);
    if (contextDecision) {
      picks[idx] = resolveAmbiguousPick(p, contextDecision.choice);
      const logKey = key + "::" + contextDecision.choice.sport;
      const existing = contextLog.get(logKey);
      if (existing) existing.count += 1;
      else contextLog.set(logKey, { key, sport: contextDecision.choice.sport, count: 1 });
    }
  }

  // ---- Step 5: line plausibility, evaluated per pick (not per key - see
  // this module's header comment for why). Only considers picks steps 1-4
  // left undecided - checked via `picks[idx].ambiguous` rather than
  // `decided.has(key)` because step 4's pick_context decisions are no longer
  // key-level (they're `${key}::${capperName}`-scoped), so a pick can be
  // resolved by step 4 without its bare key ever landing in `decided`.
  //
  // Pre-pass: a line that drops some candidates but leaves 2+ ("Giants over
  // 8.5" drops NFL, leaving MLB and KBO) gets the schedule question asked
  // again of the survivors only - step 2 called it inconclusive because the
  // dropped league was playing too. A lone survivor with a game today is
  // tentative until the same wide tiebreaker step 2 uses clears the other
  // survivors, batched here into one round-trip.
  const playingSurvivorByPickIdx = new Map<number, AmbiguousOption>();
  const survivorRunnerUpQueries: ScheduleCheckQuery[] = [];
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (!picks[idx].ambiguous || isPlayerAmbiguityKey(key) || scheduleCheckFailed) continue;
    const options = optionsFor(key);
    const plausible = filterPlausibleCandidates(options, p.ambiguousBetType, p.ambiguousLine, p.ambiguousPartialGame);
    if (plausible.length < 2 || plausible.length === options.length) continue;
    const playing = plausible.filter((o) => scheduleResults[o.nickname + "|" + o.sport]);
    if (playing.length !== 1) continue;
    playingSurvivorByPickIdx.set(idx, playing[0]);
    for (const o of plausible) {
      if (o !== playing[0]) survivorRunnerUpQueries.push({ nickname: o.nickname, sport: o.sport });
    }
  }
  let survivorWideResults: Record<string, boolean> = {};
  if (survivorRunnerUpQueries.length > 0) {
    try {
      survivorWideResults = await deps.runWideScheduleCheck(survivorRunnerUpQueries);
    } catch (err) {
      // eslint-disable-next-line no-console -- deliberate, user-requested audit trail
      console.log(
        "[catalog-disambiguation] wide schedule tiebreaker check failed, trusting the near-term match:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const plausibilityLog = new Map<
    string,
    { key: string; sport: string; count: number; relationship: SignalRelationship; viaSchedule: boolean }
  >();
  for (const { p, idx } of ambiguousEntries) {
    const key = p.ambiguousKey!;
    if (!picks[idx].ambiguous) continue; // already resolved above
    if (isPlayerAmbiguityKey(key)) continue;

    const options = optionsFor(key);
    const plausible = filterPlausibleCandidates(options, p.ambiguousBetType, p.ambiguousLine, p.ambiguousPartialGame);
    const seasonAndContext = (winner: AmbiguousOption): SignalRelationship[] => {
      const contextSignal = contextSignalByPickIdx.get(idx);
      return [
        relationshipToWinner(seasonSignalByKey.get(key), options, winner),
        contextSignal
          ? contextRelationshipToWinner(contextSignal.matched, contextSignal.consideredSports, winner.sport)
          : "NO_SIGNAL",
      ];
    };

    if (plausible.length === 0) {
      // The line fits none of the candidates left - nothing here is
      // trustworthy enough to hide an option on, step 1b's narrowing
      // included, so the pick goes back to its full candidate list.
      picks[idx] = { ...p, ambiguous: baseOptionsByKey.get(key) ?? options };
      continue;
    }
    if (plausible.length === options.length) {
      // Nothing to narrow (no line, or every candidate is plausible) - the
      // pick keeps the candidate list it already has.
      continue;
    }

    if (plausible.length >= 2) {
      // Narrowed, but not down to one. The line alone never picks between
      // the survivors; it resolves only when exactly one of them has a game
      // today (see the pre-pass above), no other survivor has a real game
      // just outside the window, and season / pick context don't disagree.
      // Otherwise just drop the implausible option(s) from what gets shown.
      const playing = playingSurvivorByPickIdx.get(idx);
      const runnerUpHasRealGame = plausible.some((o) => o !== playing && survivorWideResults[o.nickname + "|" + o.sport]);
      if (playing && !runnerUpHasRealGame && !seasonAndContext(playing).includes("CONFLICTS")) {
        picks[idx] = resolveAmbiguousPick(p, playing);
        const logKey = key + "::" + playing.sport + "::schedule";
        const existing = plausibilityLog.get(logKey);
        if (existing) existing.count += 1;
        else plausibilityLog.set(logKey, { key, sport: playing.sport, count: 1, relationship: "AGREES", viaSchedule: true });
        continue;
      }
      picks[idx] = { ...p, ambiguous: plausible };
      continue;
    }

    // Narrowed to exactly one - cross-check against whatever partial
    // evidence steps 2-4 already gathered for this key/pick before trusting
    // it alone.
    const winner = plausible[0];
    const scheduleState = relationshipToWinner(scheduleSignalByKey.get(key), options, winner);
    const relationship = overallRelationship([scheduleState, ...seasonAndContext(winner)]);

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
    else plausibilityLog.set(logKey, { key, sport: winner.sport, count: 1, relationship, viaSchedule: false });
  }

  // One log line per key (not per pick - a Cardinals decision that applied
  // to 12 picks is one log entry with pickCount: 12, not 12 near-identical
  // lines) for steps 1-3's key-level decisions, plus one per (key, sport)
  // pair for step 4's per-capper pick_context resolutions and step 5's
  // per-pick plausibility resolutions - pickCount here is the real number of
  // picks that decision actually applied to (per capper for pick_context),
  // not the key's full batch-wide count.
  const logs: ResolutionLog[] = [];
  for (const key of uniqueKeys) {
    const decision = decided.get(key);
    if (!decision) continue;
    const applied = appliedCountByKey.get(key) ?? 0;
    if (applied === 0) continue; // every pick was gated out (schedule vs. line plausibility)
    logs.push({
      ambiguousName: key,
      resolvedSport: decision.choice.sport,
      method: decision.method,
      reason: decision.reason,
      pickCount: applied,
    });
  }
  for (const { key, sport, count } of contextLog.values()) {
    logs.push({
      ambiguousName: key,
      resolvedSport: sport,
      method: "pick_context",
      reason: "pick text matched " + sport + "-specific terminology (scoped to the capper whose own pick produced the match)",
      pickCount: count,
    });
  }
  for (const { key, sport, count, relationship, viaSchedule } of plausibilityLog.values()) {
    const relationshipReason =
      relationship === "AGREES"
        ? "another hierarchy signal independently agreed"
        : "no other hierarchy signal disagreed";
    logs.push({
      ambiguousName: key,
      resolvedSport: sport,
      method: "plausibility",
      reason: viaSchedule
        ? sport + " is the only candidate with a game today among those whose line is realistic"
        : sport + " is the only candidate whose line is realistic for that league (" + relationshipReason + ")",
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
  // A key whose decision applied to no pick (every one gated out by line
  // plausibility) is not memoized: step 1 applies memory unconditionally, so
  // remembering it would let a rejected schedule guess become a "user answer"
  // on the next re-parse.
  for (const [key, decision] of decided.entries()) {
    if (decision.method !== "remembered" && (appliedCountByKey.get(key) ?? 0) === 0) continue;
    decisions[key] = decision.choice;
  }

  return { picks, logs, stillAmbiguous, decisions };
}

// Whether any of a feed's games starts within LEAGUE_ACTIVITY_WINDOW_DAYS of
// `referenceDate`, either side - the per-league question step 1b asks. Kept
// here, with the window it applies, so the server action that reads the feeds
// (checkAmbiguousLeagueActivity) and the tests share one definition.
export function hasGameWithinActivityWindow(games: { commenceTime: string }[], referenceDate: Date): boolean {
  const windowMs = LEAGUE_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return games.some((g) => {
    const start = new Date(g.commenceTime).getTime();
    return Number.isFinite(start) && Math.abs(start - referenceDate.getTime()) <= windowMs;
  });
}
