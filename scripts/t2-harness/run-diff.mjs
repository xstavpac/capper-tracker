// T2 harness: the main orchestrator. One run = one disposable local
// database, populated from either the synthetic fixtures or a pre-built
// anonymized snapshot, two implementations' outputs captured against it, and
// a structural diff between them - cleaned up automatically when the run
// ends, success or failure.
//
// Flow (T2 build task, item 2): create disposable DB (this run) -> load data
// -> run diff -> destroy disposable DB. Cleanup happens in a `finally` block
// below, not as a remembered separate step - it runs whether the diff found
// differences, threw, or was interrupted by a synchronous error. (It does
// NOT run on SIGKILL or a hard process crash - that's exactly what
// lib/disposable-db.mjs's cleanupOrphans() is for; see README.md.)
//
// Usage:
//   node scripts/t2-harness/run-diff.mjs --source=fixtures --impl-old=old --impl-new=old
//   node scripts/t2-harness/run-diff.mjs --source=snapshot:scripts/t2-harness/.snapshots/prod-2026-09.dump --impl-old=old --impl-new=t3
//
// --keep-db: skip the final DROP DATABASE (debugging only - the DB is still
// a t2_run_* disposable, so a later `--cleanup-orphans` will still reclaim it).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunDb, dropRunDb, newRunId, runDbUrl } from "./lib/disposable-db.mjs";
import { deepDiff, formatDiffReport } from "./lib/deep-diff.mjs";
import { assertNotProd } from "./lib/prod-guard.mjs";

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const REPO_ROOT = join(HERE, "..", "..");

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=") || true];
    })
  );
}

function pgBin(name) {
  return process.env.T2_PG_BIN_DIR ? `${process.env.T2_PG_BIN_DIR}/${name}` : name;
}

function applySchema(dbUrl) {
  assertNotProd(dbUrl, "migrate-deploy target");
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    shell: true,
  });
}

function loadFixtures(dbUrl) {
  assertNotProd(dbUrl, "fixtures target");
  execFileSync(process.execPath, ["--import", "tsx", join(HERE, "fixtures.ts")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
  });
}

function restoreSnapshot(dbUrl, dumpFile) {
  assertNotProd(dbUrl, "snapshot-restore target");
  if (!existsSync(dumpFile)) throw new Error(`snapshot dump not found: ${dumpFile}`);
  // dbUrl is postgresql://<user>@<host>:<port>/<dbname> (see lib/disposable-db.mjs)
  const match = dbUrl.match(/^postgresql:\/\/([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (!match) throw new Error(`could not parse run DB URL: ${dbUrl}`);
  const [, dbUser, dbHost, dbPort, dbNameOnly] = match;
  execFileSync(pgBin("pg_restore"), [
    "-h", dbHost, "-p", dbPort, "-U", dbUser, "-d", dbNameOnly, "--no-owner", "--no-privileges", dumpFile,
  ], { stdio: "inherit" });
}

// Runs capture-output.ts for one implementation against the run DB and
// returns its parsed JSON output. A separate child process per implementation
// (not a mid-process DB swap) because src/lib/prisma.ts's singleton
// PrismaClient reads DATABASE_URL once at import time - the only reliable
// way to point two invocations at the same disposable DB with a clean
// Prisma connection each time is two separate processes.
function captureOutput(dbUrl, implName, userSelector) {
  assertNotProd(dbUrl, "capture-output target");
  const args = ["--import", "tsx", join(HERE, "capture-output.ts"), `--impl=${implName}`, ...userSelector];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(res.stderr);
    throw new Error(`capture-output.ts failed for --impl=${implName} (exit ${res.status})`);
  }
  if (res.stderr) process.stderr.write(res.stderr); // pass through logging, doesn't affect stdout parsing
  // Defense against stray stdout writes from anything capture-output.ts
  // imports (Prisma query logging, an errant console.log): the JSON payload
  // is always the single, final, no-newline write - see capture-output.ts's
  // own comment ("the ONLY thing printed to stdout"). Taking the last
  // non-empty line survives any such pollution above it without silently
  // parsing the wrong thing.
  const lastLine = res.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine);
}

export function runDiffOnce({ source, implOld, implNew, userSelector, keepDb = false, label = "" } = {}) {
  const runId = newRunId();
  console.log(`\n[t2-harness] run ${runId}${label ? ` (${label})` : ""}: creating disposable DB...`);
  createRunDb(runId);
  const dbUrl = runDbUrl(runId);

  try {
    if (source === "fixtures") {
      // fixtures.ts seeds data via Prisma, so the disposable DB needs the
      // schema applied first.
      console.log(`[t2-harness] applying schema...`);
      applySchema(dbUrl);
      console.log(`[t2-harness] loading synthetic fixtures...`);
      loadFixtures(dbUrl);
    } else if (source?.startsWith("snapshot:")) {
      // A pg_dump/pg_restore-format snapshot already contains the full
      // schema (CREATE TYPE / CREATE TABLE / ...) alongside the data -
      // running `prisma migrate deploy` first would try to create the same
      // types twice and fail. pg_restore populates the schema by itself.
      const dumpFile = source.slice("snapshot:".length);
      console.log(`[t2-harness] restoring anonymized snapshot (schema + data) from ${dumpFile}...`);
      restoreSnapshot(dbUrl, dumpFile);
    } else {
      throw new Error(`unknown --source: ${source} (expected "fixtures" or "snapshot:<path>")`);
    }

    console.log(`[t2-harness] capturing --impl=${implOld} output...`);
    const oldOut = captureOutput(dbUrl, implOld, userSelector);
    console.log(`[t2-harness] capturing --impl=${implNew} output...`);
    const newOut = captureOutput(dbUrl, implNew, userSelector);

    const diffs = deepDiff(oldOut, newOut);
    return { runId, diffs, oldOut, newOut };
  } finally {
    if (!keepDb) {
      console.log(`[t2-harness] dropping disposable DB (run ${runId})...`);
      dropRunDb(runId);
    } else {
      console.log(`[t2-harness] --keep-db set - leaving ${dbUrl} in place (drop by hand or via --cleanup-orphans later).`);
    }
  }
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const source = typeof args.source === "string" ? args.source : "fixtures";
  const implOld = typeof args["impl-old"] === "string" ? args["impl-old"] : "old";
  const implNew = typeof args["impl-new"] === "string" ? args["impl-new"] : "old";
  const keepDb = args["keep-db"] === true;
  const userSelector =
    typeof args["user-id"] === "string" ? [`--user-id=${args["user-id"]}`] : [`--fixture-user=${args["fixture-user"] ?? "A"}`];

  const { runId, diffs } = runDiffOnce({ source, implOld, implNew, userSelector, keepDb });

  console.log(`\n${"=".repeat(60)}`);
  if (diffs.length === 0) {
    console.log(`[t2-harness] run ${runId}: NO DIFFERENCES (--impl-old=${implOld} vs --impl-new=${implNew})`);
    process.exit(0);
  } else {
    console.log(`[t2-harness] run ${runId}: ${diffs.length} DIFFERENCE(S) (--impl-old=${implOld} vs --impl-new=${implNew})`);
    console.log(formatDiffReport(diffs));
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("run-diff.mjs")) {
  cliMain();
}
