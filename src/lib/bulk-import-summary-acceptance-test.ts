// Proof for the bulk-import toast/skip-list unification - run with:
//   npx tsx src/lib/bulk-import-summary-acceptance-test.ts
//
// Covers the "skipped-picks count mismatch" report: the toast used to count
// only `items.length - result.created.length` (picks that reached
// bulkImportPicksAction and bounced) plus confirmed-duplicate skips, while
// the on-screen list also covered ambiguous-team prompts, unparseable
// lines, and total-line-confirmation prompts left unanswered at submit
// time - categories that never reach the server at all, so the toast never
// saw them.
import { isPendingOrRejectedTotalLine, partitionReviewEntries, totalSkipped, type ReviewPickState } from "./bulk-import-summary";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
console.log("########## isPendingOrRejectedTotalLine ##########");
check("no flag -> not pending", isPendingOrRejectedTotalLine(false, undefined), false);
check("flagged, never answered -> pending (excluded)", isPendingOrRejectedTotalLine(true, undefined), true);
check("flagged, rejected -> excluded", isPendingOrRejectedTotalLine(true, "reject"), true);
check("flagged, confirmed -> NOT excluded", isPendingOrRejectedTotalLine(true, "confirm"), false);

// ---------------------------------------------------------------------------
console.log("\n########## partitionReviewEntries: disjoint duplicate / total-line skip reasons ##########");
function entry(over: Partial<ReviewPickState> & { idx: number }): ReviewPickState {
  return {
    idx: over.idx,
    hasDuplicateFlag: over.hasDuplicateFlag ?? false,
    duplicateChoice: over.duplicateChoice,
    hasTotalLineFlag: over.hasTotalLineFlag ?? false,
    totalLineChoice: over.totalLineChoice,
  };
}

{
  // A clean pick (no flags at all) is included.
  const result = partitionReviewEntries([entry({ idx: 0 })]);
  check("no flags -> included", result, { includedIdx: [0], duplicateSkipIdx: [], totalLinePendingIdx: [] });
}
{
  // Duplicate flagged and never answered -> duplicate skip only.
  const result = partitionReviewEntries([entry({ idx: 0, hasDuplicateFlag: true })]);
  check("duplicate, unanswered -> duplicateSkipIdx", result, { includedIdx: [], duplicateSkipIdx: [0], totalLinePendingIdx: [] });
}
{
  // Total-line flagged and never confirmed -> total-line-pending only.
  const result = partitionReviewEntries([entry({ idx: 0, hasTotalLineFlag: true })]);
  check("total line, unconfirmed -> totalLinePendingIdx", result, { includedIdx: [], duplicateSkipIdx: [], totalLinePendingIdx: [0] });
}
{
  // Flagged for BOTH reasons at once - must land in exactly one bucket
  // (duplicateSkipIdx), never both, or the toast total would double-count it.
  const result = partitionReviewEntries([
    entry({ idx: 0, hasDuplicateFlag: true, hasTotalLineFlag: true }),
  ]);
  check("both flags at once -> counted exactly once (duplicate wins)", result, {
    includedIdx: [],
    duplicateSkipIdx: [0],
    totalLinePendingIdx: [],
  });
}
{
  // Duplicate explicitly resolved "Import anyway", total line confirmed -> included.
  const result = partitionReviewEntries([
    entry({ idx: 0, hasDuplicateFlag: true, duplicateChoice: "import", hasTotalLineFlag: true, totalLineChoice: "confirm" }),
  ]);
  check("both flags resolved in favor of importing -> included", result, {
    includedIdx: [0],
    duplicateSkipIdx: [],
    totalLinePendingIdx: [],
  });
}

// ---------------------------------------------------------------------------
console.log("\n########## totalSkipped: the toast headline's single source of truth ##########");

// Regression 1: only post-submit duplicate skips (no ambiguous/unresolved) -
// matches the pre-fix behavior exactly (result.skipped + skippedDuplicates.length).
check(
  "only duplicate skips, no pre-submit categories",
  totalSkipped({
    unresolvedLines: [],
    ambiguousUnanswered: [],
    totalLinePending: [],
    duplicates: ["Cody - NFL - Chiefs ML"],
    serverSkipped: 0,
  }),
  1
);

// Regression 2: ambiguous-team prompts left unanswered at submit time are
// included alongside duplicate skips.
check(
  "ambiguous-unanswered picks counted alongside duplicate skips",
  totalSkipped({
    unresolvedLines: [],
    ambiguousUnanswered: ['Vegas John - "Cardinals -3"', 'Vegas John - "Cardinals ML"'],
    totalLinePending: [],
    duplicates: ["Cody - NFL - Chiefs ML"],
    serverSkipped: 0,
  }),
  3
);

// Regression 3: every pre-submit prompt gets answered before Import is
// clicked - none of them appear in the final categories, so the toast
// reflects only what's still actually skipped (not a stale pre-answer count).
check(
  "fully resolved paste -> nothing pre-submit left to count",
  totalSkipped({
    unresolvedLines: [],
    ambiguousUnanswered: [], // e.g. the user answered "San Francisco Giants (MLB)" before submitting
    totalLinePending: [],
    duplicates: [],
    serverSkipped: 0,
  }),
  0
);

// Regression 4: all four categories present at once - the toast total must
// equal the sum a user could verify by counting each on-screen section.
check(
  "all four categories present -> toast total is their sum",
  totalSkipped({
    unresolvedLines: ["garbled line that never parsed"],
    ambiguousUnanswered: ['Vegas John - "Cardinals -3"'],
    totalLinePending: ["Cody - NFL - Bears Under"],
    duplicates: ["Cody - NFL - Chiefs ML"],
    serverSkipped: 1, // one submitted pick the server itself couldn't match to today's schedule
  }),
  5
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
