// The pick-category backfill's --combined-yardage mode (PICK_CATEGORY_VERSION 3):
// it must rewrite ONLY the PLAYER_PROP picks stored as TD_PROP whose category is
// now RUSH_REC_YDS_PROP / PASS_RUSH_YDS_PROP, by id, and leave every other pick -
// a real TD prop, a passing-TD prop, a moneyline, a combined prop already at
// version 3, a combined prop not stored as TD_PROP - exactly as it was (category,
// version and updatedAt). Its --verify count must say how many it would change.
//
// DB-backed and WRITING: creates its own user/capper/picks (ids prefixed
// `__BackfillCombo__`), passes them to the engine via `scope` so nothing else is
// read, and deletes them by exact id. Refuses to run unless DATABASE_URL is local.
//   npx tsx src/server/data/backfill-combined-yardage-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PICK_CATEGORY_VERSION } from "@/server/data/stats";
import {
  backfillPickCategory,
  COMBINED_YARDAGE_CATEGORIES,
  COMBINED_YARDAGE_SCOPE,
  verifyPickCategory,
} from "@/server/data/backfill-pick-category";

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
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const PREFIX = "__BackfillCombo__";
const USER_ID = `${PREFIX}user`;
const CAPPER_ID = `${PREFIX}capper`;
const OLD = PICK_CATEGORY_VERSION - 1;
// The CLI's scope, narrowed to this test's own rows.
const scope: Prisma.PickWhereInput = { AND: [COMBINED_YARDAGE_SCOPE, { userId: USER_ID }] };

type Row = Partial<Prisma.PickUncheckedCreateInput> & { id: string };
const ROWS: Row[] = [
  // Rewritten: combined yards stored as TD_PROP at the old version.
  { id: `${PREFIX}rushrec`, betType: "PLAYER_PROP", propMarket: "RUSH_REC_YDS", betDetail: "Saquon Barkley Over 90 rushing + receiving yards", category: "TD_PROP", categoryVersion: OLD },
  { id: `${PREFIX}passrush-text`, betType: "PLAYER_PROP", propMarket: null, betDetail: "Josh Allen Over 249.5 Passing + Rushing Yards", category: "TD_PROP", categoryVersion: OLD },
  // Untouched: still TD_PROP under version 3.
  { id: `${PREFIX}td`, betType: "PLAYER_PROP", propMarket: "TD", betDetail: "Puka Nacua Anytime TD", category: "TD_PROP", categoryVersion: OLD },
  { id: `${PREFIX}passtds`, betType: "PLAYER_PROP", propMarket: "PASS_TDS", betDetail: "Jared Goff Over 1.5 Passing TDs", category: "TD_PROP", categoryVersion: OLD },
  // Untouched: out of scope (not a prop, or not stored as TD_PROP, or already current).
  { id: `${PREFIX}ml`, betType: "MONEYLINE", odds: -150, betDetail: "Lions ML", category: "FAV_ML", categoryVersion: OLD },
  { id: `${PREFIX}rushrec-null`, betType: "PLAYER_PROP", propMarket: "RUSH_REC_YDS", betDetail: "Kyren Williams over 89.5 rushing and receiving yards", category: null, categoryVersion: OLD },
  { id: `${PREFIX}rushrec-current`, betType: "PLAYER_PROP", propMarket: "RUSH_REC_YDS", betDetail: "Aaron Jones over 93.5 rushing + receiving yards", category: "RUSH_REC_YDS_PROP", categoryVersion: PICK_CATEGORY_VERSION },
];
const REWRITTEN: Record<string, string> = { [`${PREFIX}rushrec`]: "RUSH_REC_YDS_PROP", [`${PREFIX}passrush-text`]: "PASS_RUSH_YDS_PROP" };
const ids = ROWS.map((r) => r.id);

let sportId = "";
let createdSport = false;

const snapshot = async () =>
  prisma.pick.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" }, select: { id: true, category: true, categoryVersion: true, updatedAt: true } });

async function main() {
  const existing = await prisma.sport.findUnique({ where: { name: "NFL" } });
  const sport = existing ?? (await prisma.sport.create({ data: { name: "NFL" } }));
  createdSport = !existing;
  sportId = sport.id;
  await prisma.user.create({ data: { id: USER_ID, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  await prisma.capper.create({ data: { id: CAPPER_ID, userId: USER_ID, name: "Combined-yardage fixture", source: "OTHER" } });
  await prisma.pick.createMany({
    data: ROWS.map((r) => ({
      userId: USER_ID,
      capperId: CAPPER_ID,
      sportId,
      homeTeam: "Detroit Lions",
      awayTeam: "Green Bay Packers",
      odds: -110,
      units: 1,
      gameTime: new Date("2026-10-18T17:00:00Z"),
      ...r,
    })) as Prisma.PickCreateManyInput[],
  });

  // Verify (read-only): the would-change count, by target category.
  const v = await verifyPickCategory({ batchSize: 2, scope });
  check("verify: in-scope rows are the four TD_PROP props", v.total, 4);
  check("verify: two would change", v.staleChanges, 2);
  check(
    "verify: one to each combined category",
    COMBINED_YARDAGE_CATEGORIES.map((c) => v.staleChangePairs.get("TD_PROP -> " + c) ?? 0),
    [1, 1]
  );

  const before = await snapshot();

  // Dry run: names the two, writes nothing.
  const lines: string[] = [];
  const dry = await backfillPickCategory({ apply: false, batchSize: 1, scope, onlyCategories: COMBINED_YARDAGE_CATEGORIES, log: (l) => lines.push(l) });
  check("dry run: reads the four, skips two, writes none", [dry.read, dry.skipped, dry.written], [4, 2, 0]);
  check("dry run: names exactly the two rows", lines.filter((l) => l.trim().startsWith("would write ")).map((l) => l.trim()).sort(), [
    `would write ${PREFIX}passrush-text -> PASS_RUSH_YDS_PROP`,
    `would write ${PREFIX}rushrec -> RUSH_REC_YDS_PROP`,
  ]);
  check("dry run: nothing changed", JSON.stringify(await snapshot()), JSON.stringify(before));

  // Apply: exactly the two, by id; everything else byte-identical.
  const res = await backfillPickCategory({ apply: true, batchSize: 1, scope, onlyCategories: COMBINED_YARDAGE_CATEGORIES });
  check("apply: wrote two", res.written, 2);
  const after = await snapshot();
  for (const row of after) {
    const was = before.find((b) => b.id === row.id)!;
    const target = REWRITTEN[row.id];
    if (target) {
      check(`apply: ${row.id} -> ${target} at version ${PICK_CATEGORY_VERSION}`, [row.category, row.categoryVersion], [target, PICK_CATEGORY_VERSION]);
    } else {
      check(`apply: ${row.id} untouched (category, version, updatedAt)`, [row.category, row.categoryVersion, row.updatedAt.toISOString()], [was.category, was.categoryVersion, was.updatedAt.toISOString()]);
    }
  }

  // Idempotent: nothing left to write.
  const again = await backfillPickCategory({ apply: true, batchSize: 3, scope, onlyCategories: COMBINED_YARDAGE_CATEGORIES });
  check("second apply writes nothing", again.written, 0);
}

async function cleanup() {
  // Exact ids only; the user cascades to its capper and picks.
  const { count } = await prisma.user.deleteMany({ where: { id: USER_ID } });
  if (createdSport) await prisma.sport.deleteMany({ where: { id: sportId } });
  const left = await prisma.pick.count({ where: { id: { in: ids } } });
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
