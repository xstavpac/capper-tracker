// Tests for `scripts/backfill-pick-category.ts --verify` (verifyPickCategory):
//   1. it reports the right numbers - total, unstamped, mismatches, capped samples;
//   2. it visits EVERY row for any batch size (keyset paging, same as the #124 fix);
//   3. it performs ZERO writes - proven three ways: the table's full fingerprint
//      (including updatedAt) is identical before and after; the transaction it
//      runs in is read-only at the database level; and a write attempted through
//      that same guard is REJECTED by Postgres. The third is what makes "zero
//      writes" enforced by code rather than by convention.
//
// DB-backed. Creates its own user/capper/picks (ids prefixed `__VerifyPickCat__`),
// scoped via the engine's `scope` option, and deletes them by exact id. Refuses to
// run unless DATABASE_URL is local. Run against a disposable local Postgres with
// migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:5432/capper_verify_groundwork \
//   DIRECT_URL=postgresql://postgres@localhost:5432/capper_verify_groundwork \
//   npx tsx src/server/data/verify-pick-category-acceptance-test.ts
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { runReadOnly, verifyPickCategory } from "@/server/data/backfill-pick-category";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const PREFIX = "__VerifyPickCat__";
const USER_ID = `${PREFIX}user`;
const CAPPER_ID = `${PREFIX}capper`;
const scope: Prisma.PickWhereInput = { userId: USER_ID };

// Row plan. Every row is a real pick whose true category is computed by
// pickCategory(); what varies is what is STORED.
const GOOD = 30; // stored == pickCategory(row) at the current version
const GOOD_NULL = 4; // stored null == pickCategory(row) (a legitimate null) at the current version
const WRONG = 25; // stamped at the current version with the WRONG category -> mismatches
const WRONG_NULL_STORED = 2; // stored null but pickCategory says a real category -> mismatch
const UNSTAMPED = 6; // categoryVersion 0 -> counted as unstamped, never as a mismatch
const TOTAL = GOOD + GOOD_NULL + WRONG + WRONG_NULL_STORED + UNSTAMPED;
const EXPECTED_MISMATCHES = WRONG + WRONG_NULL_STORED;

const idFor = (kind: string, i: number) => `${PREFIX}${kind}-${String((i * 11 + 5) % 89).padStart(3, "0")}-${i}`;

const CATEGORIZED: Partial<Prisma.PickUncheckedCreateInput>[] = [
  { betType: "MONEYLINE", odds: -150 }, // FAV_ML
  { betType: "MONEYLINE", odds: 130 }, // DOG_ML
  { betType: "SPREAD", line: -1.5 }, // SPREAD_MINUS
  { betType: "SPREAD", line: 3.5 }, // SPREAD_PLUS
  { betType: "TOTAL", betDetail: "Over 8.5" }, // OVER
  { betType: "NRFI", betDetail: "NRFI Under 0.5 1st inning" }, // NRFI
];
const NULL_CATEGORY: Partial<Prisma.PickUncheckedCreateInput>[] = [{ betType: "TOTAL", betDetail: "8.5" }]; // no direction -> null

let sportId = "";
let createdSport = false;
const allIds: string[] = [];

async function seed() {
  const gameTime = new Date("2026-01-01T00:00:00Z");
  const base = { userId: USER_ID, capperId: CAPPER_ID, sportId, homeTeam: "H", awayTeam: "A", odds: -110, units: 1, gameTime };
  const rows: Prisma.PickCreateManyInput[] = [];
  const add = (kind: string, i: number, tpl: Partial<Prisma.PickUncheckedCreateInput>, stamp: { category: string | null; categoryVersion: number }) => {
    const id = idFor(kind, i);
    allIds.push(id);
    rows.push({ ...base, ...tpl, id, ...stamp } as Prisma.PickCreateManyInput);
  };
  const correct = (tpl: Partial<Prisma.PickUncheckedCreateInput>) =>
    pickCategory({ betType: "MONEYLINE", period: "FULL_GAME", betDetail: null, odds: -110, line: null, sportName: "MLB", pickedSide: null, mlFavoredSide: null, propMarket: null, ...(tpl as object) } as Parameters<typeof pickCategory>[0]);

  for (let i = 0; i < GOOD; i++) {
    const tpl = CATEGORIZED[i % CATEGORIZED.length];
    add("good", i, tpl, { category: correct(tpl), categoryVersion: PICK_CATEGORY_VERSION });
  }
  for (let i = 0; i < GOOD_NULL; i++) add("goodnull", i, NULL_CATEGORY[0], { category: null, categoryVersion: PICK_CATEGORY_VERSION });
  for (let i = 0; i < WRONG; i++) add("wrong", i, CATEGORIZED[i % CATEGORIZED.length], { category: "TEAM_TOTAL", categoryVersion: PICK_CATEGORY_VERSION });
  for (let i = 0; i < WRONG_NULL_STORED; i++) add("wrongnull", i, CATEGORIZED[0], { category: null, categoryVersion: PICK_CATEGORY_VERSION });
  for (let i = 0; i < UNSTAMPED; i++) add("unstamped", i, CATEGORIZED[i % CATEGORIZED.length], { category: null, categoryVersion: 0 });
  await prisma.pick.createMany({ data: rows });
}

// A fingerprint of every column of every fixture row (updatedAt included), so ANY
// write - even a no-op UPDATE that only bumps updatedAt - changes it.
async function fingerprint(): Promise<string> {
  const rows = await prisma.pick.findMany({ where: scope, orderBy: { id: "asc" } });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function cleanup() {
  const before = await prisma.pick.count({ where: { userId: USER_ID } });
  await prisma.pick.deleteMany({ where: { id: { in: allIds }, userId: USER_ID } });
  await prisma.capper.deleteMany({ where: { id: CAPPER_ID, userId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  if (createdSport) await prisma.sport.deleteMany({ where: { id: sportId } });
  console.log(`cleanup: removed ${before} fixture pick(s) by exact id`);
}

async function main() {
  const existing = await prisma.sport.findUnique({ where: { name: "MLB" } });
  const sport = existing ?? (await prisma.sport.create({ data: { name: "MLB" } }));
  createdSport = !existing;
  sportId = sport.id;
  await prisma.user.create({ data: { id: USER_ID, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  await prisma.capper.create({ data: { id: CAPPER_ID, userId: USER_ID, name: "Verify fixture", source: "OTHER" } });
  await seed();

  // ---- 1. Correct numbers ----------------------------------------------------
  const before = await fingerprint();
  const r = await verifyPickCategory({ batchSize: 7, scope, maxSamples: 20 });
  check(`total rows = ${TOTAL}`, r.total === TOTAL, `got ${r.total}`);
  check("visited every row", r.read === TOTAL, `read ${r.read}`);
  check(`unstamped = ${UNSTAMPED} (categoryVersion 0 is never counted as a mismatch)`, r.unstamped === UNSTAMPED, `got ${r.unstamped}`);
  check(`mismatches = ${EXPECTED_MISMATCHES}`, r.mismatches === EXPECTED_MISMATCHES, `got ${r.mismatches}`);
  check("legitimate null stamps (stored null == computed null) are NOT mismatches", r.mismatches === EXPECTED_MISMATCHES);
  check("samples are capped at 20", r.samples.length === 20, `got ${r.samples.length}`);
  check(
    "every sample is a real mismatch (stored != computed) with the computed value from pickCategory",
    r.samples.every((s) => s.stored !== s.computed && s.storedVersion === PICK_CATEGORY_VERSION)
  );
  check("a stored-null / computed-real mismatch is reported (stored null -> computed FAV_ML)", r.mismatchPairs.get("(null) -> FAV_ML") === WRONG_NULL_STORED, JSON.stringify(Array.from(r.mismatchPairs)));
  const fewSamples = await verifyPickCategory({ batchSize: 100, scope, maxSamples: 3 });
  check("maxSamples is honored", fewSamples.samples.length === 3 && fewSamples.mismatches === EXPECTED_MISMATCHES);

  // ---- 2. Paging visits every row, for any batch size ---------------------------
  for (const batchSize of [1, 2, 7, TOTAL - 1, TOTAL, TOTAL + 1, 500]) {
    const x = await verifyPickCategory({ batchSize, scope });
    check(`batch ${batchSize}: visits all ${TOTAL} rows and finds the same result`, x.read === TOTAL && x.mismatches === EXPECTED_MISMATCHES && x.unstamped === UNSTAMPED, `read ${x.read} mismatches ${x.mismatches} unstamped ${x.unstamped}`);
  }

  // ---- 3. Zero writes -----------------------------------------------------------
  const after = await fingerprint();
  check("ZERO writes: fixture table fingerprint (all columns incl. updatedAt) is unchanged after every verify run", before === after);

  // The guard verifyPickCategory runs inside is read-only at the database level...
  const ro = await runReadOnly((tx) => tx.$queryRaw<{ ro: string }[]>`SELECT current_setting('transaction_read_only') AS ro`);
  check("the verify transaction is read-only (transaction_read_only = on)", ro[0].ro === "on");

  // ...and a write attempted through that very guard is rejected by Postgres.
  const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
    ["pick.updateMany", (tx) => tx.pick.updateMany({ where: { id: allIds[0] }, data: { category: "TAMPERED" } })],
    ["pick.create", (tx) => tx.pick.create({ data: { userId: USER_ID, capperId: CAPPER_ID, sportId, homeTeam: "H", awayTeam: "A", betType: "MONEYLINE", odds: -110, units: 1, gameTime: new Date() } })],
    ["pick.deleteMany", (tx) => tx.pick.deleteMany({ where: { id: allIds[0] } })],
    ["raw UPDATE", (tx) => tx.$executeRaw`UPDATE picks SET category = 'TAMPERED' WHERE id = ${allIds[0]}`],
  ];
  for (const [label, write] of attempts) {
    let rejected = false;
    let message = "";
    try {
      await runReadOnly(write);
    } catch (err) {
      rejected = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(`a write through the read-only guard is rejected by the database (${label})`, rejected && /read-only/i.test(message), message.slice(0, 160));
  }
  check("...and none of those attempts changed anything", (await fingerprint()) === before);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error("cleanup failed", err);
      failures++;
    }
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
