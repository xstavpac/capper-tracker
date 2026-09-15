// Disposable-DB lifecycle for the T2 harness: every run gets its own,
// uniquely-named local Postgres database, created fresh and dropped when the
// run finishes - never a single shared local DB that gets manually cleaned
// between uses (see the T2 build task, item 2).
//
// Naming embeds the creation time directly in the database name
// (t2_run_<epochSeconds>_<random6hex>) rather than in a separate sidecar
// tracking file. That's deliberate: if the harness process is killed mid-run
// (crash, Ctrl-C, machine sleep) there is nothing else that needed to be
// written for the DB to still be identifiable and age-checked later - the
// name alone is enough for cleanupOrphans() to find it and know how old it
// is, with no risk of the tracking file and the DB's existence drifting out
// of sync.
import { execFileSync } from "node:child_process";

const ADMIN_HOST = process.env.T2_PG_HOST ?? "localhost";
const ADMIN_PORT = process.env.T2_PG_PORT ?? "5432";
const ADMIN_USER = process.env.T2_PG_ADMIN_USER ?? "postgres";
const RUN_DB_PREFIX = "t2_run_";
const ORPHAN_MAX_AGE_MINUTES_DEFAULT = 60;

import { assertNotProd } from "./prod-guard.mjs";

// The admin connection this harness uses to create/drop run databases. Built
// from fixed local-only parts (never read off DATABASE_URL, which is exactly
// the variable the Aug 18 incident got wrong) - guarded anyway, in case
// T2_PG_HOST is ever pointed somewhere it shouldn't be.
function adminUrl(dbName = "postgres") {
  const url = `postgresql://${ADMIN_USER}@${ADMIN_HOST}:${ADMIN_PORT}/${dbName}`;
  assertNotProd(url, "T2 admin connection (T2_PG_HOST/T2_PG_PORT/T2_PG_ADMIN_USER)");
  return url;
}

function pgBin(name) {
  return process.env.T2_PG_BIN_DIR ? `${process.env.T2_PG_BIN_DIR}/${name}` : name;
}

function run(cmd, args) {
  return execFileSync(pgBin(cmd), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function newRunId() {
  const epochSeconds = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${epochSeconds}_${rand}`;
}

function dbNameForRun(runId) {
  return `${RUN_DB_PREFIX}${runId}`;
}

export function runDbUrl(runId) {
  const url = `postgresql://${ADMIN_USER}@${ADMIN_HOST}:${ADMIN_PORT}/${dbNameForRun(runId)}`;
  assertNotProd(url, "disposable run-DB URL");
  return url;
}

// Creates the run's disposable database. Caller is responsible for then
// applying the schema (prisma migrate deploy) and loading data into it -
// this function only owns the CREATE DATABASE / DROP DATABASE lifecycle.
export function createRunDb(runId) {
  const name = dbNameForRun(runId);
  assertNotProd(adminUrl(name), "disposable run-DB name target");
  run("createdb", ["-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, name]);
  return name;
}

export function dropRunDb(runId) {
  const name = dbNameForRun(runId);
  // --if-exists: dropRunDb is called from cleanup/finally paths too, where
  // the DB may already be gone (e.g. a retried cleanup) - that must not be
  // an error.
  run("dropdb", ["--if-exists", "-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, name]);
}

// Every t2_run_* database currently on the server, with the age parsed
// straight out of its name.
export function listRunDbs() {
  const out = run("psql", [
    "-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, "-d", "postgres",
    "-Atc", `select datname from pg_database where datname like '${RUN_DB_PREFIX}%'`,
  ]);
  const now = Date.now();
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((datname) => {
      const runId = datname.slice(RUN_DB_PREFIX.length);
      const epochSeconds = Number(runId.split("_")[0]);
      const ageMinutes = Number.isFinite(epochSeconds) ? (now - epochSeconds * 1000) / 60000 : null;
      return { datname, runId, ageMinutes };
    });
}

// What happens if a run crashes or is interrupted mid-way: its t2_run_*
// database is simply left behind (CREATE DATABASE has already committed by
// the time any later step could fail). This function is the documented
// recovery path - list every run DB older than maxAgeMinutes (default 60;
// no harness run should legitimately take anywhere near that long) and drop
// it. Meant to be run by hand (`node scripts/t2-harness/lib/disposable-db.mjs
// --cleanup-orphans`) after a crash, or periodically as routine hygiene -
// see README.md.
export function cleanupOrphans(maxAgeMinutes = ORPHAN_MAX_AGE_MINUTES_DEFAULT) {
  const dropped = [];
  for (const { datname, runId, ageMinutes } of listRunDbs()) {
    if (ageMinutes === null || ageMinutes >= maxAgeMinutes) {
      dropRunDb(runId);
      dropped.push({ datname, ageMinutes });
    }
  }
  return dropped;
}

// CLI entry point: `node scripts/t2-harness/lib/disposable-db.mjs --cleanup-orphans [--max-age-minutes=N]`
if (process.argv[1] && process.argv[1].endsWith("disposable-db.mjs")) {
  const args = process.argv.slice(2);
  if (args.includes("--cleanup-orphans")) {
    const maxAgeArg = args.find((a) => a.startsWith("--max-age-minutes="));
    const maxAge = maxAgeArg ? Number(maxAgeArg.split("=")[1]) : ORPHAN_MAX_AGE_MINUTES_DEFAULT;
    const dropped = cleanupOrphans(maxAge);
    if (dropped.length === 0) {
      console.log(`[t2-harness] no orphaned run DBs older than ${maxAge} minutes.`);
    } else {
      console.log(`[t2-harness] dropped ${dropped.length} orphaned run DB(s):`);
      for (const d of dropped) console.log(`  ${d.datname}  (age ${d.ageMinutes.toFixed(1)} min)`);
    }
  } else if (args.includes("--list")) {
    for (const r of listRunDbs()) {
      console.log(`${r.datname}  age=${r.ageMinutes === null ? "unknown" : r.ageMinutes.toFixed(1) + "min"}`);
    }
  } else {
    console.log("Usage: node scripts/t2-harness/lib/disposable-db.mjs --cleanup-orphans [--max-age-minutes=N] | --list");
    process.exit(1);
  }
}
