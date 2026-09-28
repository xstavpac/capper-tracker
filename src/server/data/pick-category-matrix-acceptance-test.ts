// Pins pickCategory() over the WHOLE input matrix in pick-category-matrix.ts
// (every bet type x period x sport x odds x line x betDetail x side x propMarket
// combination that group defines), against a checked-in file of expected outputs.
//
// If this test fails you changed what pickCategory (or a helper it calls) returns
// for an input that already exists. Every stored Pick.category for that input is
// now out of date, so:
//   1. bump PICK_CATEGORY_VERSION in stats.ts,
//   2. re-run scripts/backfill-pick-category.ts to restamp existing picks,
//   3. only then regenerate the pinned file:
//        npx tsx src/server/data/pick-category-matrix-acceptance-test.ts --update
// If instead it fails because the MATRIX changed (a new BetType / Period /
// PropMarket enum value, or an edited axis), review the new cases' outputs and
// regenerate the same way; a new enum value normally needs no version bump (no
// stored row has that input yet).
//
// Complements pick-category-version-acceptance-test.ts (a hand-picked sample):
// that catches the changes someone thought of, this catches the rest.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/pick-category-matrix-acceptance-test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { enumerateGroup, matrixGroupNames, type MatrixInput } from "@/server/data/pick-category-matrix";

const EXPECTED_PATH = join(process.cwd(), "src/server/data/pick-category-matrix.expected.json");
const update = process.argv.includes("--update");

type GroupFile = { cases: number; runs: string }; // runs: "codeIdx:runLength,codeIdx:runLength,..."
type ExpectedFile = { pickCategoryVersion: number; codes: (string | null)[]; groups: Record<string, GroupFile> };

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// Compute every group's outputs as a list of category codes.
function computeGroup(name: string, codes: (string | null)[]): number[] {
  const out: number[] = [];
  for (const input of enumerateGroup(name)) {
    const result = pickCategory(input);
    let idx = codes.indexOf(result);
    if (idx < 0) {
      codes.push(result);
      idx = codes.length - 1;
    }
    out.push(idx);
  }
  return out;
}

function encodeRuns(outputs: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < outputs.length) {
    let j = i;
    while (j < outputs.length && outputs[j] === outputs[i]) j++;
    parts.push(`${outputs[i]}:${j - i}`);
    i = j;
  }
  return parts.join(",");
}

function decodeRuns(runs: string): number[] {
  const out: number[] = [];
  for (const part of runs.split(",")) {
    if (!part) continue;
    const [code, n] = part.split(":").map(Number);
    for (let k = 0; k < n; k++) out.push(code);
  }
  return out;
}

function describe(input: MatrixInput): string {
  return JSON.stringify(input);
}

function writeExpected() {
  const codes: (string | null)[] = [null];
  const groups: Record<string, GroupFile> = {};
  for (const name of matrixGroupNames()) {
    const outputs = computeGroup(name, codes);
    groups[name] = { cases: outputs.length, runs: encodeRuns(outputs) };
  }
  const file: ExpectedFile = { pickCategoryVersion: PICK_CATEGORY_VERSION, codes, groups };
  // One group per line: diffs stay readable in review.
  const body =
    "{\n" +
    `  "pickCategoryVersion": ${file.pickCategoryVersion},\n` +
    `  "codes": ${JSON.stringify(file.codes)},\n` +
    `  "groups": {\n` +
    Object.entries(groups)
      .map(([k, g]) => `    ${JSON.stringify(k)}: ${JSON.stringify(g)}`)
      .join(",\n") +
    "\n  }\n}\n";
  writeFileSync(EXPECTED_PATH, body);
  const total = Object.values(groups).reduce((n, g) => n + g.cases, 0);
  console.log(`Wrote ${EXPECTED_PATH}: ${Object.keys(groups).length} groups, ${total} cases, version ${PICK_CATEGORY_VERSION}.`);
}

function main() {
  if (update) {
    writeExpected();
    return;
  }

  const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as ExpectedFile;
  const names = matrixGroupNames();

  check(
    "the set of matrix groups matches the pinned file (a new BetType enum value adds a group - regenerate after review)",
    JSON.stringify(names) === JSON.stringify(Object.keys(expected.groups)),
    `matrix has ${JSON.stringify(names)}, file has ${JSON.stringify(Object.keys(expected.groups))}`
  );

  const codes = expected.codes.slice();
  let totalCases = 0;
  let totalDiffs = 0;
  for (const name of names) {
    const pinned = expected.groups[name];
    if (!pinned) continue;
    const want = decodeRuns(pinned.runs);
    const got = computeGroup(name, codes);
    totalCases += got.length;
    if (want.length !== got.length) {
      check(`${name}: same number of cases as pinned`, false, `pinned ${want.length}, matrix now yields ${got.length} (the matrix axes changed)`);
      totalDiffs++;
      continue;
    }
    const diffs: string[] = [];
    let i = 0;
    let n = 0;
    for (const input of enumerateGroup(name)) {
      if (want[i] !== got[i]) {
        n++;
        if (diffs.length < 8) diffs.push(`    #${i} ${describe(input)}\n      pinned=${JSON.stringify(codes[want[i]])} now=${JSON.stringify(codes[got[i]])}`);
      }
      i++;
    }
    totalDiffs += n;
    check(`${name}: all ${got.length} outputs match the pinned file`, n === 0, `${n} differ:\n${diffs.join("\n")}`);
  }

  if (totalDiffs > 0 && expected.pickCategoryVersion === PICK_CATEGORY_VERSION) {
    console.log(
      `\nOutputs changed but PICK_CATEGORY_VERSION is still ${PICK_CATEGORY_VERSION}. If this is a real change to what pickCategory returns for existing inputs, bump the version and re-run the backfill BEFORE regenerating this file (see the header).`
    );
  }
  console.log(`\n${totalCases} matrix cases checked across ${names.length} groups.`);
}

main();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
