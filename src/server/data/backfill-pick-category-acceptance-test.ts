// Regression test for the pick-category backfill's paging: ONE --apply pass must
// stamp every eligible row, however many batches it spans.
//
// The original loop paged with `cursor: { id }, skip: 1` over
// `where: categoryVersion < current`. In apply mode the cursor row has just been
// stamped, so it no longer matches that filter and `skip: 1` skipped a real
// unstamped row at every batch boundary (a production run over 6,901 rows at
// batch 500 stamped 6,888 and left 13). Dry run never showed it because nothing
// is stamped there, so the cursor row still matches.
//
// DB-backed and WRITING: creates its own user/capper/picks (ids prefixed
// `__BackfillSkip__`), scoped via the engine's `scope` option so it never touches
// other rows, and deletes them by exact id. Refuses to run unless DATABASE_URL is
// local. Run against a disposable local Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:54329/capper_parity \
//   DIRECT_URL=postgresql://postgres@localhost:54329/capper_parity \
//   npx tsx src/server/data/backfill-pick-category-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { backfillPickCategory } from "@/server/data/backfill-pick-category";

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

const PREFIX = "__BackfillSkip__";
const USER_ID = `${PREFIX}user`;
const CAPPER_ID = `${PREFIX}capper`;
const N = 25;
const CURRENT_ROWS = 3; // already at the current version: must never be touched or counted
const scope: Prisma.PickWhereInput = { userId: USER_ID };

// Ids are deliberately NOT in creation order (a multiplicative shuffle), so a
// paging bug that leaned on insertion order would show up too.
const idFor = (i: number) => `${PREFIX}p-${String((i * 7 + 3) % 97).padStart(3, "0")}-${i}`;
// Exact id lists (not `category != 'SENTINEL_KEEP'`, which SQL evaluates to NULL - i.e. no match - for
// the rows whose category is legitimately null).
const eligibleIds = Array.from({ length: N }, (_, i) => idFor(i));

let sportId = "";
let createdSport = false;

async function seedRows() {
  const templates: Partial<Prisma.PickUncheckedCreateInput>[] = [
    { betType: "MONEYLINE", odds: -150 },
    { betType: "MONEYLINE", odds: 130 },
    { betType: "MONEYLINE", odds: 120, period: "FIRST_HALF" },
    { betType: "SPREAD", line: -1.5 },
    { betType: "SPREAD", line: 3.5 },
    { betType: "TOTAL", betDetail: "Over 8.5" },
    { betType: "TOTAL", betDetail: "8.5" }, // no direction -> category null (a real result)
    { betType: "NRFI", betDetail: "NRFI Under 0.5 1st inning" },
  ];
  const gameTime = new Date("2026-01-01T00:00:00Z");
  await prisma.pick.createMany({
    data: Array.from({ length: N + CURRENT_ROWS }, (_, i) => ({
      id: idFor(i),
      userId: USER_ID,
      capperId: CAPPER_ID,
      sportId,
      homeTeam: "H",
      awayTeam: "A",
      odds: -110,
      units: 1,
      gameTime,
      createdAt: new Date(gameTime.getTime() + ((i * 13) % 29) * 1000),
      ...templates[i % templates.length],
      // The last CURRENT_ROWS are already stamped at the current version with a
      // sentinel category that pickCategory would never produce.
      ...(i >= N ? { category: "SENTINEL_KEEP", categoryVersion: PICK_CATEGORY_VERSION } : { category: "OLD_GARBAGE", categoryVersion: 0 }),
    })) as Prisma.PickCreateManyInput[],
  });
}

async function resetEligible() {
  await prisma.pick.updateMany({ where: { id: { in: eligibleIds } }, data: { category: null, categoryVersion: 0 } });
}

async function expectedCategory(id: string) {
  const p = await prisma.pick.findUniqueOrThrow({ where: { id }, include: { sport: true } });
  return pickCategory({ ...p, sportName: p.sport.name });
}

async function main() {
  const existing = await prisma.sport.findUnique({ where: { name: "MLB" } });
  const sport = existing ?? (await prisma.sport.create({ data: { name: "MLB" } }));
  createdSport = !existing;
  sportId = sport.id;
  await prisma.user.create({ data: { id: USER_ID, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  await prisma.capper.create({ data: { id: CAPPER_ID, userId: USER_ID, name: "Backfill fixture", source: "OTHER" } });
  await seedRows();

  // Dry run reads everything across many batches and writes nothing.
  const dry = await backfillPickCategory({ apply: false, batchSize: 4, scope });
  check(`dry run (batch 4) reads all ${N} eligible rows`, dry.read === N, `read ${dry.read}`);
  check("dry run writes nothing", dry.written === 0 && (await prisma.pick.count({ where: { ...scope, categoryVersion: 0 } })) === N);

  // One --apply pass must stamp every eligible row, for batch sizes that
  // divide N evenly, don't, equal N, exceed N, and are 1.
  for (const batchSize of [1, 4, 5, 7, N, N + 1, 100]) {
    await resetEligible();
    const res = await backfillPickCategory({ apply: true, batchSize, scope });
    check(`batch ${batchSize}: one apply pass reads all ${N}`, res.read === N, `read ${res.read}`);
    check(`batch ${batchSize}: one apply pass writes all ${N}`, res.written === N, `wrote ${res.written}`);
    check(`batch ${batchSize}: nothing left below the current version`, res.remaining === 0, `remaining ${res.remaining}`);
  }

  // Correctness of what was written (last apply above left every row stamped).
  const stamped = await prisma.pick.findMany({ where: { id: { in: eligibleIds } }, select: { id: true, category: true, categoryVersion: true } });
  let allMatch = true;
  for (const row of stamped) {
    if (row.categoryVersion !== PICK_CATEGORY_VERSION || row.category !== (await expectedCategory(row.id))) allMatch = false;
  }
  check(`every stamped row equals pickCategory(row) at version ${PICK_CATEGORY_VERSION}`, allMatch && stamped.length === N);
  check("null-category rows were stamped too (version set, category null)", stamped.some((r) => r.category === null && r.categoryVersion === PICK_CATEGORY_VERSION));
  const kept = await prisma.pick.count({ where: { ...scope, category: "SENTINEL_KEEP", categoryVersion: PICK_CATEGORY_VERSION } });
  check("rows already at the current version were left untouched", kept === CURRENT_ROWS, `kept ${kept}`);

  // Idempotent: a further pass finds nothing.
  const again = await backfillPickCategory({ apply: true, batchSize: 4, scope });
  check("second apply pass reads and writes 0", again.read === 0 && again.written === 0 && again.toStamp === 0);
}

async function cleanup() {
  // Exact ids only; the user cascades to its capper and picks.
  const { count } = await prisma.user.deleteMany({ where: { id: USER_ID } });
  if (createdSport) await prisma.sport.deleteMany({ where: { id: sportId } });
  const left = await prisma.pick.count({ where: { userId: USER_ID } });
  console.log(`cleanup: deleted ${count} user(s); fixture picks left: ${left}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures > 0 ? `\n${failures} assertion(s) failed.` : "\nAll assertions passed.");
    process.exit(failures > 0 ? 1 : 0);
  });
