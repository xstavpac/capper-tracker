// The odds_prop_fetches / odds_prop_lines migration (prisma/migrations/20261111180000_add_odds_prop_lines) is
// additive only: two new tables, their indexes and FK, RLS on both with no policy, and nothing existing touched.
// rls-guard-acceptance-test.ts separately checks RLS against the migrated CI database.
//
// Pure - reads files, no database, no network. Run with:
//   npx tsx src/server/data/odds-prop-lines-migration-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const root = join(__dirname, "..", "..", "..");
const sql = readFileSync(join(root, "prisma/migrations/20261111180000_add_odds_prop_lines/migration.sql"), "utf8");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

expect("creates exactly the two new tables", sql.match(/CREATE TABLE "([a-z_]+)"/g), ['CREATE TABLE "odds_prop_fetches"', 'CREATE TABLE "odds_prop_lines"']);
expect("RLS enabled on both tables", [
  /ALTER TABLE "odds_prop_fetches" ENABLE ROW LEVEL SECURITY;/.test(sql),
  /ALTER TABLE "odds_prop_lines" ENABLE ROW LEVEL SECURITY;/.test(sql),
], [true, true]);
expect("no policy created", /CREATE POLICY/i.test(sql), false);
expect("nothing dropped, altered, deleted or updated", /DROP|ALTER COLUMN|DELETE FROM|UPDATE "|INSERT INTO/i.test(sql), false);
// The only ALTER TABLE statements: the lines -> fetches FK, and the two RLS lines.
const alters = sql.match(/ALTER TABLE "[a-z_]+"/g) ?? [];
expect("ALTER TABLE only on the two new tables", [...new Set(alters)].sort(), ['ALTER TABLE "odds_prop_fetches"', 'ALTER TABLE "odds_prop_lines"']);
expect("claim key: one fetch per (event, market, bucket)", /CREATE UNIQUE INDEX "odds_prop_fetches_eventId_marketKey_bucket_key" ON "odds_prop_fetches"\("eventId", "marketKey", "bucket"\)/.test(sql), true);
expect("reuse lookup index: (event, market, createdAt)", /CREATE INDEX "odds_prop_fetches_eventId_marketKey_createdAt_idx"/.test(sql), true);
expect("exact-line read index: (fetchId, side, point)", /CREATE INDEX "odds_prop_lines_fetchId_side_point_idx" ON "odds_prop_lines"\("fetchId", "side", "point"\)/.test(sql), true);
expect("lines cascade with their fetch", /FOREIGN KEY \("fetchId"\) REFERENCES "odds_prop_fetches"\("id"\) ON DELETE CASCADE/.test(sql), true);
expect("schema maps both models", [/@@map\("odds_prop_fetches"\)/.test(schema), /@@map\("odds_prop_lines"\)/.test(schema)], [true, true]);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
