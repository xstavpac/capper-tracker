// The pick-category backfill's --ml-side mode (PICK_CATEGORY_VERSION 4), end to end:
// legacy full-game moneylines with no mlFavoredSide get their favored side from the
// GameResult ledger, their picked side from their own text, and a category from the
// real pickCategory(); a pick whose game can't be resolved is restamped from what
// it has (null for a placeholder / legacy price) or left alone (a real STATED price).
//
// What it pins:
//   - a dry run reads, reports and writes NOTHING (every row byte-identical);
//   - the apply writes exactly the rows that change, by id, only category,
//     categoryVersion, mlFavoredSide and (where it was null) pickedSide;
//   - rows out of scope (a stored side, another bet type, a first-half ML) are untouched;
//   - no grade changes (status is never written), and a second run writes nothing;
//   - --verify over the moneylines then finds no stamped mismatch.
//
// DB-backed and WRITING: creates its own user/capper/picks/GameResults (ids prefixed
// `__MlSide__`), scopes the engine to that user, and deletes everything by exact id.
// Refuses to run unless DATABASE_URL is local, and prints the host first.
//   npx tsx src/server/data/backfill-ml-side-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { verifyPickCategory } from "@/server/data/backfill-pick-category";
import { backfillMlSide } from "@/server/data/backfill-ml-side";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
const host = hostOf(process.env.DATABASE_URL);
console.log(`DATABASE_URL host: ${host || "(unparseable)"}`);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const PREFIX = "__MlSide__";
const USER_ID = `${PREFIX}user`;
const CAPPER_ID = `${PREFIX}capper`;
const OLD = PICK_CATEGORY_VERSION - 1;
const scope: Prisma.PickWhereInput = { userId: USER_ID };

const HOME = "Fixture Alphas";
const AWAY = "Fixture Betas";
const day = (d: number) => new Date(Date.UTC(2026, 7, d, 23, 5)); // 2026-08-<d> 23:05Z

// Games: g1 favorite HOME (home won 5-3), g2 favorite AWAY (away won 4-2), g3 no favorite on file.
// A pick on day 4 has no GameResult at all.
const GAMES = [
  { id: `${PREFIX}g1`, day: 1, favTeam: HOME, homeScore: 5, awayScore: 3 },
  { id: `${PREFIX}g2`, day: 2, favTeam: AWAY, homeScore: 2, awayScore: 4 },
  { id: `${PREFIX}g3`, day: 3, favTeam: null as string | null, homeScore: 6, awayScore: 1 },
];

type Row = Partial<Prisma.PickUncheckedCreateInput> & { id: string; gameDay: number };
const mk = (name: string, o: Omit<Row, "id">): Row => ({ id: `${PREFIX}${name}`, ...o });
const ROWS: Row[] = [
  // Resolved from the ledger, side from the text (pickedSide was null).
  mk("dog-defaulted", { gameDay: 1, betDetail: "Betas ML", odds: -110, oddsSource: "DEFAULTED", category: "FAV_ML", status: "LOSS" }),
  mk("fav-legacy", { gameDay: 1, betDetail: "Alphas ML", odds: -150, oddsSource: null, category: "FAV_ML", status: "WIN" }),
  mk("fav-away", { gameDay: 2, betDetail: "Betas ML", odds: -120, oddsSource: "STATED", category: "FAV_ML", status: "WIN" }),
  // Resolved, pickedSide already stored (kept as is).
  mk("has-side", { gameDay: 2, betDetail: "whatever", odds: -110, oddsSource: "DEFAULTED", pickedSide: "HOME", category: "FAV_ML", status: "LOSS" }),
  // Not resolvable -> restamped from what it has.
  mk("no-game-placeholder", { gameDay: 4, betDetail: "Alphas ML", odds: -110, oddsSource: "DEFAULTED", category: "FAV_ML", status: "PENDING" }),
  mk("no-game-stated", { gameDay: 4, betDetail: "Alphas ML", odds: -145, oddsSource: "STATED", category: "FAV_ML", status: "PENDING" }),
  mk("text-both-teams", { gameDay: 1, betDetail: "Alphas Betas ML", odds: -135, oddsSource: null, category: "FAV_ML", status: "PENDING" }),
  mk("no-favorite-on-file", { gameDay: 3, betDetail: "Alphas ML", odds: -110, oddsSource: "DEFAULTED", category: "FAV_ML", status: "WIN" }),
  // Out of scope: a stored favored side (even at the old version), another bet type, another period, already current.
  mk("stored-side-old-version", { gameDay: 1, betDetail: "Alphas ML", odds: -110, oddsSource: "DEFAULTED", pickedSide: "HOME", mlFavoredSide: "HOME", category: "FAV_ML", status: "WIN" }),
  mk("total", { gameDay: 1, betType: "TOTAL", betDetail: "Over 8.5", odds: -110, oddsSource: "DEFAULTED", category: "OVER", status: "WIN" }),
  mk("first-half-ml", { gameDay: 1, period: "FIRST_HALF", betDetail: "Alphas ML", odds: -110, oddsSource: "DEFAULTED", category: "F5_ML", status: "WIN" }),
  mk("already-current", { gameDay: 1, betDetail: "Betas ML", odds: -110, oddsSource: "MARKET", pickedSide: "AWAY", mlFavoredSide: "HOME", category: "DOG_ML", categoryVersion: PICK_CATEGORY_VERSION, status: "LOSS" }),
];
const ids = ROWS.map((r) => r.id);
const gameIds = GAMES.map((g) => g.id);

type Snap = { id: string; category: string | null; categoryVersion: number; pickedSide: string | null; mlFavoredSide: string | null; status: string; updatedAt: string };
let sportId = "";
let createdSport = false;

const snapshot = async (): Promise<Snap[]> =>
  (
    await prisma.pick.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { id: true, category: true, categoryVersion: true, pickedSide: true, mlFavoredSide: true, status: true, updatedAt: true },
    })
  ).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
const by = (snap: Snap[], name: string) => snap.find((s) => s.id === `${PREFIX}${name}`)!;
const view = (s: Snap) => [s.category, s.categoryVersion, s.pickedSide, s.mlFavoredSide, s.status];

async function main() {
  const existing = await prisma.sport.findUnique({ where: { name: "MLB" } });
  const sport = existing ?? (await prisma.sport.create({ data: { name: "MLB" } }));
  createdSport = !existing;
  sportId = sport.id;
  await prisma.user.create({ data: { id: USER_ID, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  await prisma.capper.create({ data: { id: CAPPER_ID, userId: USER_ID, name: "Ml-side fixture", source: "OTHER" } });
  await prisma.gameResult.createMany({
    data: GAMES.map((g) => ({
      id: g.id,
      sportKey: "baseball_mlb",
      externalId: g.id,
      homeTeam: HOME,
      awayTeam: AWAY,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      gameDate: day(g.day),
      favTeam: g.favTeam,
    })),
  });
  await prisma.pick.createMany({
    data: ROWS.map(({ gameDay, ...r }) => ({
      userId: USER_ID,
      capperId: CAPPER_ID,
      sportId,
      homeTeam: HOME,
      awayTeam: AWAY,
      betType: "MONEYLINE",
      period: "FULL_GAME",
      units: 1,
      odds: -110,
      categoryVersion: OLD,
      gameTime: day(gameDay),
      ...r,
    })) as Prisma.PickCreateManyInput[],
  });

  const before = await snapshot();

  // ---- Dry run: reports, writes nothing ----
  const lines: string[] = [];
  const dry = await backfillMlSide({ apply: false, batchSize: 3, scope, log: (l) => lines.push(l) });
  check("dry run: reads the 8 in-scope moneylines", dry.read, 8);
  check("dry run: 4 sides resolved from the ledger", dry.resolved, 4);
  check("dry run: reasons for the other 4", Object.fromEntries([...dry.unresolved.entries()].sort()), { NO_FAVORITE: 1, NO_GAME_RESULT: 2, NO_PICK_SIDE: 1 });
  check("dry run: grade parity holds (no outcome changes)", [dry.gradeChanges, dry.gradeVsStatus], [0, 0]);
  check("dry run: 7 rows would be written (4 resolved + 3 restamped to no category)", dry.toWrite, 7);
  check("dry run: nothing written", dry.written, 0);
  check(
    "dry run: category moves",
    Object.fromEntries([...dry.moves.entries()].sort()),
    { "MLB FAV_ML -> (null)": 3, "MLB FAV_ML -> DOG_ML": 2, "MLB FAV_ML -> FAV_ML": 3 }
  );
  const rec = dry.records.get("MLB");
  check("dry run: MLB DOG_ML before/after (this user's picks)", [rec?.before.DOG_ML, rec?.after.DOG_ML], [
    { w: 0, l: 1, p: 0 },
    { w: 0, l: 3, p: 0 },
  ]);
  check("dry run: the report prints the moves and the records", [lines.some((l) => l.includes("Category moves")), lines.some((l) => l.includes("DRY RUN - nothing written"))], [true, true]);
  check("dry run: every row byte-identical (category, version, sides, status, updatedAt)", JSON.stringify(await snapshot()), JSON.stringify(before));

  // ---- Apply ----
  const res = await backfillMlSide({ apply: true, batchSize: 2, scope });
  check("apply: wrote 7", res.written, 7);
  const after = await snapshot();
  const V = PICK_CATEGORY_VERSION;
  // [category, version, pickedSide, mlFavoredSide, status]
  check("dog-defaulted -> DOG_ML, AWAY stored, home favored", view(by(after, "dog-defaulted")), ["DOG_ML", V, "AWAY", "HOME", "LOSS"]);
  check("fav-legacy -> FAV_ML, HOME stored, home favored", view(by(after, "fav-legacy")), ["FAV_ML", V, "HOME", "HOME", "WIN"]);
  check("fav-away -> FAV_ML (picked the away favorite)", view(by(after, "fav-away")), ["FAV_ML", V, "AWAY", "AWAY", "WIN"]);
  check("has-side -> DOG_ML, stored HOME kept, away favored", view(by(after, "has-side")), ["DOG_ML", V, "HOME", "AWAY", "LOSS"]);
  check("no game + placeholder price -> no category, sides untouched", view(by(after, "no-game-placeholder")), [null, V, null, null, "PENDING"]);
  check("no game + STATED -145 -> unchanged, not even re-versioned", view(by(after, "no-game-stated")), ["FAV_ML", OLD, null, null, "PENDING"]);
  check("text names both teams (legacy price) -> no category, sides untouched", view(by(after, "text-both-teams")), [null, V, null, null, "PENDING"]);
  check("no favorite on file + placeholder -> no category", view(by(after, "no-favorite-on-file")), [null, V, null, null, "WIN"]);
  for (const name of ["stored-side-old-version", "total", "first-half-ml", "already-current"]) {
    const was = by(before, name);
    const now = by(after, name);
    check(`out of scope: ${name} untouched (incl. updatedAt)`, JSON.stringify(now), JSON.stringify(was));
  }
  check("no status was written anywhere", after.map((s) => s.status), before.map((s) => s.status));

  // ---- Idempotent ----
  const again = await backfillMlSide({ apply: true, batchSize: 5, scope });
  check("second apply: only the STATED-price row is still in scope, nothing written", [again.read, again.written], [1, 0]);

  // ---- Verify over the moneylines: no stamped row disagrees with pickCategory(row) ----
  const v = await verifyPickCategory({ batchSize: 4, scope: { ...scope, betType: "MONEYLINE", period: "FULL_GAME" } });
  check("verify: no stamped moneyline mismatches", v.mismatches, 0);
  check("verify: the two rows left at the old version (STATED price; stored side) would not change", [v.unstamped, v.staleChanges], [2, 0]);
}

async function cleanup() {
  // Exact ids only; the user cascades to its capper and picks.
  const { count } = await prisma.user.deleteMany({ where: { id: USER_ID } });
  const games = await prisma.gameResult.deleteMany({ where: { id: { in: gameIds } } });
  if (createdSport) await prisma.sport.deleteMany({ where: { id: sportId } });
  const left = await prisma.pick.count({ where: { id: { in: ids } } });
  console.log(`cleanup: deleted ${count} user(s), ${games.count} game result(s); fixture picks left: ${left}`);
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
