// Orchestrator for the Relationship Classifier acceptance check
// (docs/parlay-white-paper.md, Section 4). Restores the existing anonymized
// snapshot (.snapshots/prod_2026_09_15.dump) into a disposable local DB,
// runs relationship-classifier-acceptance-check.ts against it, and drops the
// disposable DB in a finally block - same lifecycle shape as
// run-parlay-investigation.mjs / run-diff.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunDb, dropRunDb, newRunId, runDbUrl } from "./lib/disposable-db.mjs";
import { assertNotProd } from "./lib/prod-guard.mjs";

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const REPO_ROOT = join(HERE, "..", "..");
const DUMP_FILE = join(HERE, ".snapshots", "prod_2026_09_15.dump");

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

function runAcceptanceCheck(dbUrl) {
  assertNotProd(dbUrl, "acceptance-check target");
  const args = ["--import", "tsx", join(HERE, "relationship-classifier-acceptance-check.ts")];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    stdio: "inherit",
  });
  return res.status ?? 1;
}

function main() {
  const runId = newRunId();
  console.log(`[relationship-classifier-acceptance] run ${runId}: creating disposable DB...`);
  createRunDb(runId);
  const dbUrl = runDbUrl(runId);

  let exitCode = 1;
  try {
    console.log(`[relationship-classifier-acceptance] restoring anonymized snapshot from ${DUMP_FILE}...`);
    restoreSnapshot(dbUrl, DUMP_FILE);

    console.log(`[relationship-classifier-acceptance] running acceptance check...`);
    exitCode = runAcceptanceCheck(dbUrl);
  } finally {
    console.log(`[relationship-classifier-acceptance] dropping disposable DB (run ${runId})...`);
    dropRunDb(runId);
  }
  process.exit(exitCode);
}

main();
