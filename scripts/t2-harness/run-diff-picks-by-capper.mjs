// T2 harness orchestrator for the picks-by-capper migration
// (getCapperLeagueRecords / getCapperCategoryRecords - docs/design/picks-by-capper-egress.md
// §8) - same disposable-DB-per-run lifecycle and diff mechanism as run-diff.mjs
// (create disposable DB -> load data -> capture both impls -> structural diff
// -> drop DB, in a `finally` block), just pointed at capture-picks-by-capper.ts
// instead of capture-output.ts, since the request shape here (leagueEntries /
// categoryPairs) shares nothing with the Cappers-page functions run-diff.mjs
// drives. A separate script rather than a flag on run-diff.mjs, to avoid
// touching that already-validated orchestrator for an unrelated data shape.
//
// Usage:
//   node scripts/t2-harness/run-diff-picks-by-capper.mjs --source=fixtures --impl-old=legacy --impl-new=sql
import { execFileSync, spawnSync } from "node:child_process";
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

// fixtures.ts predates the `category` column (design doc §8's setup note) -
// stamp every fixture pick before capture, same as production's one-time
// backfill, or the SQL path sees NULL categories everywhere.
function runBackfill(dbUrl) {
  assertNotProd(dbUrl, "backfill-pick-category target");
  execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "backfill-pick-category.ts"), "--apply"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
  });
}

function captureOutput(dbUrl, implName, userSelector) {
  assertNotProd(dbUrl, "capture-picks-by-capper target");
  const args = ["--import", "tsx", join(HERE, "capture-picks-by-capper.ts"), `--impl=${implName}`, ...userSelector];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(res.stderr);
    throw new Error(`capture-picks-by-capper.ts failed for --impl=${implName} (exit ${res.status})`);
  }
  if (res.stderr) process.stderr.write(res.stderr);
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
      console.log(`[t2-harness] applying schema...`);
      applySchema(dbUrl);
      console.log(`[t2-harness] loading synthetic fixtures...`);
      loadFixtures(dbUrl);
      console.log(`[t2-harness] stamping pick categories (backfill --apply)...`);
      runBackfill(dbUrl);
    } else {
      throw new Error(`unknown --source: ${source} (this script only supports "fixtures" - no anonymized snapshot exists yet, see README.md)`);
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
  const implOld = typeof args["impl-old"] === "string" ? args["impl-old"] : "legacy";
  const implNew = typeof args["impl-new"] === "string" ? args["impl-new"] : "sql";
  const keepDb = args["keep-db"] === true;
  const userSelector =
    typeof args["user-id"] === "string" ? [`--user-id=${args["user-id"]}`] : typeof args["fixture-user"] === "string" ? [`--fixture-user=${args["fixture-user"]}`] : ["--fixture-user=A"];

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

if (process.argv[1] && process.argv[1].endsWith("run-diff-picks-by-capper.mjs")) {
  cliMain();
}
