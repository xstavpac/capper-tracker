// The ops-console log tables (cron_runs, pick_grade_failures, import_runs and
// two odds_api_usage_log columns) ship in one migration that production
// applies during the deploy that merges it (scripts/deploy-migrate.mjs),
// BEFORE the new code serves. That ordering is only safe while the migration
// is purely additive - this pins it.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/ops-console-schema-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const root = join(__dirname, "..", "..");
const sql = readFileSync(join(root, "prisma/migrations/20261020090000_add_ops_console_logs/migration.sql"), "utf8");
const statements = sql
  .split(";")
  .map((s) => s.replace(/--[^\n]*/g, "").trim())
  .filter(Boolean);

expect("no DROP / RENAME / TRUNCATE / DELETE / UPDATE", statements.filter((s) => /\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE)\b/i.test(s.replace(/ON (DELETE|UPDATE) CASCADE/gi, ""))), []);
expect(
  "new tables only",
  statements.filter((s) => /^CREATE TABLE/i.test(s)).map((s) => /^CREATE TABLE "(\w+)"/i.exec(s)![1]),
  ["cron_runs", "pick_grade_failures", "import_runs"]
);
const alters = statements.filter((s) => /^ALTER TABLE "(\w+)" ADD COLUMN/i.test(s));
expect("the one existing table changed is odds_api_usage_log", alters.map((s) => /^ALTER TABLE "(\w+)"/i.exec(s)![1]), ["odds_api_usage_log"]);
expect("... and its new columns are nullable with no default", /NOT NULL|DEFAULT/i.test(alters[0] ?? ""), false);
expect(
  "every other ALTER only adds a foreign key to a NEW table",
  statements.filter((s) => /^ALTER TABLE/i.test(s) && !/ADD COLUMN/i.test(s)).map((s) => /^ALTER TABLE "(\w+)" ADD CONSTRAINT/i.exec(s)?.[1] ?? s),
  ["pick_grade_failures", "import_runs"]
);
expect(
  "indexes only on the new tables",
  statements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s)).map((s) => /ON "(\w+)"/i.exec(s)![1]),
  ["cron_runs", "pick_grade_failures", "import_runs"]
);

// picks gains a relation field only (no column): every full-row picks read
// keeps its width, and the DB Monitor's full-row rule keeps its count.
expect("picks has no new scalar column", Object.keys(Prisma.PickScalarFieldEnum).includes("gradeFailure"), false);
expect("the new tables are in the client", ["CronRunScalarFieldEnum", "PickGradeFailureScalarFieldEnum", "ImportRunScalarFieldEnum"].every((k) => k in Prisma), true);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nOps console schema checks passed.");
