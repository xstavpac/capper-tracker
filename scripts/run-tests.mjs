// Repo test runner - discovers every standalone acceptance/assertion test
// under src/ and runs each in its own `tsx` process, since that's how they're
// written (each file `console.log`s PASS/FAIL lines and calls process.exit(1)
// on failure - there is no shared test framework).
//
// DB-backed tests: the six model-engine suites under
// src/server/data/model-engine/ import `@/lib/prisma` and query real seeded
// rows by hardcoded id. They only run when DATABASE_URL is set (locally,
// against a seeded dev DB). CI does not set DATABASE_URL, so they are
// reported as SKIP there rather than failing. See ci.yml and the follow-up
// to give CI a seeded Postgres service.
//
// Usage: `npm test`  (or `node scripts/run-tests.mjs`)
// Exits non-zero if any test that actually ran reported a failure.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcDir = join(repoRoot, "src");

// A file is a test if its name ends with one of these.
const TEST_SUFFIXES = ["-acceptance-test.ts", "-test.ts"];
// ...except this one, which is a manual backtest harness, not a pass/fail suite.
const NOT_A_TEST = new Set(["src/server/data/model-engine/decay-delta-backtest.ts"]);

// Suites that need a seeded database. Most are caught automatically (they
// import `@/lib/prisma` directly - see needsDb below); these reach the DB
// transitively (e.g. through resolveGameObservations) so they're listed
// explicitly. When DATABASE_URL is unavailable they report SKIP.
const NEEDS_DB = new Set([
  "src/lib/model-engine/weighted-accumulation-acceptance-test.ts",
]);

// Suites that import `@/lib/prisma` but never actually query - they swap a
// prisma method for a spy before calling. The auto-detect would wrongly skip
// these without a DB; force them to always run.
const PURE_DESPITE_PRISMA_IMPORT = new Set([
  "src/server/data/delete-scoping-acceptance-test.ts",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (TEST_SUFFIXES.some((s) => entry.endsWith(s))) out.push(full);
  }
  return out;
}

// A DB is "available" if DATABASE_URL is exported, or a local .env defines it
// (Prisma's own dotenv loading picks that up when tsx runs each test). CI
// commits no .env and sets no env var, so the DB-backed suites SKIP there.
function dbIsAvailable() {
  if (process.env.DATABASE_URL) return true;
  try {
    return /^\s*DATABASE_URL\s*=/m.test(readFileSync(join(repoRoot, ".env"), "utf8"));
  } catch {
    return false;
  }
}
const hasDbUrl = dbIsAvailable();

const files = walk(srcDir)
  .map((f) => relative(repoRoot, f).split("\\").join("/"))
  .filter((f) => !NOT_A_TEST.has(f))
  .sort();

let failed = 0;
let passed = 0;
let skipped = 0;

for (const rel of files) {
  const needsDb =
    !PURE_DESPITE_PRISMA_IMPORT.has(rel) &&
    (NEEDS_DB.has(rel) || readFileSync(join(repoRoot, rel), "utf8").includes('from "@/lib/prisma"'));
  if (needsDb && !hasDbUrl) {
    console.log(`SKIP (needs DB, DATABASE_URL unset)  ${rel}`);
    skipped++;
    continue;
  }

  const res = spawnSync(process.execPath, ["--import", "tsx", rel], { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (res.error) {
    console.log(`FAIL (could not launch: ${res.error.message})  ${rel}\n`);
    failed++;
    continue;
  }
  if (res.status === 0) {
    console.log(`PASS  ${rel}\n`);
    passed++;
  } else {
    console.log(`FAIL (exit ${res.status})  ${rel}\n`);
    failed++;
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`ran ${passed + failed} suite(s): ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
