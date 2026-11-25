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
import { normalizeName, resolveCapperNameSuggestion } from "@/lib/fuzzy-match";
import { capperNameJunkReason, findCapperVariant } from "@/lib/capper-name-guard";
import { getCachedNbaRoster } from "@/server/data/nba-roster-cache";
import { getCachedNhlRoster } from "@/server/data/nhl-roster-cache";
import { getCachedMlbRoster } from "@/server/data/mlb-roster-cache";
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
  runTeamInProgressCheck,
  runLeagueActivityCheck,
  runCollegeLineCheck,
  runCapperLeagueHistory,
} from "@/server/data/catalog-disambiguation-checks";
import { recoverUnresolvedPicks } from "@/server/data/recover-unresolved-core";
import { getImportFeedTeams } from "@/server/data/import-feed-teams";
import { getCachedNflRosterFullNames } from "@/server/data/nfl-roster-cache";
import { getCapperRoster } from "@/server/data/capper-roster";
import { recordImportSkippedLines, parseSkippedLineEntries, type SkippedLineEntry } from "@/server/data/import-skipped-lines";
import type { DedupPickRow } from "@/server/data/pick-dedup";
import type { ImportItemOutcome } from "@/server/data/bulk-import-core";
import type { LineOutcome, LineOutcomeListener, LineRejectReason, TokenDayRule } from "@/lib/ingest-line-outcome";

export type CatalogQuestion =
  // "Cardinals - which league?" The form shows `options` (label / sport / nickname) as buttons.
  // `capperSuggestion` is set when the pick's capper name is a near-miss of a saved capper: whoever answers must
  // also settle the capper, because nothing here creates a capper from a near-miss.
  // `newCapper` (guardCapperNames only): the capper is not saved yet, so answering also creates it - the choices say so.
  | { type: "AMBIGUOUS_TEAM"; key: string; options: AmbiguousOption[]; pick: ParsedPick; capperSuggestion?: string; newCapper?: boolean }
  // "Which player?" - same shape, key built by playerAmbiguityKey.
  | { type: "PLAYER_AMBIGUITY"; key: string; options: AmbiguousOption[]; pick: ParsedPick; capperSuggestion?: string; newCapper?: boolean }
  // "No number in this total - use the market line?" The form shows the proposed line.
  | { type: "MISSING_TOTAL_LINE"; pick: ParsedPick; inferredLine: number; reason: "missing" | "garbled" }
  // "Did you mean <existing capper>?" Answers: use the suggestion, or "no, genuinely new".
  | { type: "CAPPER_FUZZY"; rawName: string; suggestion: string; pick: ParsedPick }
  // "<name> is not a saved capper - create it?" (guardCapperNames only). One answer: create the capper and log the
  // pick. Stored as a CAPPER_FUZZY review item with only the "new-capper" choice, so no schema change.
  | { type: "NEW_CAPPER"; rawName: string; pick: ParsedPick }
  // "Game is 3 days away - is this the right game?" Fully matched and priced (row): a yes saves it as is. Raised only
  // by the import itself (importPicksForUser's holdFarFuture).
  | { type: "FAR_FUTURE_GAME"; pick: ParsedPick; row: DedupPickRow };

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
  // The four below are the bot API's (API_TOKEN batches, ingest-batch.ts). Telegram and the form leave them unset, so
  // their imports run exactly as before.
  // The bot API's day rule for game matching (bulk-import-core resolveGameAndOdds).
  dayRule?: TokenDayRule;
  // The imported picks are not copied to the user's active pick recipients (importPicksForUser).
  skipRecipientFanOut?: boolean;
  // The same line (same capper, same text) twice in one batch: the second is skipped as duplicate_in_request.
  rejectRepeatedLines?: boolean;
  // Called once for every pick line, with what became of it: accepted (inserted), needs_review (a question was
  // raised - the line's review item), or rejected (skipped, refused or held for a reason nobody chose). A capper
  // header gets none - unless it looks like a pick (then: rejected, unparseable). Synchronous; it must not throw.
  // Order: not line order. But for one capper and line text, outcomes arrive in the order those lines appear (with
  // rejectRepeatedLines, every repeat is reported after the first copy's outcome), so a caller can match outcomes to
  // its lines by (capperName, raw) in order.
  onLineOutcome?: LineOutcomeListener;
  // The automated paths' capper-name guard (lib/capper-name-guard.ts): a header that is clearly not a capper (a
  // number, bet syntax, a team, a roster player, promo text) is skipped and the header above it stays active; an
  // obvious variant of one saved capper is filed under it; and a name that is still unknown is never created here:
  // its picks go to the review queue with a one-click "create capper". Unset (the form): exactly as before.
  guardCapperNames?: boolean;
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

// The skipped-line stages a hook or the parser reports, as the bot API's rejection reasons.
const STAGE_REASON: Partial<Record<SkippedLineEntry["stage"], LineRejectReason>> = {
  COMBINED_BET: "combined_pick",
  LEAGUE_NOT_ALLOWED: "league_not_allowed",
  PARSE_SILENT: "unparseable",
  PARSE_UNRESOLVED: "unparseable",
  RECOVERY_UNRESOLVED: "unparseable",
  PROP_UNSUPPORTED: "unparseable",
  DUPLICATE_SKIPPED: "duplicate",
};

// The needs_review outcome for a question (its index in the result's questions). The candidates' games are filled in
// by the caller that drafts the review items (ingest-batch.ts), which matches each answer to its game.
function reviewOutcome(q: CatalogQuestion, questionIndex: number): LineOutcome {
  const base = { status: "needs_review" as const, questionIndex };
  switch (q.type) {
    case "AMBIGUOUS_TEAM":
    case "PLAYER_AMBIGUITY":
      return {
        ...base,
        capperName: q.pick.capperName,
        reason: q.type === "AMBIGUOUS_TEAM" ? "ambiguous_team" : "ambiguous_player",
        candidates: q.options.map((o) => ({ label: o.label, league: o.sport, game: null })),
      };
    case "MISSING_TOTAL_LINE":
      return {
        ...base,
        capperName: q.pick.capperName,
        reason: "missing_total_line",
        candidates: [{ label: `Use the market line ${q.inferredLine}`, league: q.pick.sportName, game: null }],
      };
    case "CAPPER_FUZZY":
      return {
        ...base,
        capperName: q.pick.capperName,
        reason: "capper_name",
        candidates: [
          { label: `Use existing capper "${q.suggestion}"`, league: q.pick.sportName, game: null },
          { label: `New capper "${q.rawName}"`, league: q.pick.sportName, game: null },
        ],
      };
    case "NEW_CAPPER":
      return {
        ...base,
        capperName: q.pick.capperName,
        reason: "capper_name",
        candidates: [{ label: `New capper "${q.rawName}"`, league: q.pick.sportName, game: null }],
      };
    case "FAR_FUTURE_GAME":
      return {
        ...base,
        capperName: q.row.capperName,
        reason: "far_future_game",
        candidates: [
          {
            label: `${q.row.awayTeam} @ ${q.row.homeTeam}`,
            league: q.row.sportName,
            game: { away: q.row.awayTeam, home: q.row.homeTeam, startsAt: q.row.gameTime.toISOString() },
          },
        ],
      };
  }
}

function itemOutcome(p: ParsedPick, o: ImportItemOutcome): LineOutcome {
  if (o.status === "refused")
    return { status: "rejected", capperName: p.capperName, reason: o.reason, ...(o.detail ? { detail: o.detail } : {}), ...(p.sportName ? { league: p.sportName } : {}) };
  const row = o.row;
  return {
    status: "accepted",
    capperName: row.capperName,
    league: row.sportName,
    game: o.gameMatched ? { away: row.awayTeam, home: row.homeTeam, startsAt: row.gameTime.toISOString() } : null,
    market: row.betType,
    period: row.period ?? "FULL_GAME",
    line: row.line ?? null,
    odds: row.odds,
    pickId: o.pickId,
  };
}

// Roster players' full names for the capper-name guard (NBA, NHL, MLB; NFL comes from the import's own read). A
// roster that fails to load only narrows the check.
async function loadGuardPlayerNames(): Promise<string[]> {
  const lists = await Promise.all([
    getCachedNbaRoster().catch(() => []),
    getCachedNhlRoster().catch(() => []),
    getCachedMlbRoster().catch(() => []),
  ]);
  return lists.flat().map((p) => p.playerName);
}

// The key two lines must share to be "the same line" (rejectRepeatedLines): capper and text, case and spacing aside.
const repeatKey = (p: ParsedPick) => p.capperName.trim().toLowerCase() + "\n" + p.raw.trim().replace(/\s+/g, " ").toLowerCase();

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
    runInProgressCheck: runTeamInProgressCheck,
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
  const emit = (raw: string, outcome: LineOutcome) => hooks.onLineOutcome?.(raw, outcome);
  const rejectEntries = (entries: SkippedLineEntry[]) => {
    if (!hooks.onLineOutcome) return;
    for (const e of entries) {
      emit(e.rawText, { status: "rejected", capperName: e.capperName, reason: STAGE_REASON[e.stage] ?? "error", ...(e.reason ? { detail: e.reason } : {}) });
    }
  };
  let parseText = text;
  if (hooks.preFilterText) {
    const pre = hooks.preFilterText(text);
    parseText = pre.text;
    hookSkippedLog.push(...pre.skipped);
    rejectEntries(pre.skipped);
  }

  const guard = hooks.guardCapperNames === true;
  const [rosterFullNames, feedTeams, roster, nameDecisions, otherPlayerNames] = await Promise.all([
    getCachedNflRosterFullNames().catch(() => undefined),
    getImportFeedTeams().catch(() => undefined),
    getCapperRoster(userId),
    getCapperNameDecisions(userId),
    // The guard's player check. Each is the shared day-long roster cache (no per-call DB read on a warm cache).
    guard ? loadGuardPlayerNames() : Promise.resolve([] as string[]),
  ]);
  const existingCapperNames = roster.map((c) => c.name);
  const savedKeys = new Set(existingCapperNames.map(normalizeName).filter((k) => k !== ""));
  const isSaved = (name: string) => savedKeys.has(normalizeName(name)) && normalizeName(name) !== "";
  const playerKeys = guard ? new Set([...(rosterFullNames ?? []), ...otherPlayerNames].map(normalizeName).filter((k) => k !== "")) : undefined;
  const acceptNewHeader = (name: string): boolean => capperNameJunkReason(name, { feedTeams, playerKeys }) === null;

  const { picks: parsedPicks, parlays, unresolved, unresolvedCapperNames, droppedAsHeaders, rejectedHeaders } = parseCatalog(
    parseText,
    existingCapperNames,
    rosterFullNames,
    feedTeams,
    guard ? { acceptNewHeader } : undefined
  );
  for (const h of rejectedHeaders) {
    hookSkippedLog.push({
      stage: "PARSE_SILENT",
      capperName: h.capperName,
      rawText: h.text,
      reason: `Not a capper name (${capperNameJunkReason(h.text, { feedTeams, playerKeys }) ?? "not a person or brand"}); kept the capper above it`,
    });
  }

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
  rejectEntries(parseLog);

  // An obvious variant of exactly one saved capper is filed under it ("DIRTY BUBBLE" -> DirtyBubbleBets).
  if (guard) {
    const variantOf = new Map<string, string | null>();
    const canonical = (name: string): string => {
      if (!name || isSaved(name)) return name;
      if (!variantOf.has(name)) {
        // A pair the user already answered SAME wins; then the variant rules.
        const remembered = resolveCapperNameSuggestion(name, existingCapperNames, nameDecisions);
        const same = remembered.suggestion && remembered.remembered === "SAME" ? remembered.suggestion : null;
        variantOf.set(name, same ?? findCapperVariant(name, existingCapperNames, nameDecisions));
      }
      return variantOf.get(name) ?? name;
    };
    effective = effective.map((p) => {
      const c = canonical(p.capperName);
      return c === p.capperName ? p : { ...p, capperName: c };
    });
  }

  const parlaySplit = splitByCapper(parlays);
  const pickSplit = splitByCapper(effective);
  if (hooks.onLineOutcome) {
    for (const raw of [...pickSplit.noCapper, ...parlaySplit.noCapper]) emit(raw, { status: "rejected", capperName: "", reason: "no_capper" });
    for (const p of parlaySplit.withCapper) emit(p.raw, { status: "rejected", capperName: p.capperName, reason: "parlay_not_supported" });
  }
  let toResolve = pickSplit.withCapper;
  // Reported last (below), so the first copy's outcome always comes before its repeats': for one capper and line
  // text, outcomes arrive in the order the lines appear.
  const repeated: ParsedPick[] = [];
  if (hooks.rejectRepeatedLines) {
    const seen = new Set<string>();
    toResolve = toResolve.filter((p) => {
      const key = repeatKey(p);
      if (!seen.has(key)) {
        seen.add(key);
        return true;
      }
      hookSkippedLog.push({ stage: "DUPLICATE_SKIPPED", capperName: p.capperName, rawText: p.raw, guessedSport: p.sportName, reason: "The same line twice in one request" });
      repeated.push(p);
      return false;
    });
  }
  if (hooks.prepareAmbiguous) {
    // Before the hook, so a shared school is a question the hook can answer: with both
    // NCAAF and NCAAB allowed it stays a question (the hierarchy below settles it, or the
    // review queue holds it); an allowlist that leaves one out narrows it to the other.
    const prep = hooks.prepareAmbiguous(withCollegeCandidates(toResolve));
    toResolve = prep.keep;
    hookSkippedLog.push(...prep.skipped);
    rejectEntries(prep.skipped);
  }
  const resolved = await autoResolveAmbiguousPicksForServer(toResolve, {}, userId);
  // A pair the user already answered is not asked again (SAME files it under the saved capper, DIFFERENT keeps
  // the typed name as its own capper); a pair never answered is always a question, never resolved here.
  const fuzzySuggestion = (name: string): string | undefined => {
    const r = resolveCapperNameSuggestion(name, existingCapperNames, nameDecisions);
    return r.suggestion && !r.remembered ? r.suggestion : undefined;
  };

  const questions: CatalogQuestion[] = [];
  // Every question is raised through here, so onLineOutcome hears about each one with its index.
  const ask = (q: CatalogQuestion) => {
    questions.push(q);
    if (hooks.onLineOutcome) emit(q.pick.raw, reviewOutcome(q, questions.length - 1));
  };
  let candidates: ParsedPick[] = [];
  for (const p of resolved.picks) {
    // Answered as a sport its "1P"/"2P"/"3P" can't belong to (see
    // periodShorthandOutsideNhl): an unresolved line, never an import.
    if (p.unresolvedReason) {
      unresolvedAfter = [...unresolvedAfter, p.raw];
      hookSkippedLog.push({ stage: "RECOVERY_UNRESOLVED", capperName: p.capperName, rawText: p.raw, guessedSport: p.sportName, reason: p.unresolvedReason });
      emit(p.raw, { status: "rejected", capperName: p.capperName, reason: "unparseable", detail: p.unresolvedReason });
      continue;
    }
    if (p.ambiguous && p.ambiguousKey) {
      ask({
        type: isPlayerAmbiguityKey(p.ambiguousKey) ? "PLAYER_AMBIGUITY" : "AMBIGUOUS_TEAM",
        key: p.ambiguousKey,
        options: p.ambiguous,
        pick: p,
        capperSuggestion: fuzzySuggestion(p.capperName),
        ...(guard && !isSaved(p.capperName) ? { newCapper: true } : {}),
      });
    } else candidates.push(p);
  }

  if (hooks.filterPicks) {
    const f = hooks.filterPicks(candidates);
    candidates = f.keep;
    hookSkippedLog.push(...f.skipped);
    rejectEntries(f.skipped);
  }

  // Capper near-miss: the form asks "did you mean X?" for any name that is not an exact (case-insensitive)
  // match of a saved capper but is close to one. Held here, never auto-resolved either way.
  const afterFuzzy: ParsedPick[] = [];
  for (let p of candidates) {
    const remembered = resolveCapperNameSuggestion(p.capperName, existingCapperNames, nameDecisions);
    if (remembered.suggestion && remembered.remembered === "SAME") p = { ...p, capperName: remembered.suggestion };
    const suggestion = fuzzySuggestion(p.capperName);
    if (suggestion) {
      ask({ type: "CAPPER_FUZZY", rawName: p.capperName, suggestion, pick: p });
      continue;
    }
    // Still not a saved capper: an automated import never creates one on its own.
    if (guard && !isSaved(p.capperName)) {
      ask({ type: "NEW_CAPPER", rawName: p.capperName, pick: p });
      continue;
    }
    afterFuzzy.push(p);
  }

  // Duplicate check (skip by default) and missing-total-line check (held by default).
  const dupItems = afterFuzzy.map((p) => ({ ...toItem(p, p.capperName), period: p.period }));
  const flags = dupItems.length > 0 ? await checkDuplicatePicksForUser(userId, dupItems, hooks.dayRule) : {};
  const totalFlags = afterFuzzy.length > 0 ? await previewMissingTotalLinesCore(afterFuzzy.map((p) => toItem(p, p.capperName)), hooks.dayRule) : {};

  const toImport: BulkImportItem[] = [];
  // Parallel to toImport: the parsed pick each item came from (a held far-future item becomes a question about it).
  const toImportPicks: ParsedPick[] = [];
  const skippedDuplicates: { capperName: string; sportName: string; raw: string }[] = [];
  afterFuzzy.forEach((p, i) => {
    if (flags[i]) {
      skippedDuplicates.push({ capperName: p.capperName, sportName: p.sportName, raw: p.raw });
      emit(p.raw, { status: "rejected", capperName: p.capperName, reason: "duplicate", detail: flags[i].message });
    } else if (totalFlags[i]) {
      ask({ type: "MISSING_TOTAL_LINE", pick: p, inferredLine: totalFlags[i].inferredLine, reason: totalFlags[i].reason });
    } else {
      toImport.push(toItem(p, p.capperName));
      toImportPicks.push(p);
    }
  });

  // Logged once, in one batch, like the form (parse-time log) plus the hook skips.
  await recordImportSkippedLines(userId, [...parseLog, ...hookSkippedLog]);

  const ambiguityLog = resolved.logs.map((l) => ({ key: l.ambiguousName, sport: l.resolvedSport, method: l.method, count: l.pickCount }));
  const importResult =
    toImport.length > 0 || skippedDuplicates.length > 0
      ? await importPicksForUser(userId, toImport, skippedDuplicates, ambiguityLog, {
          realTimeIngest: hooks.realTimeIngest === true,
          // Nobody is watching this import: a game days away is never saved without a person's yes.
          holdFarFuture: true,
          onFarFutureHeld: (i, row) => ask({ type: "FAR_FUTURE_GAME", pick: toImportPicks[i], row }),
          dayRule: hooks.dayRule,
          skipRecipientFanOut: hooks.skipRecipientFanOut === true,
          onItemOutcome: hooks.onLineOutcome ? (i, o) => emit(toImportPicks[i].raw, itemOutcome(toImportPicks[i], o)) : undefined,
        })
      : null;
  for (const p of repeated) emit(p.raw, { status: "rejected", capperName: p.capperName, reason: "duplicate_in_request" });

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
