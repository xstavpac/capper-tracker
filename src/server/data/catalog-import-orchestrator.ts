// Non-interactive catalog import: the browser flow in components/dashboard/bulk-import-form.tsx
// (parse -> recover -> auto-resolve ambiguous teams -> duplicate / missing-total checks -> import),
// run server-side for an explicit userId, with every point where the form would ask the user
// RETURNED as a question instead. Nothing here ever waits on a person.
//
// Held-back rule (matches the form's defaults when a question is never answered): a pick with an
// open question is not imported. A possible duplicate is not a question - the form's default for
// one is "skip", so it is skipped and logged as DUPLICATE_SKIPPED, exactly as the form does.
//
// Not used by the UI. Manual paste still goes through the form + bulkImportPicksAction.
import {
  parseCatalog,
  isPlayerAmbiguityKey,
  withCollegeCandidates,
  type AmbiguousOption,
  type ParsedParlay,
  type ParsedPick,
} from "@/lib/parse-catalog";
import { runAmbiguousHierarchy, type AutoResolveResult } from "@/lib/ambiguous-hierarchy";
import { resolveCapperNameSuggestion } from "@/lib/fuzzy-match";
import { getCapperNameDecisions } from "@/server/data/capper-name-decisions";
import { splitByCapper } from "@/lib/bulk-import-summary";
import {
  importPicksForUser,
  checkDuplicatePicksForUser,
  previewMissingTotalLinesCore,
  type BulkImportItem,
  type BulkImportResult,
} from "@/server/data/bulk-import-core";
import {
  runTeamScheduleCheck,
  runTeamWideScheduleCheck,
  runLeagueActivityCheck,
  runCollegeLineCheck,
  runCapperLeagueHistory,
} from "@/server/data/catalog-disambiguation-checks";
import { recoverUnresolvedPicks } from "@/server/data/recover-unresolved-core";
import { getImportFeedTeams } from "@/server/data/import-feed-teams";
import { getCachedNflRosterFullNames } from "@/server/data/nfl-roster-cache";
import { getCapperRoster } from "@/server/data/capper-roster";
import { recordImportSkippedLines, parseSkippedLineEntries, type SkippedLineEntry } from "@/server/data/import-skipped-lines";

export type CatalogQuestion =
  // "Cardinals - which league?" The form shows `options` (label / sport / nickname) as buttons.
  // `capperSuggestion` is set when the pick's capper name is a near-miss of a saved capper: whoever answers must
  // also settle the capper, because nothing here creates a capper from a near-miss.
  | { type: "AMBIGUOUS_TEAM"; key: string; options: AmbiguousOption[]; pick: ParsedPick; capperSuggestion?: string }
  // "Which player?" - same shape, key built by playerAmbiguityKey.
  | { type: "PLAYER_AMBIGUITY"; key: string; options: AmbiguousOption[]; pick: ParsedPick; capperSuggestion?: string }
  // "No number in this total - use the market line?" The form shows the proposed line.
  | { type: "MISSING_TOTAL_LINE"; pick: ParsedPick; inferredLine: number; reason: "missing" | "garbled" }
  // "Did you mean <existing capper>?" Answers: use the suggestion, or "no, genuinely new".
  | { type: "CAPPER_FUZZY"; rawName: string; suggestion: string; pick: ParsedPick };

export type CatalogImportHooks = {
  // Applied to the parsed picks BEFORE ambiguous teams are auto-resolved (ingest uses it to prefer an allowed league).
  prepareAmbiguous?: (picks: ParsedPick[]) => { keep: ParsedPick[]; skipped: SkippedLineEntry[] };
  // Applied to the raw text before parsing (ingest uses it to drop combined-bet lines).
  preFilterText?: (text: string) => { text: string; skipped: SkippedLineEntry[] };
  // Applied to the picks after ambiguous teams are auto-resolved (ingest uses it for the league allowlist).
  filterPicks?: (picks: ParsedPick[]) => { keep: ParsedPick[]; skipped: SkippedLineEntry[] };
  // The text is a message being imported as it arrives (Telegram ingest): a game already final now - final at the
  // message's time - is never matched (bulk-import-core resolveGameAndOdds). Unset: matching exactly as the form's.
  realTimeIngest?: boolean;
};

export type CatalogImportResult = {
  day: string;
  // null when nothing was left to import (every pick held, skipped or absent).
  importResult: BulkImportResult | null;
  questions: CatalogQuestion[];
  // Lines nothing could place (after the recovery pass) - already written to the skipped-line log.
  unresolvedLines: string[];
  // Picks with no capper header above them: held back, never imported under a placeholder.
  noCapperLines: string[];
  // MLP parlays parsed from the text. NOT imported here (the form imports them via a separate action).
  heldParlays: ParsedParlay[];
  // Possible duplicates auto-skipped (logged as DUPLICATE_SKIPPED).
  duplicatesSkipped: number;
  // Extra skips from the hooks, already logged.
  hookSkipped: number;
};

export function toItem(p: ParsedPick, capperName: string, inferredLine?: number): BulkImportItem {
  return {
    capperName,
    sportName: p.sportName,
    description: p.description,
    betType: p.betType,
    odds: p.odds,
    hasExplicitOdds: p.hasExplicitOdds,
    totalSide: p.totalSide,
    teamNicknames: p.teamNicknames,
    units: p.units,
    period: p.period,
    inferredLine,
    gameNumber: p.gameNumber,
    raw: p.raw,
    overrideDuplicate: false,
  };
}

// The server-side twin of autoResolveAmbiguousPicks (lib/resolve-ambiguous-catalog.ts), which wires
// the same hierarchy to the session-checked actions.
export function autoResolveAmbiguousPicksForServer(
  picks: ParsedPick[],
  priorChoices: Record<string, AmbiguousOption> = {},
  userId?: string
): Promise<AutoResolveResult> {
  return runAmbiguousHierarchy(picks, priorChoices, {
    runScheduleCheck: runTeamScheduleCheck,
    runWideScheduleCheck: runTeamWideScheduleCheck,
    runLeagueActivityCheck: (sports, referenceDate) => runLeagueActivityCheck(sports, referenceDate.toISOString()),
    runCollegeLineCheck,
    // Without a user there is no history to read.
    ...(userId ? { getCapperLeagueHistory: (names: string[]) => runCapperLeagueHistory(userId, names) } : {}),
  });
}

// `day` (YYYY-MM-DD) is carried through for the caller. Game matching itself is unchanged from the
// form: it reads the live schedule / odds feeds as of now.
export async function runCatalogImportForUser(
  userId: string,
  text: string,
  day: string,
  hooks: CatalogImportHooks = {}
): Promise<CatalogImportResult> {
  const hookSkippedLog: SkippedLineEntry[] = [];
  let parseText = text;
  if (hooks.preFilterText) {
    const pre = hooks.preFilterText(text);
    parseText = pre.text;
    hookSkippedLog.push(...pre.skipped);
  }

  const [rosterFullNames, feedTeams, roster, nameDecisions] = await Promise.all([
    getCachedNflRosterFullNames().catch(() => undefined),
    getImportFeedTeams().catch(() => undefined),
    getCapperRoster(userId),
    getCapperNameDecisions(userId),
  ]);
  const existingCapperNames = roster.map((c) => c.name);

  const { picks: parsedPicks, parlays, unresolved, unresolvedCapperNames, droppedAsHeaders } = parseCatalog(
    parseText,
    existingCapperNames,
    rosterFullNames,
    feedTeams
  );

  // Recovery pass, as the form runs it.
  let effective = parsedPicks;
  let unresolvedAfter = unresolved;
  let reasons: Record<string, string> = {};
  let recoveryRan = true;
  if (unresolved.length > 0) {
    try {
      const res = await recoverUnresolvedPicks(parseText, existingCapperNames);
      effective = [...parsedPicks, ...res.recovered];
      unresolvedAfter = res.stillUnresolved;
      reasons = res.reasons;
    } catch {
      recoveryRan = false;
    }
  }
  const capperForUnresolved = new Map<string, string>();
  unresolved.forEach((line, i) => {
    if (!capperForUnresolved.has(line)) capperForUnresolved.set(line, unresolvedCapperNames[i] ?? "");
  });
  const parseLog = parseSkippedLineEntries({
    silent: droppedAsHeaders.map((l) => ({ ...l, reason: "Read as a capper header but looks like a pick" })),
    unresolved: unresolvedAfter.map((t) => ({ text: t, capperName: capperForUnresolved.get(t) ?? "", reason: reasons[t] })),
    recoveryRan,
  });

  const parlaySplit = splitByCapper(parlays);
  const pickSplit = splitByCapper(effective);
  let toResolve = pickSplit.withCapper;
  if (hooks.prepareAmbiguous) {
    // Before the hook, so a shared school is a question the hook can answer: with both
    // NCAAF and NCAAB allowed it stays a question (the hierarchy below settles it, or the
    // review queue holds it); an allowlist that leaves one out narrows it to the other.
    const prep = hooks.prepareAmbiguous(withCollegeCandidates(toResolve));
    toResolve = prep.keep;
    hookSkippedLog.push(...prep.skipped);
  }
  const resolved = await autoResolveAmbiguousPicksForServer(toResolve, {}, userId);
  // A pair the user already answered is not asked again (SAME files it under the saved capper, DIFFERENT keeps
  // the typed name as its own capper); a pair never answered is always a question, never resolved here.
  const fuzzySuggestion = (name: string): string | undefined => {
    const r = resolveCapperNameSuggestion(name, existingCapperNames, nameDecisions);
    return r.suggestion && !r.remembered ? r.suggestion : undefined;
  };

  const questions: CatalogQuestion[] = [];
  let candidates: ParsedPick[] = [];
  for (const p of resolved.picks) {
    // Answered as a sport its "1P"/"2P"/"3P" can't belong to (see
    // periodShorthandOutsideNhl): an unresolved line, never an import.
    if (p.unresolvedReason) {
      unresolvedAfter = [...unresolvedAfter, p.raw];
      hookSkippedLog.push({ stage: "RECOVERY_UNRESOLVED", capperName: p.capperName, rawText: p.raw, guessedSport: p.sportName, reason: p.unresolvedReason });
      continue;
    }
    if (p.ambiguous && p.ambiguousKey) {
      questions.push({
        type: isPlayerAmbiguityKey(p.ambiguousKey) ? "PLAYER_AMBIGUITY" : "AMBIGUOUS_TEAM",
        key: p.ambiguousKey,
        options: p.ambiguous,
        pick: p,
        capperSuggestion: fuzzySuggestion(p.capperName),
      });
    } else candidates.push(p);
  }

  if (hooks.filterPicks) {
    const f = hooks.filterPicks(candidates);
    candidates = f.keep;
    hookSkippedLog.push(...f.skipped);
  }

  // Capper near-miss: the form asks "did you mean X?" for any name that is not an exact (case-insensitive)
  // match of a saved capper but is close to one. Held here, never auto-resolved either way.
  const afterFuzzy: ParsedPick[] = [];
  for (let p of candidates) {
    const remembered = resolveCapperNameSuggestion(p.capperName, existingCapperNames, nameDecisions);
    if (remembered.suggestion && remembered.remembered === "SAME") p = { ...p, capperName: remembered.suggestion };
    const suggestion = fuzzySuggestion(p.capperName);
    if (suggestion) {
      questions.push({ type: "CAPPER_FUZZY", rawName: p.capperName, suggestion, pick: p });
      continue;
    }
    afterFuzzy.push(p);
  }

  // Duplicate check (skip by default) and missing-total-line check (held by default).
  const dupItems = afterFuzzy.map((p) => ({ ...toItem(p, p.capperName), period: p.period }));
  const flags = dupItems.length > 0 ? await checkDuplicatePicksForUser(userId, dupItems) : {};
  const totalFlags = afterFuzzy.length > 0 ? await previewMissingTotalLinesCore(afterFuzzy.map((p) => toItem(p, p.capperName))) : {};

  const toImport: BulkImportItem[] = [];
  const skippedDuplicates: { capperName: string; sportName: string; raw: string }[] = [];
  afterFuzzy.forEach((p, i) => {
    if (flags[i]) {
      skippedDuplicates.push({ capperName: p.capperName, sportName: p.sportName, raw: p.raw });
    } else if (totalFlags[i]) {
      questions.push({ type: "MISSING_TOTAL_LINE", pick: p, inferredLine: totalFlags[i].inferredLine, reason: totalFlags[i].reason });
    } else {
      toImport.push(toItem(p, p.capperName));
    }
  });

  // Logged once, in one batch, like the form (parse-time log) plus the hook skips.
  await recordImportSkippedLines(userId, [...parseLog, ...hookSkippedLog]);

  const ambiguityLog = resolved.logs.map((l) => ({ key: l.ambiguousName, sport: l.resolvedSport, method: l.method, count: l.pickCount }));
  const importResult =
    toImport.length > 0 || skippedDuplicates.length > 0
      ? await importPicksForUser(userId, toImport, skippedDuplicates, ambiguityLog, { realTimeIngest: hooks.realTimeIngest === true })
      : null;

  return {
    day,
    importResult,
    questions,
    unresolvedLines: unresolvedAfter,
    noCapperLines: [...pickSplit.noCapper, ...parlaySplit.noCapper],
    heldParlays: parlaySplit.withCapper,
    duplicatesSkipped: skippedDuplicates.length,
    hookSkipped: hookSkippedLog.length,
  };
}
