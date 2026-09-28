// Every category pickCategory() can return must be in ALL_CATEGORY_KEYS.
//
// Why it matters: computeCategoryBreakdown / computeLeagueRecordCards only keep
// categories listed in their `order` argument, and getCapperCategoryRecords /
// getCapperLeagueRecords pass ALL_CATEGORY_KEYS. A category missing from that list
// is silently dropped from every capper record - a wrong record, not an error.
// The SQL replacement for those functions compares the stored Pick.category with
// the category requested by the caller, so it depends on the same list being
// complete.
//
// Two independent proofs:
//   1. TYPE side: PICK_CATEGORY_LABELS is `Record<PickCategoryKey, string>`, so
//      TypeScript forces its keys to be exactly the PickCategoryKey union. Every
//      one of them must be in ALL_CATEGORY_KEYS.
//   2. BEHAVIOUR side: every non-null value pickCategory() returns across the whole
//      pinned input matrix (pick-category-matrix.ts) must be in ALL_CATEGORY_KEYS.
// Also: ALL_CATEGORY_KEYS has no duplicates, and every key in it is reachable from
// the matrix (so a key can't sit in the list with no way to produce it).
//
// Pure (no database). Run with:
//   npx tsx src/server/data/all-category-keys-acceptance-test.ts
import { ALL_CATEGORY_KEYS, PICK_CATEGORY_LABELS, pickCategory } from "@/server/data/stats";
import { enumerateMatrix } from "@/server/data/pick-category-matrix";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const all = new Set<string>(ALL_CATEGORY_KEYS);

check("ALL_CATEGORY_KEYS has no duplicates", all.size === ALL_CATEGORY_KEYS.length, `${ALL_CATEGORY_KEYS.length} entries, ${all.size} distinct`);

const labelKeys = Object.keys(PICK_CATEGORY_LABELS);
const labelsMissing = labelKeys.filter((k) => !all.has(k));
check(`every PickCategoryKey (${labelKeys.length}, via PICK_CATEGORY_LABELS) is in ALL_CATEGORY_KEYS`, labelsMissing.length === 0, `missing: ${labelsMissing.join(", ")}`);

const inAllNotLabels = ALL_CATEGORY_KEYS.filter((k) => !(k in PICK_CATEGORY_LABELS));
check("every key in ALL_CATEGORY_KEYS is a real PickCategoryKey", inAllNotLabels.length === 0, `unknown: ${inAllNotLabels.join(", ")}`);

const produced = new Set<string>();
let cases = 0;
let nulls = 0;
const outsideExample = new Map<string, string>();
for (const { input } of enumerateMatrix()) {
  cases++;
  const result = pickCategory(input);
  if (result === null) {
    nulls++;
    continue;
  }
  produced.add(result);
  if (!all.has(result) && !outsideExample.has(result)) outsideExample.set(result, JSON.stringify(input));
}
check(
  `every non-null pickCategory() output over ${cases} matrix cases (${nulls} null) is in ALL_CATEGORY_KEYS`,
  outsideExample.size === 0,
  Array.from(outsideExample.entries())
    .map(([k, v]) => `${k} <- ${v}`)
    .join("; ")
);

const unreachable = ALL_CATEGORY_KEYS.filter((k) => !produced.has(k));
check(`every key in ALL_CATEGORY_KEYS is produced by some matrix case (${produced.size}/${ALL_CATEGORY_KEYS.length})`, unreachable.length === 0, `never produced: ${unreachable.join(", ")}`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
