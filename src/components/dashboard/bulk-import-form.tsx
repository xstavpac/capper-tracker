"use client";

import { useEffect, useRef, useState } from "react";
import { parseCatalog, resolveAmbiguousPick, type AmbiguousOption, type ParsedPick } from "@/lib/parse-catalog";
import { autoResolveAmbiguousPicks } from "@/lib/resolve-ambiguous-catalog";
import {
  bulkImportPicksAction,
  previewBulkImportOdds,
  checkDuplicatePicksAction,
  previewMissingTotalLines,
  type MissingTotalLineResult,
} from "@/server/actions/bulk-picks";
import { dropCatalogButtonClass, LightningIcon } from "@/components/dashboard/drop-catalog-button";
import { findClosestFuzzyMatch } from "@/lib/fuzzy-match";

// Sentinel stored in capperFuzzyChoices when the user explicitly confirms a
// name really is a new capper, not a typo of an existing one - distinct from
// "not yet decided" (absent from the map), which is what keeps the
// suggestion prompt showing.
const CONFIRMED_NEW = "__new__";

const CAPPER_ACCENTS = [
  "border-l-sky-400",
  "border-l-emerald-400",
  "border-l-amber-400",
  "border-l-fuchsia-400",
  "border-l-rose-400",
  "border-l-indigo-400",
  "border-l-teal-400",
  "border-l-orange-400",
];

export function BulkImportForm({ existingCapperNames }: { existingCapperNames: string[] }) {
  const [showTips, setShowTips] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPick[] | null>(null);
  // Lines that looked pick-shaped but couldn't be resolved to any sport/team/
  // player (see parseCatalog's `unresolved` return value) - shown so the user
  // can add them manually instead of them either vanishing or, worse, being
  // silently misread as a capper name that then swallows every real pick
  // after it.
  const [unresolvedLines, setUnresolvedLines] = useState<string[]>([]);
  const [enrichedOdds, setEnrichedOdds] = useState<Record<number, number>>({});
  const [loadingOdds, setLoadingOdds] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    errors: string[];
    unmatchedGames: string[];
    pickLimitBlocked?: { message: string; remaining: number };
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

  // Scrolls the results section into view right after a fresh Drop Catalog
  // parse - on mobile especially, the example image between the form and the
  // results pushes them far enough below the fold that clicking "Drop
  // Catalog" could look like nothing happened at all. Keyed on its own
  // counter (bumped once per handleParse call) rather than on `parsed`
  // itself, since `parsed` also updates later from unrelated interactions
  // (resolving an ambiguous team, confirming a fuzzy capper match) that
  // shouldn't yank the user's scroll position back down every time.
  const resultsRef = useRef<HTMLDivElement>(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  useEffect(() => {
    if (scrollTrigger > 0) {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollTrigger]);

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
    setDuplicateFlags({});
    setDuplicateChoices({});
    setTotalLineFlags({});
    setTotalLineChoices({});
    setResolving(true);
    const { picks: items, unresolved } = parseCatalog(text, existingCapperNames);
    setUnresolvedLines(unresolved);
    const outcome = await autoResolveAmbiguousPicks(items, ambiguousChoices);
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
    checkDuplicatesFor(resolvedEntries);
    checkTotalLinesFor(resolvedEntries);
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
    previewBulkImportOdds(
      entries.map((e) => ({
        sportName: e.p.sportName,
        betType: e.p.betType,
        hasExplicitOdds: e.p.hasExplicitOdds,
        odds: e.p.odds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
      }))
    )
      .then((odds) => {
        setEnrichedOdds((prev) => {
          const next = { ...prev };
          for (const [posKey, value] of Object.entries(odds)) {
            const globalIdx = entries[Number(posKey)]?.idx;
            if (globalIdx !== undefined) next[globalIdx] = value;
          }
          return next;
        });
      })
      .finally(() => setLoadingOdds(false));
  }

  // Checks each entry against this user's already-logged picks for the same
  // capper + game + bet type/side (see checkDuplicatePicksAction for the
  // exact definition). Needs the resolved capper name, so this is re-run
  // whenever a fuzzy-match choice is confirmed, not just once at parse time -
  // duplicate detection can only match an existing capper once we know which
  // saved capper this pick's name actually refers to. Same index-remapping
  // as fetchOddsFor: results come back keyed by position within `entries`,
  // remapped here to each pick's real position in `parsed`.
  function checkDuplicatesFor(entries: { p: ParsedPick; idx: number }[]) {
    if (entries.length === 0) return;
    checkDuplicatePicksAction(
      entries.map((e) => ({
        capperName: resolvedCapperName(e.p.capperName),
        sportName: e.p.sportName,
        betType: e.p.betType,
        odds: e.p.odds,
        hasExplicitOdds: e.p.hasExplicitOdds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
        isFirstFive: e.p.isFirstFive,
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
    });
  }

  // Flags TOTAL picks with no parseable number in their own text and shows
  // the real market line found for that specific game - same index-remapping
  // as fetchOddsFor/checkDuplicatesFor. Server-side (previewMissingTotalLines)
  // already skips anything with a real number already present, so this never
  // second-guesses a capper's own (possibly alternate) line.
  function checkTotalLinesFor(entries: { p: ParsedPick; idx: number }[]) {
    if (entries.length === 0) return;
    previewMissingTotalLines(
      entries.map((e) => ({
        sportName: e.p.sportName,
        betType: e.p.betType,
        hasExplicitOdds: e.p.hasExplicitOdds,
        odds: e.p.odds,
        totalSide: e.p.totalSide,
        teamNicknames: e.p.teamNicknames,
        description: e.p.description,
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
  const ambiguousPicks = ambiguousEntries.map((e) => e.p);

  // A flagged duplicate is excluded from the import by default - "Skip" just
  // confirms that exclusion explicitly, "Import anyway" is the only way back
  // in. Every other valid pick imports normally, same as before this feature
  // existed - only the flagged ones ever need a decision.
  function isPendingOrSkippedDuplicate(idx: number): boolean {
    return Boolean(duplicateFlags[idx]) && duplicateChoices[idx] !== "import";
  }
  // Same default-excluded-until-confirmed shape as duplicates - a flagged
  // auto-filled total line never imports until the user explicitly confirms
  // it (or explicitly skips the pick instead).
  function isPendingOrRejectedTotalLine(idx: number): boolean {
    return Boolean(totalLineFlags[idx]) && totalLineChoices[idx] !== "confirm";
  }
  const includedEntries = validEntries.filter(
    (e) => !isPendingOrSkippedDuplicate(e.idx) && !isPendingOrRejectedTotalLine(e.idx)
  );
  const includedPicks = includedEntries.map((e) => e.p);
  const unresolvedDuplicateCount = validEntries.filter(
    (e) => duplicateFlags[e.idx] && duplicateChoices[e.idx] === undefined
  ).length;
  const unresolvedTotalLineCount = validEntries.filter(
    (e) => totalLineFlags[e.idx] && totalLineChoices[e.idx] === undefined
  ).length;

  // One prompt per unique ambiguous team name in this paste, not per pick -
  // groups every entry sharing an ambiguousKey (e.g. every "Cardinals" pick)
  // behind a single question with a count, instead of asking 12 times.
  const ambiguousGroups: { key: string; options: AmbiguousOption[]; sampleRaw: string; count: number }[] = [];
  {
    const byKey = new Map<string, { options: AmbiguousOption[]; sampleRaw: string; count: number }>();
    for (const { p } of ambiguousEntries) {
      const key = p.ambiguousKey!;
      const existing = byKey.get(key);
      if (existing) existing.count += 1;
      else byKey.set(key, { options: p.ambiguous!, sampleRaw: p.raw, count: 1 });
    }
    for (const [key, v] of byKey.entries()) ambiguousGroups.push({ key, ...v });
  }

  // One prompt per distinct raw capper name in this paste, not per pick row -
  // asking "did you mean X?" once per capper, even if they posted 10 picks.
  const pendingFuzzySuggestions = Array.from(new Set(validPicks.map((p) => p.capperName)))
    .filter((name) => !(name in capperFuzzyChoices))
    .map((name) => ({ name, suggestion: fuzzySuggestionFor(name) }))
    .filter((e): e is { name: string; suggestion: string } => e.suggestion !== null);

  const capperAccent = new Map<string, string>();
  for (const p of validPicks) {
    const resolved = resolvedCapperName(p.capperName);
    if (!capperAccent.has(resolved)) {
      capperAccent.set(resolved, CAPPER_ACCENTS[capperAccent.size % CAPPER_ACCENTS.length]);
    }
  }

  async function handleImport() {
    if (includedPicks.length === 0) return;
    setImporting(true);
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
        isFirstFive: p.isFirstFive,
        inferredLine: totalLineChoices[idx] === "confirm" ? totalLineFlags[idx]?.inferredLine : undefined,
      }))
    );
    setImporting(false);
    if (res.success) {
      setResult({
        imported: res.imported,
        skipped: res.skipped,
        errors: res.errors,
        unmatchedGames: res.unmatchedGames,
        pickLimitBlocked: res.pickLimitBlocked,
      });
      // Blocked by the pick limit means nothing was imported - keep the
      // pasted text and preview in place so upgrading and retrying doesn't
      // require re-pasting the whole catalog.
      if (!res.pickLimitBlocked) {
        setParsed(null);
        setUnresolvedLines([]);
        setText("");
      }
    }
  }

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <h3 className="mb-1 text-sm font-medium text-foreground">Betting Catalog Import</h3>
      <p className="mb-2 text-xs text-muted-foreground">Paste capper names and picks below - we&apos;ll detect the rest.</p>

      <button
        type="button"
        onClick={() => setShowTips((v) => !v)}
        className="mb-3 flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <span className={"inline-block transition-transform " + (showTips ? "rotate-90" : "")}>&rsaquo;</span>
        Formatting tips
      </button>
      {showTips && (
        <p className="mb-3 text-xs text-muted-foreground">
          Capper name lines followed by their picks - we auto-detect sport, bet type, odds, and
          units for each pick. Leave a blank line between different cappers&apos; picks. Cappers
          already in your saved list are recognized automatically, even if their name contains a
          team name. For a brand-new capper whose name happens to collide with a team name (e.g.
          &quot;Tigers Fan Picks&quot;), prefix it with * the first time, e.g. &quot;*Tigers Fan
          Picks&quot;, so it&apos;s read as a name instead of a pick.
        </p>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder={
          "Vegas John\nCubs moneyline\nWhite Sox -1.5\n\nHigh Roller Hank\nYankees ML\nDodgers under 8.5"
        }
        className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground focus:border-brand-400 focus:outline-none"
      />

      <button onClick={handleParse} disabled={!text.trim() || resolving} className={"mt-3 " + dropCatalogButtonClass}>
        <LightningIcon />
        {resolving ? "Resolving..." : "Drop Catalog"}
      </button>

      <div className="mt-3 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-[13px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
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
        <span>Once your catalog is loaded, you&apos;ll find the picks on the Live tab, grouped under their respective games.</span>
      </div>

      <div className="mt-4 max-w-[260px]">
        <img
          src="/example-picks.png"
          alt="Example of picks grouped by game on the Live tab"
          className="h-auto w-full rounded-lg border border-border"
        />
      </div>

      {parsed && (
        <div ref={resultsRef} className="mt-4">
          <div className="mb-2 text-sm font-medium text-muted-foreground">
            {validPicks.length} pick{validPicks.length === 1 ? "" : "s"} found
            {ambiguousPicks.length > 0 &&
              " - " + ambiguousPicks.length + " need clarification"}
            {unresolvedDuplicateCount > 0 &&
              " - " + unresolvedDuplicateCount + " flagged as possible duplicate" + (unresolvedDuplicateCount === 1 ? "" : "s")}
            {unresolvedTotalLineCount > 0 &&
              " - " + unresolvedTotalLineCount + " missing a total number" + (unresolvedTotalLineCount === 1 ? "" : "s")}
            {unresolvedLines.length > 0 &&
              " - " + unresolvedLines.length + " line" + (unresolvedLines.length === 1 ? "" : "s") + " couldn't be identified"}
            {loadingOdds && <span className="ml-2 font-normal text-muted-foreground">Looking up real odds...</span>}
          </div>

          {unresolvedLines.length > 0 && (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <div className="font-medium">
                {unresolvedLines.length} line{unresolvedLines.length === 1 ? "" : "s"} looked like{" "}
                {unresolvedLines.length === 1 ? "a pick" : "picks"} but couldn&apos;t be matched to a
                sport or team - not imported and not attributed to any capper. Add these manually:
              </div>
              <ul className="mt-1 list-disc pl-4">
                {unresolvedLines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          {ambiguousGroups.length > 0 && (
            <div className="mb-3 space-y-2">
              {ambiguousGroups.map(({ key, options, sampleRaw, count }) => (
                <div key={"amb-" + key} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  <div className="font-medium">
                    "{sampleRaw}"{count > 1 && " (+" + (count - 1) + " more " + key + " pick" + (count - 1 === 1 ? "" : "s") + " in this paste)"}
                  </div>
                  <div className="mt-0.5">Ambiguous team - could mean {options.map((o) => o.label).join(" or ")}.</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => resolveAmbiguousGroup(key, opt)}
                        className="rounded-full border border-amber-300 bg-card px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-amber-600 dark:text-amber-400">
                    {count > 1
                      ? "Answering once resolves every " + key + " pick in this paste."
                      : "Or edit the text above to specify the city, then preview again."}
                  </div>
                </div>
              ))}
            </div>
          )}

          {pendingFuzzySuggestions.length > 0 && (
            <div className="mb-3 space-y-2">
              {pendingFuzzySuggestions.map(({ name, suggestion }) => (
                <div key={"fuzzy-" + name} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  <div className="font-medium">"{name}" isn&apos;t an exact match for any saved capper.</div>
                  <div className="mt-0.5">
                    Did you mean <span className="font-medium">{suggestion}</span>?
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCapperFuzzyChoices((prev) => ({ ...prev, [name]: suggestion }));
                        checkDuplicatesFor(validEntries.filter((e) => e.p.capperName === name));
                      }}
                      className="rounded-full border border-amber-300 bg-card px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                    >
                      Yes, same as {suggestion}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCapperFuzzyChoices((prev) => ({ ...prev, [name]: CONFIRMED_NEW }));
                        checkDuplicatesFor(validEntries.filter((e) => e.p.capperName === name));
                      }}
                      className="rounded-full border border-amber-300 bg-card px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                    >
                      No, "{name}" is a different capper
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto rounded-lg border border-border-subtle">
            <div>
              {validEntries.map(({ p, idx }, i) => {
                const realOdds = enrichedOdds[idx];
                const displayOdds = realOdds ?? p.odds;
                const resolvedName = resolvedCapperName(p.capperName);
                const wasFuzzyMatched = resolvedName !== p.capperName;
                // A heavier divider below the last pick in each capper's group (not
                // between every pick) - the color accent alone was easy to miss at a
                // glance in a large catalog, this makes the group boundary itself clear.
                const isGroupEnd =
                  validEntries[i + 1] && resolvedCapperName(validEntries[i + 1].p.capperName) !== resolvedName;
                const dupFlag = duplicateFlags[idx];
                const dupChoice = duplicateChoices[idx];
                const totalFlag = totalLineFlags[idx];
                const totalChoice = totalLineChoices[idx];
                const excluded = isPendingOrSkippedDuplicate(idx) || isPendingOrRejectedTotalLine(idx);
                return (
                  <div
                    key={idx}
                    className={
                      // Explicit per-row bottom border instead of the parent's divide-y utility -
                      // divide-y sets the border-color shorthand (all 4 sides) on every row but the
                      // first, which was silently stomping this per-capper border-l accent color.
                      "border-l-4 px-3 py-2 text-xs last:border-b-0 " +
                      (isGroupEnd ? "border-b-2 border-b-border" : "border-b border-b-border-subtle") +
                      " " +
                      capperAccent.get(resolvedName) +
                      (excluded ? " opacity-50" : "")
                    }
                  >
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                      <div className="min-w-0">
                        <span className="font-medium">{resolvedName}</span>
                        {wasFuzzyMatched && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                            matched from "{p.capperName}"
                          </span>
                        )}
                        {!wasFuzzyMatched && !existingLower.includes(p.capperName.toLowerCase()) && (
                          <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
                            new
                          </span>
                        )}
                        <span className="ml-2 text-muted-foreground">
                          {p.sportName} - {p.description}
                        </span>
                      </div>
                      <div className="text-muted-foreground sm:shrink-0">
                        {p.betType} - {displayOdds > 0 ? "+" : ""}
                        {displayOdds}
                        {realOdds !== undefined && <span className="ml-1 text-emerald-600 dark:text-emerald-400">(real)</span>}
                        {" - " + p.units + "u"}
                      </div>
                    </div>
                    {dupFlag && (
                      <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                        <div>Possible duplicate: {dupFlag.message}</div>
                        {dupChoice === undefined && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "skip" }))}
                              className="rounded-full border border-amber-300 bg-card px-2 py-0.5 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                            >
                              Skip this pick
                            </button>
                            <button
                              type="button"
                              onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "import" }))}
                              className="rounded-full border border-amber-300 bg-card px-2 py-0.5 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                            >
                              Import anyway
                            </button>
                          </div>
                        )}
                        {dupChoice === "skip" && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                            <span className="font-medium">Skipped - won&apos;t be imported.</span>
                            <button
                              type="button"
                              onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "import" }))}
                              className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
                            >
                              Import anyway
                            </button>
                          </div>
                        )}
                        {dupChoice === "import" && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                            <span className="font-medium">Will import despite the duplicate.</span>
                            <button
                              type="button"
                              onClick={() => setDuplicateChoices((prev) => ({ ...prev, [idx]: "skip" }))}
                              className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
                            >
                              Skip instead
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {totalFlag && (
                      <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                        <div>
                          {totalFlag.reason === "missing"
                            ? "No number found in this pick's text."
                            : "Couldn't read a valid number in this pick's text."}{" "}
                          Today&apos;s market total for this game is{" "}
                          <span className="font-medium">{totalFlag.inferredLine}</span>.
                        </div>
                        {totalChoice === undefined && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "confirm" }))}
                              className="rounded-full border border-amber-300 bg-card px-2 py-0.5 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                            >
                              Use {totalFlag.inferredLine}
                            </button>
                            <button
                              type="button"
                              onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "reject" }))}
                              className="rounded-full border border-amber-300 bg-card px-2 py-0.5 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                            >
                              Skip this pick
                            </button>
                          </div>
                        )}
                        {totalChoice === "confirm" && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                            <span className="font-medium">Will import with {totalFlag.inferredLine} filled in.</span>
                            <button
                              type="button"
                              onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "reject" }))}
                              className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
                            >
                              Skip instead
                            </button>
                          </div>
                        )}
                        {totalChoice === "reject" && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                            <span className="font-medium">Skipped - won&apos;t be imported.</span>
                            <button
                              type="button"
                              onClick={() => setTotalLineChoices((prev) => ({ ...prev, [idx]: "confirm" }))}
                              className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
                            >
                              Use {totalFlag.inferredLine} instead
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || includedPicks.length === 0}
            className="mt-3 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
          >
            {importing ? "Importing..." : "Import " + includedPicks.length + " picks"}
          </button>
        </div>
      )}

      {result?.pickLimitBlocked && (
        <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <div className="font-medium">Import paused - Free plan limit reached</div>
          <p className="mt-1">{result.pickLimitBlocked.message}</p>
          <a
            href="/pricing"
            className="mt-2 inline-block rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
          >
            Upgrade to Basic for unlimited picks
          </a>
        </div>
      )}

      {result && !result.pickLimitBlocked && (
        <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          Imported {result.imported} pick{result.imported === 1 ? "" : "s"}.
          {result.skipped > 0 && " " + result.skipped + " skipped."}
          {result.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-red-600 dark:text-red-400">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {result.unmatchedGames.length > 0 && (
            <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Couldn&apos;t match {result.unmatchedGames.length} pick
              {result.unmatchedGames.length === 1 ? "" : "s"} to today&apos;s schedule - they
              were NOT imported. Double-check the matchup and add them manually:
              <ul className="mt-1 list-disc pl-4">
                {result.unmatchedGames.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
