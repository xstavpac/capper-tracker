"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  parseCatalog,
  resolveAmbiguousPick,
  isPlayerAmbiguityKey,
  type AmbiguousOption,
  type ParsedPick,
  type ParsedParlay,
} from "@/lib/parse-catalog";
import { autoResolveAmbiguousPicks } from "@/lib/resolve-ambiguous-catalog";
import { importRowCapError } from "@/lib/import-limits";
import {
  bulkImportPicksAction,
  bulkImportParlaysAction,
  previewBulkImportMatches,
  checkDuplicatePicksAction,
  previewMissingTotalLines,
  type MissingTotalLineResult,
  type PreviewMatchedGame,
  type BulkImportParlayLegItem,
} from "@/server/actions/bulk-picks";
import { logParseSkippedLinesAction } from "@/server/actions/import-skipped-lines";
import { recoverUnresolvedPicksAction } from "@/server/actions/recover-unresolved-picks";
import { getNflRosterFullNamesAction } from "@/server/actions/get-nfl-roster-names";
import { getImportFeedTeamsAction } from "@/server/actions/get-import-feed-teams";
import { LightningIcon } from "@/components/dashboard/drop-catalog-button";
import { CommonFormatsCard } from "@/components/import/supported-formats";
import { findClosestFuzzyMatch } from "@/lib/fuzzy-match";
import { isSkippedAsDuplicate, importButtonLabel } from "@/lib/duplicate-pick-detection";
import {
  isPendingOrRejectedTotalLine as isPendingOrRejectedTotalLineShared,
  partitionReviewEntries,
  totalSkipped,
  pendingSkipCounts,
  importActionLabel,
  type ReviewPickState,
  describeUnresolvedLines,
  unresolvedReasonBreakdown,
} from "@/lib/bulk-import-summary";
import { betTypeLabel } from "@/lib/bet-line";
import { capperInitials, formatOdds } from "@/lib/pick-display";

// Sentinel stored in capperFuzzyChoices when the user explicitly confirms a
// name really is a new capper, not a typo of an existing one - distinct from
// "not yet decided" (absent from the map), which is what keeps the
// suggestion prompt showing.
const CONFIRMED_NEW = "__new__";

export function BulkImportForm({ existingCapperNames }: { existingCapperNames: string[] }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPick[] | null>(null);
  // MLP (moneyline parlay) lines parseCatalog split into 2 legs - kept
  // separate from `parsed` rather than folded into ParsedPick, since a
  // parlay has no single sportName/betType/odds of its own (see
  // ParsedParlay's own comment). No preview enrichment (odds/duplicate/
  // missing-total-line) for these in v1 - each leg is fully resolved against
  // live data at import time regardless (see bulkImportParlaysAction), the
  // same way it would be for a normal pick; only the up-front preview number
  // is skipped here.
  const [parlays, setParlays] = useState<ParsedParlay[]>([]);
  // Lines that looked pick-shaped but couldn't be resolved to any sport/team/
  // player (see parseCatalog's `unresolved` return value) - shown so the user
  // can add them manually instead of them either vanishing or, worse, being
  // silently misread as a capper name that then swallows every real pick
  // after it.
  const [unresolvedLines, setUnresolvedLines] = useState<string[]>([]);
  // Specific per-line failure reasons from the server recovery pass (line text -> reason).
  const [unresolvedReasons, setUnresolvedReasons] = useState<Record<string, string>>({});
  // Indices in `parsed` for picks the static parser couldn't place and the
  // server's live-schedule fallback recovered (see recoverUnresolvedPicksAction).
  // Shown with a "live schedule" tag so the user can eyeball them - these
  // matched a team playing right now, not the curated lists.
  const [recoveredIndices, setRecoveredIndices] = useState<Set<number>>(new Set());
  const [enrichedOdds, setEnrichedOdds] = useState<Record<number, number>>({});
  // The game each row resolved to, from the same preview call as enrichedOdds
  // (same idx keying) - drives the "Away @ Home - time" sub-line. Absent when a
  // row has the capper's own odds (never resolved in preview) or no game matched.
  const [matchedGames, setMatchedGames] = useState<Record<number, PreviewMatchedGame>>({});
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [importing, setImporting] = useState(false);
  // A whole-import refusal (over the per-import row cap) - distinct from `result`,
  // which reports a run that went through. Nothing was written when this is set.
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    // Raw server-reported skip count (items submitted that bounced) - kept
    // as its own field since it's also what unmatchedGames/errors describe.
    // The toast headline uses `totalSkipped` instead (see below), which
    // folds this in along with every pre-submit skip category.
    skipped: number;
    // The unified count shown in the toast headline - see
    // lib/bulk-import-summary.ts. Sum of every category below plus `skipped`.
    totalSkipped: number;
    errors: string[];
    unmatchedGames: string[];
    // A confirmed doubleheader (MLB's own feed) whose every leg was already
    // final when this pick was resolved - the earliest-not-final default had
    // nothing left to fall back to. Shown with its own message, never lumped
    // into unmatchedGames's "couldn't match to today's schedule" wording,
    // which would wrongly imply the schedule lookup itself failed.
    doubleheaderBothFinal: string[];
    // Picks left out because they matched an existing/earlier pick and the
    // user either chose "Skip" or never answered the prompt (the default is
    // to skip - see isPendingOrSkippedDuplicate). Captured client-side before
    // the preview is cleared so the outcome names them, the same way
    // unmatchedGames does for schedule misses.
    skippedDuplicates: string[];
    // Lines the client parser never turned into a pick at all - captured
    // client-side the same way skippedDuplicates is, since the pre-submit
    // "couldn't be identified" section disappears once `parsed` is cleared.
    skippedUnresolvedLines: string[];
    // Ambiguous-team picks still awaiting a manual choice ("Cardinals?")
    // at the moment Import was clicked.
    skippedAmbiguous: string[];
    // TOTAL picks whose market-line suggestion was left unconfirmed or
    // explicitly rejected at submit time.
    skippedTotalLinePending: string[];
    pickLimitBlocked?: { message: string; remaining: number };
    parlaysImported: number;
    unmatchedParlays: string[];
    parlayErrors: string[];
  } | null>(null);
  // Keyed by the raw capper name as it appears in the pasted text - value is
  // either an existing capper's name (user confirmed "yes, same as") or
  // CONFIRMED_NEW (user confirmed "no, genuinely new"). Absent = not yet
  // decided, which is what keeps the "Did you mean X?" prompt showing.
  const [capperFuzzyChoices, setCapperFuzzyChoices] = useState<Record<string, string>>({});
  // Same-import memory for ambiguous team names (STEP 4 of the disambiguation
  // hierarchy) - keyed by AMBIGUOUS_NICKNAMES key (e.g. "cardinals"), set by
  // either an automatic decision (season/schedule/pick context) or a manual
  // answer. Persists across re-parses within this session (not reset in
  // handleParse) so editing the text and re-pasting still honors an answer
  // already established earlier in the same import.
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, AmbiguousOption>>({});
  const [resolving, setResolving] = useState(false);
  // Keyed by index in `parsed`, same indirection as enrichedOdds. Presence
  // means this pick matches an existing logged pick (same capper + game +
  // bet type/side) - absent from duplicateChoices means "not yet decided",
  // which excludes it from the import by default until the user picks
  // "Skip" (confirms exclusion) or "Import anyway".
  const [duplicateFlags, setDuplicateFlags] = useState<Record<number, { message: string }>>({});
  const [duplicateChoices, setDuplicateChoices] = useState<Record<number, "import" | "skip">>({});
  // Same idx-keyed indirection as duplicateFlags/duplicateChoices - presence
  // in totalLineFlags means this TOTAL pick's own text had no parseable
  // number and a real market line was found to propose instead. Absent from
  // totalLineChoices means "not yet decided", which excludes it from import
  // by default until the user picks "Use X" or "Skip this pick" - same
  // default-excluded-until-confirmed shape as duplicates, so nothing with an
  // auto-filled number ever imports silently.
  const [totalLineFlags, setTotalLineFlags] = useState<Record<number, MissingTotalLineResult>>({});
  const [totalLineChoices, setTotalLineChoices] = useState<Record<number, "confirm" | "reject">>({});

  // Scrolls to the bottom action area (the "Needs your answer" panel and the
  // Import button) right after a fresh Drop Catalog parse - with a large
  // paste that is a long way below the fold, and it is the only place the
  // user has anything left to do. Keyed on its own counter rather than on
  // `parsed` itself, since `parsed` also updates later from unrelated
  // interactions (resolving an ambiguous team, confirming a fuzzy capper
  // match) that shouldn't yank the user's scroll position every time. Bumped
  // once when the parse lands and once more if the duplicate / total-line
  // checks then add questions, since those grow the panel downward.
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionAreaRef = useRef<HTMLDivElement>(null);
  const parseSeqRef = useRef(0);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  // Bumped whenever an import attempt reports back (success, pick-limit
  // pause or refusal): the outcome renders at the top of the Match results
  // card, the Import button that produced it sits at the bottom.
  const [outcomeTrigger, setOutcomeTrigger] = useState(0);
  // The panel's "Answered" list, opened on demand ("Change below" on a row).
  const [answeredOpen, setAnsweredOpen] = useState(false);

  useEffect(() => {
    if (scrollTrigger === 0) return;
    const area = actionAreaRef.current;
    if (!area) return;
    // Taller than the screen: land on its first question, not its last.
    scrollToElement(area, area.getBoundingClientRect().height > window.innerHeight ? "start" : "end");
  }, [scrollTrigger]);

  useEffect(() => {
    if (outcomeTrigger === 0) return;
    resultsHeadingRef.current?.focus({ preventScroll: true });
    scrollToElement(resultsRef.current, "start");
  }, [outcomeTrigger]);

  // "Answer below" on a row: bring that question into view and focus it.
  function jumpToQuestion(id: string, answered = false) {
    if (answered) setAnsweredOpen(true);
    // After React has rendered the (possibly just-opened) answered list.
    setTimeout(() => {
      const el = document.getElementById(id) ?? actionAreaRef.current;
      el?.focus({ preventScroll: true });
      scrollToElement(el, "center");
    }, 0);
  }

  // Roster full names for parseCatalog's findAmbiguousNickname player-prop
  // guard (see that function's own comment in parse-catalog.ts) - fetched
  // once (a ref, not state, so a re-render never restarts it) and reused
  // across every re-parse in this session, same "fetch once per import
  // session" shape existingCapperNames itself already has as a prop. Kicked
  // off eagerly on mount, below, so it's likely already settled by the time
  // the user pastes text and clicks Parse, rather than adding to that click's
  // latency. A failed fetch resolves to `undefined`, NOT an empty array -
  // parseCatalog treats `undefined` as "no roster data available, behave
  // exactly as if this guard didn't exist", so a fallback failure here can
  // only ever widen back to today's behavior, never partially suppress
  // anything on incomplete data.
  const rosterFullNamesRef = useRef<Promise<string[] | undefined> | null>(null);
  function getRosterFullNames(): Promise<string[] | undefined> {
    if (!rosterFullNamesRef.current) {
      rosterFullNamesRef.current = getNflRosterFullNamesAction().catch(() => undefined);
    }
    return rosterFullNamesRef.current;
  }
  useEffect(() => {
    getRosterFullNames();
  }, []);

  const existingLower = existingCapperNames.map((n) => n.toLowerCase());

  function fuzzySuggestionFor(rawCapperName: string): string | null {
    if (existingLower.includes(rawCapperName.toLowerCase())) return null; // exact match already, no suggestion needed
    const match = findClosestFuzzyMatch(rawCapperName, existingCapperNames, (n) => n);
    return match ? match.item : null;
  }

  // The name actually used at import/preview time - the fuzzy match's target
  // once confirmed, otherwise the raw parsed name unchanged.
  function resolvedCapperName(rawCapperName: string): string {
    const choice = capperFuzzyChoices[rawCapperName];
    return choice && choice !== CONFIRMED_NEW ? choice : rawCapperName;
  }

  // parseCatalog itself stays a pure sync function (unchanged) - everything
  // it can't resolve on its own (an ambiguous team name like "Cardinals")
  // then runs through the auto-resolution hierarchy: this same-import's
  // remembered answers -> live schedule (does exactly one candidate have a
  // game today) -> calendar season as a fallback -> pick-text context, in
  // that order, before anything is shown to the user as a question. See
  // lib/ambiguous-hierarchy.ts for the actual hierarchy.
  async function handleParse() {
    setResult(null);
    setEnrichedOdds({});
    setMatchedGames({});
    setDuplicateFlags({});
    setDuplicateChoices({});
    setTotalLineFlags({});
    setTotalLineChoices({});
    setAnsweredOpen(false);
    setResolving(true);
    const parseSeq = ++parseSeqRef.current;
    // Teams known only from the live NCAAF game feed (FCS schools) - see
    // getImportFeedTeamsAction. A failed fetch parses without them.
    const [rosterFullNames, feedTeams] = await Promise.all([
      getRosterFullNames(),
      getImportFeedTeamsAction().catch(() => undefined),
    ]);
    const {
      picks: items,
      parlays: parlayItems,
      unresolved,
      unresolvedCapperNames,
      droppedAsHeaders,
    } = parseCatalog(text, existingCapperNames, rosterFullNames, feedTeams);
    setParlays(parlayItems);
    // Last-resort pass: hand the lines parseCatalog couldn't place to the
    // server, which checks them against the real team names on today's live
    // schedule + odds board (see recoverUnresolvedPicksAction). Only an
    // exact-one match is recovered; anything ambiguous or unmatched stays in
    // the manual list. parseCatalog itself is untouched.
    let effectiveItems = items;
    let unresolvedAfter = unresolved;
    let recovered: ParsedPick[] = [];
    let recoveryRan = true;
    setUnresolvedReasons({});
    if (unresolved.length > 0) {
      try {
        const res = await recoverUnresolvedPicksAction(text, existingCapperNames);
        recovered = res.recovered;
        effectiveItems = [...items, ...recovered];
        unresolvedAfter = res.stillUnresolved;
        setUnresolvedReasons(res.reasons);
      } catch {
        // Best-effort - a fallback failure just leaves every line unresolved,
        // exactly as before this pass existed.
        recoveryRan = false;
      }
    }
    setUnresolvedLines(unresolvedAfter);
    // Skipped-line log (fire-and-forget, once per paste): everything parsing
    // failed to turn into a pick. The action swallows its own errors and
    // takes the user from the session, so this can't affect the import.
    const capperForUnresolved = new Map<string, string>();
    unresolved.forEach((line, i) => {
      if (!capperForUnresolved.has(line)) capperForUnresolved.set(line, unresolvedCapperNames[i] ?? "Unknown");
    });
    const silent = droppedAsHeaders.map((l) => ({ ...l, reason: "Read as a capper header but looks like a pick" }));
    if (silent.length > 0 || unresolvedAfter.length > 0) {
      void logParseSkippedLinesAction({
        silent,
        unresolved: unresolvedAfter.map((t) => ({ text: t, capperName: capperForUnresolved.get(t) ?? "Unknown" })),
        recoveryRan,
      }).catch(() => {});
    }
    // autoResolveAmbiguousPicks preserves array order and length, so the
    // recovered picks keep the tail slots they were appended into.
    setRecoveredIndices(new Set(recovered.map((_, i) => items.length + i)));
    const outcome = await autoResolveAmbiguousPicks(effectiveItems, ambiguousChoices);
    setResolving(false);
    setParsed(outcome.picks);
    setScrollTrigger((v) => v + 1);
    // Merges both automatic decisions from this pass AND anything carried in
    // from priorChoices - so a decision made just now also survives a later
    // re-parse of edited text within the same import.
    if (Object.keys(outcome.decisions).length > 0) {
      setAmbiguousChoices((prev) => ({ ...prev, ...outcome.decisions }));
    }
    const resolvedEntries = outcome.picks.map((p, idx) => ({ p, idx })).filter((e) => !e.p.ambiguous);
    fetchOddsFor(resolvedEntries);
    // Questions these two checks raise land in the panel after the first
    // scroll - follow it down once more if any did (and no newer parse has
    // started since).
    void Promise.allSettled([checkDuplicatesFor(resolvedEntries), checkTotalLinesFor(resolvedEntries)]).then((checks) => {
      const raised = checks.some((c) => c.status === "fulfilled" && c.value > 0);
      if (raised && parseSeqRef.current === parseSeq) setScrollTrigger((v) => v + 1);
    });
  }

  // The parser is client-side only and can't see live odds, so every pick
  // without an explicit price shows the -110 default at first - fetch the
  // same real-price lookup the actual import uses and merge it in once it
  // resolves, so the preview matches what importing will actually save.
  // Keyed by each pick's index in `parsed` (not its position among valid
  // picks) so a later single-pick refetch - e.g. after resolving an
  // ambiguous team - can merge in without invalidating odds already fetched
  // for every other row, which a valid-picks-position key would do the
  // moment resolution shifts everything after it.
  function fetchOddsFor(entries: { p: ParsedPick; idx: number }[]) {
    if (entries.length === 0) return;
    setLoadingOdds(true);
    previewBulkImportMatches(
      entries.map((e) => ({
        sportName: e.p.sportName,
        betType: e.p.betType,
        hasExplicitOdds: e.p.hasExplicitOdds,
        odds: e.p.odds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
        gameNumber: e.p.gameNumber,
      }))
    )
      .then(({ odds, games }) => {
        setEnrichedOdds((prev) => {
          const next = { ...prev };
          for (const [posKey, value] of Object.entries(odds)) {
            const globalIdx = entries[Number(posKey)]?.idx;
            if (globalIdx !== undefined) next[globalIdx] = value;
          }
          return next;
        });
        setMatchedGames((prev) => {
          const next = { ...prev };
          for (const [posKey, value] of Object.entries(games)) {
            const globalIdx = entries[Number(posKey)]?.idx;
            if (globalIdx !== undefined) next[globalIdx] = value;
          }
          return next;
        });
      })
      .finally(() => setLoadingOdds(false));
  }

  // Checks each entry against this user's already-logged picks for the same
  // capper + game + bet type/side + game segment (see checkDuplicatePicksAction
  // for the exact definition). Needs the resolved capper name, so this is re-run
  // whenever a fuzzy-match choice is confirmed, not just once at parse time -
  // duplicate detection can only match an existing capper once we know which
  // saved capper this pick's name actually refers to. Same index-remapping
  // as fetchOddsFor: results come back keyed by position within `entries`,
  // remapped here to each pick's real position in `parsed`.
  // Resolves to how many picks were flagged.
  function checkDuplicatesFor(entries: { p: ParsedPick; idx: number }[]): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    return checkDuplicatePicksAction(
      entries.map((e) => ({
        capperName: resolvedCapperName(e.p.capperName),
        sportName: e.p.sportName,
        betType: e.p.betType,
        odds: e.p.odds,
        hasExplicitOdds: e.p.hasExplicitOdds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
        period: e.p.period,
        gameNumber: e.p.gameNumber,
      }))
    ).then((flags) => {
      setDuplicateFlags((prev) => {
        const next = { ...prev };
        for (const [posKey, flag] of Object.entries(flags)) {
          const globalIdx = entries[Number(posKey)]?.idx;
          if (globalIdx !== undefined) next[globalIdx] = flag;
        }
        return next;
      });
      return Object.keys(flags).length;
    });
  }

  // Flags TOTAL picks with no parseable number in their own text and shows
  // the real market line found for that specific game - same index-remapping
  // as fetchOddsFor/checkDuplicatesFor. Server-side (previewMissingTotalLines)
  // already skips anything with a real number already present, so this never
  // second-guesses a capper's own (possibly alternate) line.
  function checkTotalLinesFor(entries: { p: ParsedPick; idx: number }[]): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    return previewMissingTotalLines(
      entries.map((e) => ({
        sportName: e.p.sportName,
        betType: e.p.betType,
        hasExplicitOdds: e.p.hasExplicitOdds,
        odds: e.p.odds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
        gameNumber: e.p.gameNumber,
      }))
    ).then((flags) => {
      setTotalLineFlags((prev) => {
        const next = { ...prev };
        for (const [posKey, flag] of Object.entries(flags)) {
          const globalIdx = entries[Number(posKey)]?.idx;
          if (globalIdx !== undefined) next[globalIdx] = flag;
        }
        return next;
      });
      return Object.keys(flags).length;
    });
  }

  // Answering once resolves every pick sharing this ambiguous team in the
  // current paste, not just the one the prompt happened to be shown for -
  // this is what stops "Cardinals?" from being asked once per pick. The
  // choice also lands in ambiguousChoices (STEP 4 memory), so it's honored
  // automatically if the user edits the text and re-parses.
  function resolveAmbiguousGroup(key: string, choice: AmbiguousOption) {
    if (!parsed) return;
    setAmbiguousChoices((prev) => ({ ...prev, [key]: choice }));
    const newlyResolved: { p: ParsedPick; idx: number }[] = [];
    const next = parsed.map((p, idx) => {
      if (p.ambiguousKey !== key || !p.ambiguous) return p;
      const resolved = resolveAmbiguousPick(p, choice);
      newlyResolved.push({ p: resolved, idx });
      return resolved;
    });
    setParsed(next);
    const needsOdds = newlyResolved.filter((e) => !e.p.hasExplicitOdds);
    if (needsOdds.length > 0) fetchOddsFor(needsOdds);
    if (newlyResolved.length > 0) checkDuplicatesFor(newlyResolved);
    if (newlyResolved.length > 0) checkTotalLinesFor(newlyResolved);
  }

  const allEntries = (parsed ?? []).map((p, idx) => ({ p, idx }));
  const validEntries = allEntries.filter((e) => !e.p.ambiguous);
  const ambiguousEntries = allEntries.filter((e) => e.p.ambiguous);
  const validPicks = validEntries.map((e) => e.p);
  // Reason labels/counts for the "couldn't be identified" list - derived in
  // lib/bulk-import-summary.ts (the count itself stays totalSkipped's
  // unresolvedLines.length).
  const unresolvedEntries = describeUnresolvedLines(unresolvedLines, unresolvedReasons);
  const unresolvedBreakdown = unresolvedReasonBreakdown(unresolvedEntries);

  // A flagged duplicate is excluded from the import by default - "Skip" just
  // confirms that exclusion explicitly, "Import anyway" is the only way back
  // in. Every other valid pick imports normally, same as before this feature
  // existed - only the flagged ones ever need a decision. (Rule lives in
  // duplicate-pick-detection.ts so it's covered by that module's test.)
  function isPendingOrSkippedDuplicate(idx: number): boolean {
    return isSkippedAsDuplicate(Boolean(duplicateFlags[idx]), duplicateChoices[idx]);
  }
  // Same default-excluded-until-confirmed shape as duplicates - a flagged
  // auto-filled total line never imports until the user explicitly confirms
  // it (or explicitly skips the pick instead). Delegates to the shared pure
  // predicate (lib/bulk-import-summary.ts) so the toast's category
  // partitioning (see handleImport) uses the exact same rule.
  function isPendingOrRejectedTotalLine(idx: number): boolean {
    return isPendingOrRejectedTotalLineShared(Boolean(totalLineFlags[idx]), totalLineChoices[idx]);
  }
  const includedEntries = validEntries.filter(
    (e) => !isPendingOrSkippedDuplicate(e.idx) && !isPendingOrRejectedTotalLine(e.idx)
  );
  const includedPicks = includedEntries.map((e) => e.p);
  // Every flagged duplicate that won't be imported - the user's explicit
  // "Skip" and the never-answered default alike. Drives both the pre-import
  // button hint and the post-import summary.
  const skippedDuplicateEntries = validEntries.filter((e) => isPendingOrSkippedDuplicate(e.idx));
  // Every resolved pick's review state, in the shape lib/bulk-import-summary.ts
  // partitions - the one input behind both the Import button's count and the
  // post-import skip summary.
  const reviewStates: ReviewPickState[] = validEntries.map((e) => ({
    idx: e.idx,
    hasDuplicateFlag: Boolean(duplicateFlags[e.idx]),
    duplicateChoice: duplicateChoices[e.idx],
    hasTotalLineFlag: Boolean(totalLineFlags[e.idx]),
    totalLineChoice: totalLineChoices[e.idx],
  }));
  const dedupeLabel = (p: ParsedPick) =>
    resolvedCapperName(p.capperName) + " - " + p.sportName + " - " + p.description;

  // One prompt per unique ambiguous team name in this paste, not per pick -
  // groups every entry sharing an ambiguousKey (e.g. every "Cardinals" pick)
  // behind a single question with a count, instead of asking 12 times.
  const ambiguousGroups: { key: string; options: AmbiguousOption[]; sampleRaw: string; count: number; cappers: string[] }[] = [];
  {
    const byKey = new Map<string, { options: AmbiguousOption[]; sampleRaw: string; count: number; cappers: string[] }>();
    for (const { p } of ambiguousEntries) {
      const key = p.ambiguousKey!;
      const capper = resolvedCapperName(p.capperName);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.cappers.includes(capper)) existing.cappers.push(capper);
      } else byKey.set(key, { options: p.ambiguous!, sampleRaw: p.raw, count: 1, cappers: [capper] });
    }
    for (const [key, v] of byKey.entries()) ambiguousGroups.push({ key, ...v });
  }

  // One prompt per distinct raw capper name in this paste, not per pick row -
  // asking "did you mean X?" once per capper, even if they posted 10 picks.
  const pendingFuzzySuggestions = Array.from(new Set(validPicks.map((p) => p.capperName)))
    .filter((name) => !(name in capperFuzzyChoices))
    .map((name) => ({ name, suggestion: fuzzySuggestionFor(name) }))
    .filter((e): e is { name: string; suggestion: string } => e.suggestion !== null);

  async function handleImport() {
    // Runs even at 0 included picks as long as there's something to report -
    // re-pasting an already-imported catalog leaves nothing to import but
    // still needs the "all N skipped as duplicates" outcome shown.
    if (includedPicks.length === 0 && skippedDuplicateEntries.length === 0 && parlays.length === 0) return;
    // Snapshot before the request - the preview (and these lists) are
    // cleared on success, and none of these picks are ever sent to the
    // server so it can't report them back. Covers every pre-submit skip
    // category still outstanding right now, at the moment Import is
    // clicked - a pick the user already resolved via a prompt (e.g. picked
    // "San Francisco Giants (MLB)" for an ambiguous Giants pick) is by this
    // point back in `validEntries`/`includedEntries` and correctly absent
    // from all of these.
    const skippedDuplicates = skippedDuplicateEntries.map((e) => dedupeLabel(e.p));
    const skippedAmbiguous = ambiguousEntries.map((e) => e.p.capperName + ' - "' + e.p.raw + '"');
    const skippedUnresolvedLines = unresolvedLines;
    // totalLinePendingIdx deliberately excludes anything already counted in
    // skippedDuplicateEntries (see partitionReviewEntries) - a pick flagged
    // for both reasons at once must land in exactly one category, or the
    // toast total would double-count it.
    const { totalLinePendingIdx } = partitionReviewEntries(reviewStates);
    const totalLinePendingIdxSet = new Set(totalLinePendingIdx);
    const skippedTotalLinePending = validEntries
      .filter((e) => totalLinePendingIdxSet.has(e.idx))
      .map((e) => dedupeLabel(e.p));
    setImportError(null);
    // Same check the server makes (bulkImportPicksAction), run first so an
    // oversized paste is refused instantly and never sends the whole payload.
    const capError = importRowCapError(includedEntries.length);
    if (capError) {
      setImportError(capError);
      setOutcomeTrigger((v) => v + 1);
      return;
    }
    setImporting(true);
    // Sequential, not Promise.all: both actions independently do "find this
    // capper by normalized name, else create" against their own snapshot of
    // existingCappers - running them concurrently could let a brand-new
    // capper who appears ONLY via an MLP parlay in this same paste (or in
    // both a pick and a parlay) get created twice before either write
    // commits. Awaiting the picks import first means the parlay import's own
    // capper lookup always sees it.
    const res = await bulkImportPicksAction(
      includedEntries.map(({ p, idx }) => ({
        capperName: resolvedCapperName(p.capperName),
        sportName: p.sportName,
        description: p.description,
        betType: p.betType,
        odds: p.odds,
        hasExplicitOdds: p.hasExplicitOdds,
        totalSide: p.totalSide,
        teamNicknames: p.teamNicknames,
        units: p.units,
        period: p.period,
        inferredLine: totalLineChoices[idx] === "confirm" ? totalLineFlags[idx]?.inferredLine : undefined,
        gameNumber: p.gameNumber,
        raw: p.raw,
      })),
      skippedDuplicateEntries.map((e) => ({
        capperName: resolvedCapperName(e.p.capperName),
        sportName: e.p.sportName,
        raw: e.p.raw,
      }))
    );
    // A refused picks import must not let the parlay import run on its own.
    if (!res.success) {
      setImporting(false);
      setImportError(res.error);
      setOutcomeTrigger((v) => v + 1);
      return;
    }
    const parlayRes =
      parlays.length > 0
        ? await bulkImportParlaysAction(
            parlays.map((parlay) => ({
              capperName: resolvedCapperName(parlay.capperName),
              units: parlay.units,
              legs: parlay.legs.map((leg) => ({
                sportName: leg.sportName,
                description: leg.description,
                betType: leg.betType,
                odds: leg.odds ?? -110,
                hasExplicitOdds: leg.odds !== null,
                totalSide: leg.totalSide,
                teamNicknames: leg.teamNicknames,
                period: leg.period,
                // Never parsed for parlay legs (see ParsedParlayLeg) - a leg
                // whose game turns out to be a real MLB doubleheader is
                // flagged (unresolved) rather than guessed at, the same
                // "no gameNumber signal -> refuse to guess" rule a bare
                // single pick gets. See pickBestScheduleCandidate.
                gameNumber: null,
              })) as [BulkImportParlayLegItem, BulkImportParlayLegItem], // ParsedParlay.legs is already a 2-tuple
            }))
          )
        : null;
    setImporting(false);
    if (res.success) {
      setResult({
        imported: res.imported,
        skipped: res.skipped,
        totalSkipped: totalSkipped({
          unresolvedLines: skippedUnresolvedLines,
          ambiguousUnanswered: skippedAmbiguous,
          totalLinePending: skippedTotalLinePending,
          duplicates: skippedDuplicates,
          serverSkipped: res.skipped,
        }),
        errors: res.errors,
        unmatchedGames: res.unmatchedGames,
        doubleheaderBothFinal: res.doubleheaderBothFinal,
        skippedDuplicates,
        skippedUnresolvedLines,
        skippedAmbiguous,
        skippedTotalLinePending,
        pickLimitBlocked: res.pickLimitBlocked,
        parlaysImported: parlayRes?.success ? parlayRes.imported : 0,
        unmatchedParlays: parlayRes?.success ? parlayRes.unmatchedParlays : [],
        parlayErrors: parlayRes && !parlayRes.success ? [parlayRes.error] : parlayRes?.success ? parlayRes.errors : [],
      });
      // Blocked by the pick limit means nothing was imported - keep the
      // pasted text and preview in place so upgrading and retrying doesn't
      // require re-pasting the whole catalog.
      if (!res.pickLimitBlocked) {
        setParsed(null);
        setParlays([]);
        setUnresolvedLines([]);
        setUnresolvedReasons({});
        setText("");
      }
      setOutcomeTrigger((v) => v + 1);
    }
  }

  // ---- Presentation only below: everything above decides what imports. ----

  // 1 = paste, 2 = reviewing a dropped catalog, 3 = an import went through.
  // A pick-limit refusal keeps the preview (and so step 2) in place.
  const step = parsed ? 2 : result && !result.pickLimitBlocked ? 3 : 1;

  // Every pick in the paste (resolved and still-ambiguous alike) under its
  // capper, in first-appearance order.
  type Entry = { p: ParsedPick; idx: number };
  const capperGroups: { name: string; rawNames: string[]; entries: Entry[] }[] = [];
  {
    const byName = new Map<string, (typeof capperGroups)[number]>();
    for (const e of allEntries) {
      const name = resolvedCapperName(e.p.capperName);
      let group = byName.get(name);
      if (!group) {
        group = { name, rawNames: [], entries: [] };
        byName.set(name, group);
        capperGroups.push(group);
      }
      if (!group.rawNames.includes(e.p.capperName)) group.rawNames.push(e.p.capperName);
      group.entries.push(e);
    }
  }

  // Every question is asked in the "Needs your answer" panel above the Import
  // button, and only there - a row in the list just points down to it. An
  // ambiguous name is one question per paste (resolveAmbiguousGroup answers
  // every pick sharing the key); a duplicate / missing total is one per pick.
  const ambiguousGroupByKey = new Map(ambiguousGroups.map((g) => [g.key, g]));
  const duplicateEntries = validEntries.filter((e) => duplicateFlags[e.idx]);
  const totalLineEntries = validEntries.filter((e) => totalLineFlags[e.idx]);
  const pendingDuplicates = duplicateEntries.filter((e) => duplicateChoices[e.idx] === undefined);
  const pendingTotalLines = totalLineEntries.filter((e) => totalLineChoices[e.idx] === undefined);
  const answeredDuplicates = duplicateEntries.filter((e) => duplicateChoices[e.idx] !== undefined);
  const answeredTotalLines = totalLineEntries.filter((e) => totalLineChoices[e.idx] !== undefined);
  const questionCount = ambiguousGroups.length + pendingDuplicates.length + pendingTotalLines.length;
  const answeredCount = answeredDuplicates.length + answeredTotalLines.length;

  function needsReview(e: Entry): boolean {
    if (e.p.ambiguous) return true;
    const dupPending = Boolean(duplicateFlags[e.idx]) && duplicateChoices[e.idx] === undefined;
    const totalPending = Boolean(totalLineFlags[e.idx]) && totalLineChoices[e.idx] === undefined;
    return dupPending || totalPending;
  }
  const readyCount = includedPicks.length + parlays.length;
  const reviewCount = allEntries.filter(needsReview).length;
  const canImport = !(includedPicks.length === 0 && skippedDuplicateEntries.length === 0 && parlays.length === 0);
  const skipCounts = pendingSkipCounts(reviewStates, ambiguousEntries.length);

  function setAllPendingDuplicates(choice: "import" | "skip") {
    setDuplicateChoices((prev) => {
      const next = { ...prev };
      for (const e of pendingDuplicates) next[e.idx] = choice;
      return next;
    });
  }

  function ambiguousReason(group: (typeof ambiguousGroups)[number]): string {
    if (group.options.length === 1) {
      return "Line plausibility narrowed this to " + group.options[0].label + ", but another signal disagreed - confirm it.";
    }
    return isPlayerAmbiguityKey(group.key)
      ? "More than one player has this name - which one?"
      : "Ambiguous team - could mean " + group.options.map((o) => o.label).join(" or ") + ".";
  }

  function handleClear() {
    setText("");
    setParsed(null);
    setParlays([]);
    setUnresolvedLines([]);
    setUnresolvedReasons({});
    setResult(null);
    setImportError(null);
  }

  function renderRow(e: Entry) {
    const { p, idx } = e;
    const isAmbiguous = Boolean(p.ambiguous);
    const ambiguousKey = isAmbiguous ? p.ambiguousKey : undefined;
    const ambiguousGroup = ambiguousKey ? ambiguousGroupByKey.get(ambiguousKey) : undefined;
    const dupFlag = duplicateFlags[idx];
    const dupChoice = duplicateChoices[idx];
    const totalFlag = totalLineFlags[idx];
    const totalChoice = totalLineChoices[idx];
    const review = needsReview(e);
    const skipped = !review && (isPendingOrSkippedDuplicate(idx) || isPendingOrRejectedTotalLine(idx));
    const realOdds = enrichedOdds[idx];
    const displayOdds = realOdds ?? p.odds;
    const game = matchedGames[idx];
    const subLine = game
      ? p.sportName + " · " + game.awayTeam + " @ " + game.homeTeam + " · " + formatGameTime(game.gameTime)
      : (p.sportName || "League not set") + " · " + betTypeLabel(p.betType) + " · " + p.units + "u";

    return (
      <li
        key={idx}
        className={
          "rounded-lg border px-3 py-2.5 " +
          (review
            ? "border-amber-400 bg-amber-50/60 dark:border-amber-500/60 dark:bg-amber-500/5"
            : "border-border-subtle bg-card")
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={"break-words text-sm font-medium text-foreground" + (skipped ? " line-through opacity-70" : "")}>
              {isAmbiguous ? p.raw : p.description}
            </div>
            <div className="mt-0.5 break-words text-xs text-muted-foreground">
              {subLine}
              {recoveredIndices.has(idx) && (
                <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  matched to live schedule
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge kind={review ? "review" : skipped ? "skipped" : "ready"} />
            {!isAmbiguous && (
              <div className="text-right font-mono text-xs text-foreground">
                {formatOdds(displayOdds)}
                <div className="font-sans text-[11px] text-muted-foreground">
                  {game ? p.units + "u" : null}
                  {game && realOdds !== undefined ? " · " : null}
                  {realOdds !== undefined ? "market price" : null}
                </div>
              </div>
            )}
          </div>
        </div>

        {ambiguousKey && ambiguousGroup && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-amber-900 dark:text-amber-200">
            <span>{ambiguousReason(ambiguousGroup)}</span>
            <button type="button" onClick={() => jumpToQuestion(ambiguousQuestionId(ambiguousKey))} className={promptLinkClass}>
              Answer below ↓
            </button>
          </div>
        )}

        {dupFlag && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-amber-900 dark:text-amber-200">
            <span>
              Possible duplicate: {dupFlag.message}
              {dupChoice === "skip" && <span className="font-medium"> Skipped - won&apos;t be imported.</span>}
              {dupChoice === "import" && <span className="font-medium"> Will import despite the duplicate.</span>}
            </span>
            <button
              type="button"
              onClick={() => jumpToQuestion(duplicateQuestionId(idx), dupChoice !== undefined)}
              className={promptLinkClass}
            >
              {dupChoice === undefined ? "Answer below ↓" : "Change below ↓"}
            </button>
          </div>
        )}

        {totalFlag && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-amber-900 dark:text-amber-200">
            <span>
              {totalFlag.reason === "missing"
                ? "No number found in this pick's text."
                : "Couldn't read a valid number in this pick's text."}
              {totalChoice === "confirm" && (
                <span className="font-medium"> Will import with {totalFlag.inferredLine} filled in.</span>
              )}
              {totalChoice === "reject" && <span className="font-medium"> Skipped - won&apos;t be imported.</span>}
            </span>
            <button
              type="button"
              onClick={() => jumpToQuestion(totalLineQuestionId(idx), totalChoice !== undefined)}
              className={promptLinkClass}
            >
              {totalChoice === undefined ? "Answer below ↓" : "Change below ↓"}
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div>
      <ol className="mb-5 flex flex-wrap items-center gap-2" aria-label="Import steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n === step ? "active" : n < step ? "done" : "upcoming";
          return (
            <li key={label} className="flex items-center gap-2">
              {i > 0 && (
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              )}
              <span
                aria-current={state === "active" ? "step" : undefined}
                className={
                  "inline-flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-sm font-medium " +
                  (state === "active"
                    ? "border-brand-600 bg-brand-600 text-white"
                    : state === "done"
                      ? "border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200"
                      : "border-border bg-card text-muted-foreground")
                }
              >
                <span
                  className={
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold " +
                    (state === "active"
                      ? "bg-white text-brand-700"
                      : state === "done"
                        ? "bg-brand-600 text-white"
                        : "bg-muted text-foreground")
                  }
                >
                  {n}
                </span>
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-start gap-5">
        {/* Left: editor */}
        <section aria-labelledby="catalog-editor-title" className={cardClass + " min-w-0 flex-[1_1_420px] p-5"}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="catalog-editor-title" className="text-base font-semibold text-foreground">
                <label htmlFor="catalog-text">Paste your catalog</label>
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Capper name on its own line, picks underneath. Blank line between cappers.
              </p>
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={!text && !parsed && !result}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-full border border-border px-4 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
          </div>

          <div className="mt-3 flex overflow-hidden rounded-lg border border-border bg-card transition focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/30">
            <textarea
              id="catalog-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={EDITOR_ROWS}
              wrap="off"
              spellCheck={false}
              placeholder={
                "Vegas John\nCubs moneyline\nWhite Sox -1.5\n\nHigh Roller Hank\nYankees ML\nDodgers under 8.5"
              }
              className="block min-w-0 flex-1 resize-y overflow-auto whitespace-pre bg-transparent px-3 py-2 font-mono text-[13px] leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>

          {(parsed || (result && !result.pickLimitBlocked)) && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Catalog summary">
              {parsed && (
                <>
                  <Chip tone="green">{readyCount} ready</Chip>
                  {reviewCount > 0 && <Chip tone="amber">{reviewCount} need review</Chip>}
                </>
              )}
              {!parsed && result && !result.pickLimitBlocked && (
                <>
                  <Chip tone="green">{result.imported} saved</Chip>
                  {result.parlaysImported > 0 && (
                    <Chip tone="green">
                      {result.parlaysImported} parlay{result.parlaysImported === 1 ? "" : "s"} saved
                    </Chip>
                  )}
                  {result.totalSkipped > 0 && <Chip tone="amber">{result.totalSkipped} skipped</Chip>}
                  {result.unmatchedParlays.length > 0 && (
                    <Chip tone="amber">
                      {result.unmatchedParlays.length} parlay{result.unmatchedParlays.length === 1 ? "" : "s"} unmatched
                    </Chip>
                  )}
                </>
              )}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-[13px] text-muted-foreground">
              <svg
                viewBox="0 0 24 24"
                className="mt-0.5 h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <path d="M12 8h.01" />
              </svg>
              <span>Imported picks appear on the Live tab, grouped under their games.</span>
            </p>
            <button
              type="button"
              onClick={handleParse}
              disabled={!text.trim() || resolving}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-full bg-brand-600 px-6 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LightningIcon />
              {resolving ? "Resolving..." : "Drop Catalog"}
            </button>
          </div>
        </section>

        {/* Right: match results + common formats */}
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
          <section ref={resultsRef} aria-labelledby="match-results-title" className={cardClass + " scroll-mt-4 p-5"}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2
                id="match-results-title"
                ref={resultsHeadingRef}
                tabIndex={-1}
                className="rounded text-base font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Match results
              </h2>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {parsed
                  ? readyCount + " ready · " + reviewCount + " need review"
                  : result && !result.pickLimitBlocked
                    ? result.imported + " of " + (result.imported + result.totalSkipped) + " saved · just now"
                    : null}
                {parsed && loadingOdds && <span className="ml-2">Looking up real odds...</span>}
              </p>
            </div>

            {importError && (
              <div role="alert" className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-300">
                <div className="font-semibold">Import not started</div>
                <p className="mt-1">{importError}</p>
              </div>
            )}

            {result?.pickLimitBlocked && (
              <div role="alert" className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <div className="font-semibold">Import paused - Free plan limit reached</div>
                <p className="mt-1">{result.pickLimitBlocked.message}</p>
                <a
                  href="/pricing"
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-amber-700 px-4 text-sm font-medium text-white transition hover:bg-amber-800"
                >
                  Upgrade to Basic for unlimited picks
                </a>
              </div>
            )}

            {!parsed && !result && !importError && (
              <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                {resolving ? "Matching your catalog..." : "Drop your catalog to see matches here."}
              </p>
            )}

            {parsed && (
              <div className="mt-3 space-y-4">
                {capperGroups.length === 0 && parlays.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    No picks found in this paste.
                  </p>
                )}

                {capperGroups.map((group) => {
                  const fuzzy = pendingFuzzySuggestions.filter((s) => group.rawNames.includes(s.name));
                  const matchedFrom = group.rawNames.filter((n) => n !== group.name);
                  const isNew = matchedFrom.length === 0 && !existingLower.includes(group.name.toLowerCase());
                  return (
                    <div key={group.name}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-800 dark:bg-brand-500/15 dark:text-brand-200"
                        >
                          {capperInitials(group.name)}
                        </span>
                        <h3 className="min-w-0 break-words text-sm font-semibold text-foreground">{group.name}</h3>
                        {matchedFrom.map((raw) => (
                          <span
                            key={raw}
                            className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                          >
                            matched from &quot;{raw}&quot;
                          </span>
                        ))}
                        {isNew && (
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                            new
                          </span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {group.entries.length} pick{group.entries.length === 1 ? "" : "s"}
                        </span>
                      </div>

                      {fuzzy.map(({ name, suggestion }) => (
                        <div
                          key={"fuzzy-" + name}
                          className="mt-2 rounded-lg border border-amber-400 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200"
                        >
                          <div>
                            <span className="font-semibold">&quot;{name}&quot;</span> isn&apos;t an exact match for any saved
                            capper. Did you mean <span className="font-semibold">{suggestion}</span>?
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setCapperFuzzyChoices((prev) => ({ ...prev, [name]: suggestion }));
                                checkDuplicatesFor(validEntries.filter((e) => e.p.capperName === name));
                              }}
                              className={promptButtonClass}
                            >
                              Yes, same as {suggestion}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCapperFuzzyChoices((prev) => ({ ...prev, [name]: CONFIRMED_NEW }));
                                checkDuplicatesFor(validEntries.filter((e) => e.p.capperName === name));
                              }}
                              className={promptButtonClass}
                            >
                              No, &quot;{name}&quot; is a different capper
                            </button>
                          </div>
                        </div>
                      ))}

                      <ul className="mt-2 space-y-1.5">{group.entries.map(renderRow)}</ul>
                    </div>
                  );
                })}

                {parlays.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {parlays.length} parlay{parlays.length === 1 ? "" : "s"} (MLP)
                    </h3>
                    <ul className="mt-2 space-y-1.5">
                      {parlays.map((parlay, i) => (
                        <li key={"parlay-" + i} className="rounded-lg border border-border-subtle bg-card px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="break-words text-sm font-medium text-foreground">
                                {parlay.legs[0].description} + {parlay.legs[1].description}
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {resolvedCapperName(parlay.capperName)} · {parlay.sportName} · MLP · {parlay.units}u
                              </div>
                            </div>
                            <StatusBadge kind="ready" />
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Real line/odds for each leg are resolved from today&apos;s schedule at import - not the
                            numbers above.
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {unresolvedLines.length > 0 && (
                  <details className="rounded-lg border border-amber-400 bg-amber-50/60 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200">
                    <summary className={summaryClass}>
                      {unresolvedLines.length} couldn&apos;t read
                    </summary>
                    <div className="px-3 pb-3">
                      <p>
                        {unresolvedLines.length === 1 ? "This line looked like a pick" : "These lines looked like picks"} but
                        couldn&apos;t be matched to a sport or team - not imported and not attributed to any capper. Add{" "}
                        {unresolvedLines.length === 1 ? "it" : "them"} manually:
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {unresolvedEntries.map((entry, i) => (
                          <li key={i}>
                            <span className="break-words font-mono">{entry.text}</span>
                            {entry.reason && <span className="ml-1 font-semibold">- {entry.reason}</span>}
                          </li>
                        ))}
                      </ul>
                      {unresolvedBreakdown.length > 0 && (
                        <p className="mt-1.5 font-medium">
                          {unresolvedBreakdown.map((b) => b.count + " - " + b.reason).join("; ")}
                        </p>
                      )}
                    </div>
                  </details>
                )}

                <div ref={actionAreaRef} className="scroll-mt-4 space-y-3">
                  {(questionCount > 0 || answeredCount > 0) && (
                    <section
                      aria-labelledby="needs-answer-title"
                      className="rounded-lg border border-amber-400 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200"
                    >
                      <h3 id="needs-answer-title" className="text-sm font-semibold">
                        {questionCount > 0 ? "Needs your answer (" + questionCount + ")" : "All questions answered"}
                      </h3>

                      {ambiguousGroups.length > 0 && (
                        <div className="mt-3">
                          <h4 className={questionGroupTitleClass}>Ambiguous team or player ({ambiguousGroups.length})</h4>
                          <ul className="mt-1.5 space-y-1.5">
                            {ambiguousGroups.map((g) => (
                              <QuestionItem
                                key={g.key}
                                id={ambiguousQuestionId(g.key)}
                                text={g.sampleRaw}
                                meta={
                                  capperSummary(g.cappers) +
                                  (g.count > 1 ? " · " + g.count + " picks" : "") +
                                  " · " +
                                  (g.options.length === 1
                                    ? ambiguousReason(g)
                                    : isPlayerAmbiguityKey(g.key)
                                      ? "More than one player has this name"
                                      : "Ambiguous team")
                                }
                              >
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  {g.options.map((opt) => (
                                    <button
                                      key={opt.label}
                                      type="button"
                                      onClick={() => resolveAmbiguousGroup(g.key, opt)}
                                      className={promptButtonClass}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-1 text-amber-800 dark:text-amber-300">
                                  {g.count > 1
                                    ? isPlayerAmbiguityKey(g.key)
                                      ? "Answering once resolves all " + g.count + " picks with this name in this paste."
                                      : "Answering once resolves all " + g.count + " " + g.key + " picks in this paste."
                                    : isPlayerAmbiguityKey(g.key)
                                      ? "Or edit the text to add the first name, then drop again."
                                      : "Or edit the text to specify the city, then drop again."}{" "}
                                  Left unanswered, it won&apos;t be imported.
                                </div>
                              </QuestionItem>
                            ))}
                          </ul>
                        </div>
                      )}

                      {pendingDuplicates.length > 0 && (
                        <div className="mt-3">
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                            <h4 className={questionGroupTitleClass}>Possible duplicates ({pendingDuplicates.length})</h4>
                            {pendingDuplicates.length > 1 && (
                              <div className="flex flex-wrap gap-1.5">
                                <button type="button" onClick={() => setAllPendingDuplicates("skip")} className={promptButtonClass}>
                                  Skip all duplicates
                                </button>
                                <button type="button" onClick={() => setAllPendingDuplicates("import")} className={promptButtonClass}>
                                  Import all
                                </button>
                              </div>
                            )}
                          </div>
                          <ul className="mt-1.5 space-y-1.5">
                            {pendingDuplicates.map(({ p, idx }) => (
                              <QuestionItem
                                key={idx}
                                id={duplicateQuestionId(idx)}
                                text={p.description}
                                meta={resolvedCapperName(p.capperName) + " · " + p.sportName + " · " + duplicateFlags[idx].message}
                              >
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "skip" }))}
                                    className={promptButtonClass}
                                  >
                                    Skip
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "import" }))}
                                    className={promptButtonClass}
                                  >
                                    Import anyway
                                  </button>
                                  <span className="text-amber-800 dark:text-amber-300">Left unanswered, it&apos;s skipped.</span>
                                </div>
                              </QuestionItem>
                            ))}
                          </ul>
                        </div>
                      )}

                      {pendingTotalLines.length > 0 && (
                        <div className="mt-3">
                          <h4 className={questionGroupTitleClass}>Missing total number ({pendingTotalLines.length})</h4>
                          <ul className="mt-1.5 space-y-1.5">
                            {pendingTotalLines.map(({ p, idx }) => {
                              const flag = totalLineFlags[idx];
                              return (
                                <QuestionItem
                                  key={idx}
                                  id={totalLineQuestionId(idx)}
                                  text={p.description}
                                  meta={resolvedCapperName(p.capperName) + " · " + p.sportName}
                                >
                                  <div className="mt-1.5">
                                    {flag.reason === "missing"
                                      ? "No number found in this pick's text."
                                      : "Couldn't read a valid number in this pick's text."}{" "}
                                    Today&apos;s market total for this game is{" "}
                                    <span className="font-semibold">{flag.inferredLine}</span>.
                                  </div>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "confirm" }))}
                                      className={promptButtonClass}
                                    >
                                      Use {flag.inferredLine}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "reject" }))}
                                      className={promptButtonClass}
                                    >
                                      Skip this pick
                                    </button>
                                    <span className="text-amber-800 dark:text-amber-300">Left unanswered, it&apos;s skipped.</span>
                                  </div>
                                </QuestionItem>
                              );
                            })}
                          </ul>
                        </div>
                      )}

                      {answeredCount > 0 && (
                        <div className={questionCount > 0 ? "mt-3" : "mt-1"}>
                          <button
                            type="button"
                            aria-expanded={answeredOpen}
                            aria-controls="answered-questions"
                            onClick={() => setAnsweredOpen((open) => !open)}
                            className={promptLinkClass}
                          >
                            {answeredOpen ? "Hide" : "Show"} answered ({answeredCount})
                          </button>
                          {answeredOpen && (
                            <ul id="answered-questions" className="space-y-1.5">
                              {answeredDuplicates.map(({ p, idx }) => {
                                const willImport = duplicateChoices[idx] === "import";
                                return (
                                  <QuestionItem
                                    key={"dup-" + idx}
                                    id={duplicateQuestionId(idx)}
                                    text={p.description}
                                    meta={resolvedCapperName(p.capperName) + " · " + p.sportName}
                                  >
                                    <div className="flex flex-wrap items-center gap-x-2">
                                      <span className="font-medium">
                                        {willImport ? "Will import despite the duplicate." : "Skipped - won't be imported."}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setDuplicateChoices((prev) => ({ ...prev, [idx]: willImport ? "skip" : "import" }))
                                        }
                                        className={promptLinkClass}
                                      >
                                        {willImport ? "Skip instead" : "Import anyway"}
                                      </button>
                                    </div>
                                  </QuestionItem>
                                );
                              })}
                              {answeredTotalLines.map(({ p, idx }) => {
                                const line = totalLineFlags[idx].inferredLine;
                                const confirmed = totalLineChoices[idx] === "confirm";
                                return (
                                  <QuestionItem
                                    key={"total-" + idx}
                                    id={totalLineQuestionId(idx)}
                                    text={p.description}
                                    meta={resolvedCapperName(p.capperName) + " · " + p.sportName}
                                  >
                                    <div className="flex flex-wrap items-center gap-x-2">
                                      <span className="font-medium">
                                        {confirmed ? "Will import with " + line + " filled in." : "Skipped - won't be imported."}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setTotalLineChoices((prev) => ({ ...prev, [idx]: confirmed ? "reject" : "confirm" }))
                                        }
                                        className={promptLinkClass}
                                      >
                                        {confirmed ? "Skip instead" : "Use " + line + " instead"}
                                      </button>
                                    </div>
                                  </QuestionItem>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </section>
                  )}

                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={importing || !canImport}
                    className="inline-flex min-h-[44px] w-full items-center justify-center rounded-full bg-brand-600 px-5 py-2 text-center text-sm font-semibold text-white shadow-soft transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {importing
                      ? "Importing..."
                      : importActionLabel(
                          importButtonLabel(includedPicks.length, 0) +
                            (parlays.length > 0 ? " + " + parlays.length + " parlay" + (parlays.length === 1 ? "" : "s") : ""),
                          skipCounts
                        )}
                  </button>
                </div>
              </div>
            )}

            {result && !result.pickLimitBlocked && (
              <div className="mt-3 space-y-2">
                <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <p>
                    Imported {result.imported} pick{result.imported === 1 ? "" : "s"}
                    {result.parlaysImported > 0 &&
                      " and " + result.parlaysImported + " parlay" + (result.parlaysImported === 1 ? "" : "s")}
                    .{result.totalSkipped > 0 && " " + result.totalSkipped + " skipped."}
                  </p>
                  <a
                    href="/live"
                    className="mt-2.5 inline-flex min-h-[44px] w-full items-center justify-center rounded-full bg-brand-600 px-6 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 sm:w-auto"
                  >
                    View on the Live tab
                  </a>
                </div>

                {(result.errors.length > 0 || result.parlayErrors.length > 0) && (
                  <ul role="alert" className="list-disc rounded-lg bg-red-50 py-2.5 pl-8 pr-3 text-xs text-red-800 dark:bg-red-500/10 dark:text-red-300">
                    {[...result.errors, ...result.parlayErrors].map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}

                <ResultGroup
                  items={result.unmatchedGames}
                  title={(n) => n + " couldn't match to today's schedule"}
                  note="They were NOT imported. Double-check the matchup and add them manually."
                />
                <ResultGroup
                  items={result.doubleheaderBothFinal}
                  title={(n) => n + " doubleheader pick" + (n === 1 ? "" : "s") + " - both games final"}
                  note="Both games were already final, so there was nothing left to match. Add manually."
                />
                <ResultGroup
                  items={result.skippedDuplicates}
                  title={(n) => n + " skipped as a possible duplicate"}
                  note="They were NOT imported (either you chose Skip, or the prompt was left unanswered)."
                />
                <ResultGroup
                  items={result.skippedAmbiguous}
                  title={(n) => n + " skipped with an ambiguous team or player name"}
                  note={'They were NOT imported (the "which one?" prompt was left unanswered).'}
                />
                <ResultGroup
                  items={result.skippedTotalLinePending}
                  title={(n) => n + " skipped missing a total number"}
                  note="They were NOT imported (the suggested market line was left unconfirmed or rejected)."
                />
                <ResultGroup
                  items={result.skippedUnresolvedLines}
                  title={(n) => n + " couldn't read"}
                  note="Couldn't be matched to a sport or team - not imported and not attributed to any capper."
                  mono
                />
                <ResultGroup
                  items={result.unmatchedParlays}
                  title={(n) => n + " parlay" + (n === 1 ? "" : "s") + " couldn't match"}
                  note="One or both legs couldn't be resolved to today's schedule/odds. They were NOT imported."
                />
              </div>
            )}
          </section>

          <CommonFormatsCard />
        </div>
      </div>
    </div>
  );
}

const STEPS = ["Paste catalog", "Review matches", "Live on the board"];
const EDITOR_ROWS = 12;

const cardClass = "rounded-card border border-border bg-card shadow-soft";

// Review-prompt choices: real buttons, 44px tall for touch.
const promptButtonClass =
  "inline-flex min-h-[44px] items-center rounded-full border border-amber-500 bg-card px-3.5 text-left text-xs font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30";
const promptLinkClass =
  "inline-flex min-h-[44px] items-center font-semibold underline hover:text-amber-950 dark:hover:text-amber-100";
const summaryClass = "flex min-h-[44px] cursor-pointer items-center px-3 text-sm font-semibold";

function formatGameTime(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }) + " ET"
  );
}

// Jumps instead of gliding for anyone who asked for reduced motion.
function scrollToElement(el: HTMLElement | null, block: ScrollLogicalPosition) {
  if (!el) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block });
}

// DOM ids of the questions in the "Needs your answer" panel - what a row's
// "Answer below" link scrolls to.
const ambiguousQuestionId = (key: string) => "review-q-ambiguous-" + key.replace(/[^a-z0-9]+/gi, "-");
const duplicateQuestionId = (idx: number) => "review-q-duplicate-" + idx;
const totalLineQuestionId = (idx: number) => "review-q-total-" + idx;

const questionGroupTitleClass = "text-xs font-semibold uppercase tracking-wide";

// "Vegas John" / "Vegas John + 2 more cappers".
function capperSummary(cappers: string[]): string {
  if (cappers.length <= 1) return cappers[0] ?? "";
  return cappers[0] + " + " + (cappers.length - 1) + " more capper" + (cappers.length === 2 ? "" : "s");
}

// One question in the "Needs your answer" panel. Focusable so a row's
// "Answer below" link can land on it.
function QuestionItem({ id, text, meta, children }: { id: string; text: string; meta: string; children: ReactNode }) {
  return (
    <li
      id={id}
      tabIndex={-1}
      className="scroll-mt-4 rounded-lg border border-amber-300 bg-card px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-500/40"
    >
      <div className="break-words text-sm font-medium text-foreground">{text}</div>
      <div className="mt-0.5 break-words text-xs text-muted-foreground">{meta}</div>
      {children}
    </li>
  );
}

function StatusBadge({ kind }: { kind: "ready" | "review" | "skipped" }) {
  const styles = {
    ready: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
    review: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
    skipped: "border border-border bg-card text-muted-foreground",
  }[kind];
  return (
    <span className={"rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide " + styles}>{kind}</span>
  );
}

function Chip({ tone, children }: { tone: "green" | "amber"; children: ReactNode }) {
  return (
    <li
      className={
        "rounded-full px-2.5 py-1 text-xs font-semibold " +
        (tone === "green"
          ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300")
      }
    >
      {children}
    </li>
  );
}

// One collapsed "N <why it wasn't imported>" group in the post-import summary.
function ResultGroup({
  items,
  title,
  note,
  mono = false,
}: {
  items: string[];
  title: (count: number) => string;
  note: string;
  mono?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-lg border border-amber-400 bg-amber-50/60 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200">
      <summary className={summaryClass}>{title(items.length)}</summary>
      <div className="px-3 pb-3">
        <p>{note}</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {items.map((item, i) => (
            <li key={i} className={"break-words" + (mono ? " font-mono" : "")}>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
