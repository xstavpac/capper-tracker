// T2 harness: the ONLY path production data enters this harness.
//
// Read-only-by-construction (T2 build task, item 0): this script's input is
// exclusively a FILE PATH to a pg_dump/pg_restore-format dump - never a
// connection string, live or otherwise. There is no code path in this
// harness that holds, accepts, or constructs a production Postgres
// connection string. That file must be produced OUTSIDE this harness, by a
// mechanism that is itself structurally incapable of writing back to
// production - in order of preference:
//
//   1. Supabase Dashboard -> Database -> Backups -> Download backup. A
//      point-in-time export the dashboard generates for you; downloading it
//      cannot mutate the source database. No credential of any kind is
//      handled by this harness for this option.
//   2. A read-only Postgres role you (the project owner) create in Supabase
//      once (Dashboard -> Database -> Roles - a role with the built-in
//      `pg_read_all_data` privilege and NOLOGIN removed, LOGIN + a fresh
//      password), then run `pg_dump` yourself, by hand, outside this repo's
//      automation, using that role's connection string. Hand this script the
//      resulting .dump FILE, never the connection string itself.
//
// This script deliberately does NOT accept a --connection-string /
// --database-url flag of any kind, on either option above - that omission is
// the enforcement mechanism, not a convention someone could accidentally
// bypass by passing one in.
//
// Flow: dump file -> temp staging DB (local, disposable) -> anonymize.sql ->
// re-dump the ANONYMIZED staging DB to scripts/t2-harness/.snapshots/ -> drop
// the staging DB. The output of this script (an anonymized .dump file) is
// the reusable "snapshot" artifact that run-diff.mjs's --source=snapshot:<path>
// restores into each run's disposable DB - production is never touched again
// after this one extraction.
//
// Usage:
//   node scripts/t2-harness/extract-from-dump.mjs --dump-file=<path> --label=<name>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotProd } from "./lib/prod-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(HERE, ".snapshots");

const ADMIN_HOST = process.env.T2_PG_HOST ?? "localhost";
const ADMIN_PORT = process.env.T2_PG_PORT ?? "5432";
const ADMIN_USER = process.env.T2_PG_ADMIN_USER ?? "postgres";

function pgBin(name) {
  return process.env.T2_PG_BIN_DIR ? `${process.env.T2_PG_BIN_DIR}/${name}` : name;
}
function run(cmd, args) {
  execFileSync(pgBin(cmd), args, { stdio: "inherit" });
}
function runCapture(cmd, args) {
  return execFileSync(pgBin(cmd), args, { encoding: "utf8" });
}

// A Supabase-hosted dump's TOC always carries a handful of cluster-level
// objects (CREATE EXTENSION for supabase_vault/pgcrypto/etc., their
// COMMENT ON EXTENSION, and Supabase's own EVENT TRIGGERs) that reference
// the `extensions`/`vault` schemas even when --exclude-schema dropped those
// schemas' tables from the dump. None of that is restorable (or wanted) on
// a vanilla local Postgres, so it's filtered out of the restore list here
// rather than passed to pg_restore, which would otherwise error on every
// one of these entries before ever reaching the 7 tables of actual data.
function filterRestoreList(rawList) {
  return rawList
    .split("\n")
    .filter((line) => !/;\s*\d+\s+\d+\s+(EXTENSION|EVENT TRIGGER)\b/.test(line))
    .filter((line) => !/COMMENT - EXTENSION\b/.test(line))
    .join("\n");
}

function stagingUrl(dbName) {
  const url = `postgresql://${ADMIN_USER}@${ADMIN_HOST}:${ADMIN_PORT}/${dbName}`;
  assertNotProd(url, "staging DB URL");
  return url;
}

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=") || true];
    })
  );
  if (!args["dump-file"]) {
    console.error("Usage: node scripts/t2-harness/extract-from-dump.mjs --dump-file=<path> --label=<name>");
    console.error("(dump-file must be a pg_dump/pg_restore-format file - see this script's header for how to produce one read-only.)");
    process.exit(1);
  }
  if (!existsSync(args["dump-file"])) {
    console.error(`[t2-harness] dump file not found: ${args["dump-file"]}`);
    process.exit(1);
  }
  args.label = args.label || "snapshot";
  return args;
}

function main() {
  const { "dump-file": dumpFile, label } = parseArgs();
  const stagingDb = `t2_extract_staging_${Date.now()}`;

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  console.log(`[t2-harness] restoring ${dumpFile} into staging DB ${stagingDb}...`);
  run("createdb", ["-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, stagingDb]);

  const restoreListFile = join(HERE, `.restore-list-${Date.now()}.txt`);
  const filteredList = filterRestoreList(runCapture("pg_restore", ["-l", dumpFile]));
  writeFileSync(restoreListFile, filteredList);

  try {
    try {
      run("pg_restore", [
        "-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER,
        "-d", stagingDb, "--no-owner", "--no-privileges",
        "-L", restoreListFile, dumpFile,
      ]);
    } finally {
      rmSync(restoreListFile, { force: true });
    }

    console.log("[t2-harness] applying anonymize.sql...");
    run("psql", ["-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, "-d", stagingDb, "-v", "ON_ERROR_STOP=1", "-f", join(HERE, "anonymize.sql")]);

    const outFile = join(SNAPSHOTS_DIR, `${label}.dump`);
    console.log(`[t2-harness] dumping anonymized staging DB to ${outFile}...`);
    run("pg_dump", ["-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, "-d", stagingDb, "-Fc", "-f", outFile]);

    console.log(`[t2-harness] done. Anonymized snapshot: ${outFile}`);
    console.log(`[t2-harness] use it via: node scripts/t2-harness/run-diff.mjs --source=snapshot:${outFile} ...`);
  } finally {
    console.log(`[t2-harness] dropping staging DB ${stagingDb}...`);
    run("dropdb", ["--if-exists", "-h", ADMIN_HOST, "-p", ADMIN_PORT, "-U", ADMIN_USER, stagingDb]);
  }
}

main();
