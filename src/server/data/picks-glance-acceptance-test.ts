// The /picks "at a glance" row's statements (picks-glance.ts).
//
//   Winners / Losers: net units over the day's graded picks by GAME time (Eastern day), ranked and
//   cut to five in the database; ties broken by wins (losses for Losers) then name, the same on
//   every load; pending picks, test cappers, other days and other users in neither list.
//
// DB-backed and WRITING: creates its own users/cappers/picks (ids prefixed `__PicksGlance__`) and
// deletes them by exact id at the end. Refuses to run unless DATABASE_URL points at localhost. Run
// against a disposable local Postgres with migrations applied:
//   npx tsx --env-file=.env src/server/data/picks-glance-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { easternDayStart } from "@/lib/dates";
import { getDayWinnersAndLosers, type GlanceCapper } from "@/server/data/picks-glance";

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
function same(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
}

const PREFIX = "__PicksGlance__";
const HOUR = 3600000;
const DAY_KEY = "2026-03-10";
const NEXT_KEY = "2026-03-11";
const D0 = easternDayStart(DAY_KEY).getTime();
const D1 = easternDayStart(NEXT_KEY).getTime();
type Status = "WIN" | "LOSS" | "PUSH" | "PENDING";
type Row = Prisma.PickCreateManyInput;

const userId = PREFIX + "user";
const otherUser = PREFIX + "other";
const createdSports: string[] = [];
let seq = 0;

async function sportId(name: string): Promise<string> {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return existing.id;
  const made = await prisma.sport.create({ data: { name } });
  createdSports.push(made.id);
  return made.id;
}

function pick(owner: string, capperId: string, sport: string, status: Status, at: number, o: { units?: number; odds?: number } = {}): Row {
  seq++;
  const gameTime = new Date(at);
  return {
    id: `${PREFIX}pick-${String(seq).padStart(4, "0")}`,
    userId: owner,
    capperId,
    sportId: sport,
    homeTeam: "Home",
    awayTeam: "Away",
    betType: "MONEYLINE",
    odds: o.odds ?? 100,
    units: o.units ?? 1,
    // Posted the day before: the day is the GAME's, never the import's.
    datePosted: new Date(D0 - 20 * HOUR),
    gameTime,
    status,
    gradedAt: status === "PENDING" ? null : new Date(at + 3 * HOUR),
  };
}

const line = (rows: GlanceCapper[]) => rows.map((r) => `${r.name} ${r.netUnits} ${r.wins}-${r.losses}-${r.pushes} [${r.sports.join(",")}]`);

async function cleanup() {
  for (const u of [userId, otherUser]) {
    await prisma.pick.deleteMany({ where: { userId: u } });
    await prisma.capper.deleteMany({ where: { userId: u } });
    await prisma.user.deleteMany({ where: { id: u } });
  }
  if (createdSports.length > 0) await prisma.sport.deleteMany({ where: { id: { in: createdSports } } });
}

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });
  await prisma.user.create({ data: { id: otherUser, supabaseId: `${PREFIX}sb-o`, email: `${PREFIX}o@example.invalid` } });
  const mlb = await sportId("MLB");
  const nhl = await sportId("NHL");

  const rows: Row[] = [];
  const noon = D0 + 12 * HOUR;
  const capper = async (name: string, build: (id: string) => Row[], o: { isTest?: boolean; owner?: string } = {}) => {
    const id = `${PREFIX}c-${name.replace(/\W+/g, "-")}`;
    await prisma.capper.create({ data: { id, userId: o.owner ?? userId, name, source: "OTHER", isTest: o.isTest ?? false } });
    rows.push(...build(id));
  };
  const u = userId;

  // Winners. Three cappers at +2: two wins beats one win, then the name decides.
  await capper("Big", (c) => [pick(u, c, mlb, "WIN", noon, { odds: 300 })]); // +3, 1-0
  await capper("Zed two", (c) => [pick(u, c, mlb, "WIN", noon), pick(u, c, nhl, "WIN", noon + HOUR)]); // +2, 2-0, MLB + NHL
  await capper("alpha one", (c) => [pick(u, c, mlb, "WIN", noon, { odds: 200 })]); // +2, 1-0
  await capper("Bravo one", (c) => [pick(u, c, mlb, "WIN", noon, { units: 2 })]); // +2, 1-0
  await capper("Mixed", (c) => [pick(u, c, nhl, "WIN", noon), pick(u, c, nhl, "WIN", noon), pick(u, c, nhl, "LOSS", noon), pick(u, c, nhl, "PUSH", noon)]); // +1, 2-1-1
  await capper("Small", (c) => [pick(u, c, mlb, "WIN", noon, { odds: -200 })]); // +0.5: sixth, cut
  // Losers. Three cappers at -2: two losses beats one, then the name decides.
  await capper("Worst", (c) => [pick(u, c, mlb, "LOSS", noon, { units: 3 })]); // -3, 0-1
  await capper("Yan two", (c) => [pick(u, c, mlb, "LOSS", noon), pick(u, c, mlb, "LOSS", noon)]); // -2, 0-2
  await capper("able one", (c) => [pick(u, c, mlb, "LOSS", noon, { units: 2 })]); // -2, 0-1
  await capper("Baker one", (c) => [pick(u, c, nhl, "LOSS", noon, { units: 2 })]); // -2, 0-1
  await capper("Slip", (c) => [pick(u, c, mlb, "WIN", noon), pick(u, c, mlb, "LOSS", noon, { units: 2 })]); // -1, 1-1
  await capper("Dip", (c) => [pick(u, c, mlb, "LOSS", noon, { units: 0.5 })]); // -0.5: sixth, cut
  // In neither list.
  await capper("Even", (c) => [pick(u, c, mlb, "WIN", noon), pick(u, c, mlb, "LOSS", noon)]); // 0
  await capper("Pending only", (c) => [pick(u, c, mlb, "PENDING", noon, { units: 50 })]);
  await capper("Test account", (c) => [pick(u, c, mlb, "WIN", noon, { units: 99 })], { isTest: true });
  await capper("Zero odds", (c) => [pick(u, c, mlb, "WIN", noon, { odds: 0 })]); // non-finite units
  // The Eastern day: a game at midnight is the day's; 1 ms before is the day before's, and the next
  // midnight is the next day's.
  await capper("Edge", (c) => [pick(u, c, mlb, "WIN", D0 - 1, { units: 40 }), pick(u, c, mlb, "LOSS", D1, { units: 40 })]);
  await capper("Someone else", (c) => [pick(otherUser, c, mlb, "WIN", noon, { units: 77 })], { owner: otherUser });
  await prisma.pick.createMany({ data: rows });

  const day = await getDayWinnersAndLosers(userId, DAY_KEY, DAY_KEY);
  same(
    "winners: top five by net units, then wins, then name; record and leagues on the row",
    line(day.winners),
    ["Big 3 1-0-0 [MLB]", "Zed two 2 2-0-0 [MLB,NHL]", "alpha one 2 1-0-0 [MLB]", "Bravo one 2 1-0-0 [MLB]", "Mixed 1 2-1-1 [NHL]"]
  );
  same(
    "losers: most negative first, then losses, then name; five at most",
    line(day.losers),
    ["Worst -3 0-1-0 [MLB]", "Yan two -2 0-2-0 [MLB]", "able one -2 0-1-0 [MLB]", "Baker one -2 0-1-0 [NHL]", "Slip -1 1-1-0 [MLB]"]
  );
  const again = await Promise.all(Array.from({ length: 5 }, () => getDayWinnersAndLosers(userId, DAY_KEY, DAY_KEY)));
  check("tied rows keep their order on every load", again.every((r) => JSON.stringify(r) === JSON.stringify(day)));

  const next = await getDayWinnersAndLosers(userId, NEXT_KEY, NEXT_KEY);
  same("the next Eastern day: only the game at its midnight", [line(next.winners), line(next.losers)], [[], ["Edge -40 0-1-0 [MLB]"]]);
  const prev = await getDayWinnersAndLosers(userId, "2026-03-09", "2026-03-09");
  same("the day before: only the game 1 ms before midnight", [line(prev.winners), line(prev.losers)], [["Edge 40 1-0-0 [MLB]"], []]);
  const range = await getDayWinnersAndLosers(userId, "2026-03-09", NEXT_KEY);
  check("a range sums its days (Edge nets 0 across all three, so it is in neither list)", ![...range.winners, ...range.losers].some((r) => r.name === "Edge"));
  same("another user sees only their own cappers", line((await getDayWinnersAndLosers(otherUser, DAY_KEY, DAY_KEY)).winners), ["Someone else 77 1-0-0 [MLB]"]);
  same("a day with no picks: both empty", await getDayWinnersAndLosers(userId, "2026-01-01", "2026-01-01"), { winners: [], losers: [] });
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup().catch((err) => {
      console.error(err);
      failures++;
    });
    await prisma.$disconnect();
    if (failures > 0) process.exit(1);
    console.log("\nAll checks passed.");
  });
