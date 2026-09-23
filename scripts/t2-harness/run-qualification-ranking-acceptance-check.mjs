// Orchestrator for the qualification-ranking acceptance check (docs/parlay-
// white-paper.md, Sections 3, 5, 7). Restores the existing anonymized
// snapshot (.snapshots/prod_2026_09_15.dump) into a disposable local DB,
// runs qualification-ranking-acceptance-check.ts once against it, writes the
// JSON report to the scratchpad, and drops the disposable DB in a finally
// block - same lifecycle shape as run-wilson-floor-sweep.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunDb, dropRunDb, newRunId, runDbUrl } from "./lib/disposable-db.mjs";
import { assertNotProd } from "./lib/prod-guard.mjs";

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const REPO_ROOT = join(HERE, "..", "..");
const DUMP_FILE = join(HERE, ".snapshots", "prod_2026_09_15.dump");
const OUT_FILE = process.argv[2] || join(HERE, "qualification-ranking-acceptance-report.json");

function pgBin(name) {
  return process.env.T2_PG_BIN_DIR ? `${process.env.T2_PG_BIN_DIR}/${name}` : name;
}

function restoreSnapshot(dbUrl, dumpFile) {
  assertNotProd(dbUrl, "snapshot-restore target");
  if (!existsSync(dumpFile)) throw new Error(`snapshot dump not found: ${dumpFile}`);
  const match = dbUrl.match(/^postgresql:\/\/([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (!match) throw new Error(`could not parse run DB URL: ${dbUrl}`);
  const [, dbUser, dbHost, dbPort, dbNameOnly] = match;
  execFileSync(
    pgBin("pg_restore"),
    ["-h", dbHost, "-p", dbPort, "-U", dbUser, "-d", dbNameOnly, "--no-owner", "--no-privileges", dumpFile],
    { stdio: "inherit" }
  );
}

function runCheck(dbUrl) {
  assertNotProd(dbUrl, "qualification-ranking-acceptance-check target");
  const args = ["--import", "tsx", join(HERE, "qualification-ranking-acceptance-check.ts")];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(res.stderr);
    throw new Error(`qualification-ranking-acceptance-check.ts failed (exit ${res.status})`);
  }
  if (res.stderr) process.stderr.write(res.stderr);
  const lastLine = res.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine);
}

function main() {
  const runId = newRunId();
  console.log(`[qualification-ranking-acceptance] run ${runId}: creating disposable DB...`);
  createRunDb(runId);
  const dbUrl = runDbUrl(runId);

  try {
    console.log(`[qualification-ranking-acceptance] restoring anonymized snapshot from ${DUMP_FILE}...`);
    restoreSnapshot(dbUrl, DUMP_FILE);

    console.log(`[qualification-ranking-acceptance] running acceptance check...`);
    const report = runCheck(dbUrl);
    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

    console.log(`[qualification-ranking-acceptance] done. Report written to ${OUT_FILE}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    console.log(`[qualification-ranking-acceptance] dropping disposable DB (run ${runId})...`);
    dropRunDb(runId);
  }
}

main();
