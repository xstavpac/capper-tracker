// Single source of truth for "how many picks from this catalog paste did NOT
// end up imported, and why" - shared by the on-screen per-category
// breakdown sections and the post-import toast headline in
// bulk-import-form.tsx, so the two can never drift out of sync again.
//
// Before this fix, the toast counted only `items.length - result.created.length`
// (picks that reached bulkImportPicksAction and bounced there) plus
// client-tracked confirmed-duplicate skips. The itemized on-screen sections,
// though, also cover three categories that are decided BEFORE anything is
// submitted and are never in the `items` array sent to the server at all:
// an ambiguous team name (e.g. "Cardinals") still awaiting a manual choice,
// a line the parser couldn't place to any sport/team at all, and a TOTAL
// pick's market-line suggestion left unconfirmed or rejected. Left
// unanswered at the moment Import is clicked, those picks are silently
// excluded from the submission - and previously from the toast's count too.
//
// Pure/dependency-free, same as duplicate-pick-detection.ts, so it's
// covered by a plain tsx acceptance test.

import { isSkippedAsDuplicate, type DuplicateChoice } from "./duplicate-pick-detection";
import { detectUnsupportedPropLine } from "./parse-catalog";

// A TOTAL pick whose own text had no parseable number, flagged with a
// suggested market line - same default-excluded-until-confirmed shape as a
// duplicate flag (see isSkippedAsDuplicate above): left unanswered, or
// explicitly rejected, it does not import.
export function isPendingOrRejectedTotalLine(
  hasFlag: boolean,
  choice: "confirm" | "reject" | undefined
): boolean {
  return hasFlag && choice !== "confirm";
}

export type ReviewPickState = {
  idx: number;
  hasDuplicateFlag: boolean;
  duplicateChoice: DuplicateChoice | undefined;
  hasTotalLineFlag: boolean;
  totalLineChoice: "confirm" | "reject" | undefined;
};

// Partitions a paste's non-ambiguous picks into "will be submitted" vs the
// two disjoint pre-submit skip reasons - mirrors bulk-import-form's
// includedEntries/skippedDuplicateEntries split exactly. A pick flagged for
// BOTH reasons at once (a duplicate that's also a pending total line) lands
// in duplicateSkipIdx only, so the two skip lists stay disjoint and summing
// their lengths never double-counts it.
export function partitionReviewEntries(entries: ReviewPickState[]): {
  includedIdx: number[];
  duplicateSkipIdx: number[];
  totalLinePendingIdx: number[];
} {
  const includedIdx: number[] = [];
  const duplicateSkipIdx: number[] = [];
  const totalLinePendingIdx: number[] = [];

  for (const e of entries) {
    const isDup = isSkippedAsDuplicate(e.hasDuplicateFlag, e.duplicateChoice);
    const isTotalLinePending = isPendingOrRejectedTotalLine(e.hasTotalLineFlag, e.totalLineChoice);
    if (isDup) {
      duplicateSkipIdx.push(e.idx);
    } else if (isTotalLinePending) {
      totalLinePendingIdx.push(e.idx);
    } else {
      includedIdx.push(e.idx);
    }
  }

  return { includedIdx, duplicateSkipIdx, totalLinePendingIdx };
}

// Pre-import view of the same partition, for the Import button: of the picks
// that won't be submitted, how many are still waiting on an answer
// ("unanswered" - a question the user hasn't touched) versus already decided
// by the user (an explicit Skip / rejected line). `ambiguousUnanswered` is
// the count of picks still behind a "which one?" question - never in
// `entries`, same as in totalSkipped below. unanswered + decided is exactly
// what the post-import summary will report for these categories.
export function pendingSkipCounts(
  entries: ReviewPickState[],
  ambiguousUnanswered: number
): { unanswered: number; decided: number } {
  const { duplicateSkipIdx, totalLinePendingIdx } = partitionReviewEntries(entries);
  const skipped = new Set([...duplicateSkipIdx, ...totalLinePendingIdx]);
  let unanswered = ambiguousUnanswered;
  let decided = 0;
  for (const e of entries) {
    if (!skipped.has(e.idx)) continue;
    const open =
      (e.hasDuplicateFlag && e.duplicateChoice === undefined) || (e.hasTotalLineFlag && e.totalLineChoice === undefined);
    if (open) unanswered += 1;
    else decided += 1;
  }
  return { unanswered, decided };
}

// Import button copy: what will import, then what won't and why, so neither
// the unanswered default nor an explicit skip is silent at the point of
// clicking. `importing` is the already-built "Import N picks (+ M parlays)".
export function importActionLabel(importing: string, counts: { unanswered: number; decided: number }): string {
  const parts = [importing];
  if (counts.unanswered > 0) parts.push(counts.unanswered + " unanswered will be skipped");
  if (counts.decided > 0) parts.push(counts.decided + " skipped");
  return parts.join(" · ");
}

// Every category of "this pick is not going to be imported," captured at the
// moment the user clicks Import - each array already holds one human-
// readable label per skipped pick, the same labels the itemized breakdown
// sections render, so `totalSkipped` just needs their lengths.
export type SkippedPickCategories = {
  // Lines the client parser never turned into a pick at all.
  unresolvedLines: string[];
  // Ambiguous-team picks still awaiting a manual choice at submit time.
  ambiguousUnanswered: string[];
  // TOTAL picks whose market-line suggestion was left unconfirmed or
  // explicitly rejected at submit time (see partitionReviewEntries).
  totalLinePending: string[];
  // Picks flagged as a possible duplicate that were excluded (explicit
  // "Skip", or never answered - see isSkippedAsDuplicate).
  duplicates: string[];
  // Picks that WERE sent to bulkImportPicksAction but the server itself
  // couldn't persist (BulkImportResult.skipped - no live-schedule match, or
  // a per-item error).
  serverSkipped: number;
};

export function totalSkipped(categories: SkippedPickCategories): number {
  return (
    categories.unresolvedLines.length +
    categories.ambiguousUnanswered.length +
    categories.totalLinePending.length +
    categories.duplicates.length +
    categories.serverSkipped
  );
}

// ---------------------------------------------------------------------------
// Reason labels + counts for the "couldn't be identified" list.
//
// A line in `unresolvedLines` is either a genuine "couldn't match a sport or
// team" miss (no reason - the list's own header explains it) or a
// player-prop / stat-total shape this app can't import yet (MLB/NHL/NBA/WNBA
// player props, unsupported NFL markets, team or game stat totals - see
// unsupported-prop-vocab.ts), which gets its own honest reason. Both the
// on-screen list and the import-skipped-line log derive it from the same
// detector, so the label a user sees is the reason recorded for it.
// ---------------------------------------------------------------------------

export type UnresolvedLineEntry = { text: string; reason: string | null };

// `specificReasons` (line text -> reason, from the server recovery pass) wins over the vocabulary detector:
// it knows why THIS line failed (e.g. which quarterbacks a surname matched).
export function describeUnresolvedLines(lines: string[], specificReasons: Record<string, string> = {}): UnresolvedLineEntry[] {
  return lines.map((text) => ({ text, reason: specificReasons[text] ?? detectUnsupportedPropLine(text)?.reason ?? null }));
}

// How many unresolved lines carry an "isn't supported yet" reason, grouped by
// that reason, most common first. Lines with no reason are not counted here -
// they're still in the list's overall count (totalSkipped).
export function unresolvedReasonBreakdown(entries: UnresolvedLineEntry[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.reason) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
