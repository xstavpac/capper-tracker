// The /picks "at a glance" row's statements (picks-glance.ts).
//
//   Winners / Losers: net units over the day's graded picks by GAME time (Eastern day), ranked and
//   cut to five in the database; ties broken by wins (losses for Losers) then name, the same on
//   every load; pending picks, test cappers, other days and other users in neither list.
//
//   Most Backed: the day's pending picks whose game has not started, grouped by game + market +
//   side from stored fields, distinct cappers counted, the side's most common line, cut to five;
//   and every row's count is the count the ledger's "N cappers on this side" pill shows.
//
// DB-backed and WRITING: creates its own users/cappers/picks (ids prefixed `__PicksGlance__`) and
// deletes them by exact id at the end. Refuses to run unless DATABASE_URL points at localhost. Run
// against a disposable local Postgres with migrations applied:
//   npx tsx --env-file=.env src/server/data/picks-glance-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { easternDayStart } from "@/lib/dates";
import { getDayWinnersAndLosers, getMostBacked, type GlanceCapper, type MostBackedRow } from "@/server/data/picks-glance";
import { consensusHints, sideLabel, type LedgerPickInput } from "@/lib/pick-display";

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
const backedUser = PREFIX + "backed";
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
  for (const u of [userId, otherUser, backedUser]) {
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

  await mostBacked(mlb);
}

// ---- Most Backed ---------------------------------------------------------------------------------
type Market = { betType: Row["betType"]; betDetail: string; line?: number; period?: Row["period"]; pickedSide?: Row["pickedSide"]; category?: string };
const backedLine = (rows: MostBackedRow[]) => rows.map((r) => `${sideLabel(r)} [${r.betType}/${r.period}] ${r.awayTeam} @ ${r.homeTeam} x${r.cappers}`);

async function mostBacked(mlb: string) {
  await prisma.user.create({ data: { id: backedUser, supabaseId: `${PREFIX}sb-b`, email: `${PREFIX}b@example.invalid` } });
  const NOW = new Date(D0 + 10 * HOUR);
  const A = { homeTeam: "Bills", awayTeam: "Chiefs", at: D0 + 20 * HOUR };
  const B = { homeTeam: "Giants", awayTeam: "Dodgers", at: D0 + 18 * HOUR }; // the earlier start
  const STARTED = { homeTeam: "Mets", awayTeam: "Cubs", at: D0 + 9 * HOUR }; // an hour before NOW
  const TOMORROW = { homeTeam: "Bills", awayTeam: "Chiefs", at: D1 + 20 * HOUR };

  const ids: string[] = [];
  for (const [i, name] of ["One", "Two", "Three", "Four", "Tester"].entries()) {
    ids.push(`${PREFIX}b-${i}`);
    await prisma.capper.create({ data: { id: ids[i], userId: backedUser, name, source: "OTHER", isTest: name === "Tester" } });
  }
  const [c1, c2, c3, c4, tester] = ids;
  const rows: Row[] = [];
  const add = (capperId: string, g: { homeTeam: string; awayTeam: string; at: number }, m: Market, status: Status = "PENDING") => {
    rows.push({ ...pick(backedUser, capperId, mlb, status, g.at), homeTeam: g.homeTeam, awayTeam: g.awayTeam, betType: m.betType, betDetail: m.betDetail, line: m.line ?? null, period: m.period ?? "FULL_GAME", pickedSide: m.pickedSide ?? null, category: m.category ?? null });
  };
  const spreadAway = (line: number): Market => ({ betType: "SPREAD", betDetail: "Chiefs " + line, line, pickedSide: "AWAY", category: "SPREAD_MINUS" });
  const over = (line: number): Market => ({ betType: "TOTAL", betDetail: "Over " + line, line, category: "OVER" });
  const mlAway: Market = { betType: "MONEYLINE", betDetail: "Chiefs ML", pickedSide: "AWAY", category: "FAV_ML" };
  const mlHome: Market = { betType: "MONEYLINE", betDetail: "Giants ML", pickedSide: "HOME", category: "DOG_ML" };
  const nrfi: Market = { betType: "NRFI", betDetail: "NRFI", category: "NRFI" };
  const halfOver: Market = { betType: "TOTAL", betDetail: "1H over 4.5", line: 4.5, period: "FIRST_HALF", category: "FIRST_HALF_OVER" };

  // Game A. Chiefs spread: three cappers, two lines (-3.5 twice plus a second -3.5 pick by One, -3 once).
  add(c1, A, spreadAway(-3.5));
  add(c1, A, spreadAway(-3.5)); // the same capper twice: still one capper
  add(c2, A, spreadAway(-3.5));
  add(c3, A, spreadAway(-3));
  add(c4, A, { betType: "SPREAD", betDetail: "Bills +3.5", line: 3.5, pickedSide: "HOME", category: "SPREAD_PLUS" }); // the other side: 1
  // Over: three cappers, 45 the most common line. Ties the spread on cappers and start: "chiefs" < "over".
  add(c1, A, over(44.5));
  add(c2, A, over(45));
  add(c4, A, over(45));
  add(c3, A, { betType: "TOTAL", betDetail: "Under 45", line: 45, category: "UNDER" }); // the other side: 1
  add(c1, A, mlAway);
  add(c2, A, mlAway); // 2, at the later start: sixth, cut
  add(c3, A, mlAway, "WIN"); // graded: not pending
  // Game B. NRFI: five cappers, the test capper among them (the pill counts every capper too).
  for (const c of [c1, c2, c3, c4, tester]) add(c, B, nrfi);
  add(c1, B, mlHome);
  add(c2, B, mlHome);
  add(c1, B, halfOver);
  add(c2, B, halfOver); // its own market: the period is part of the key
  // No stored side: counted as upcoming, never ranked.
  add(c1, B, { betType: "TEAM_TOTAL", betDetail: "Dodgers over 4.5", line: 4.5, category: "TEAM_TOTAL" });
  add(c2, B, { betType: "TEAM_TOTAL", betDetail: "Dodgers over 4.5", line: 4.5, category: "TEAM_TOTAL" });
  add(c1, B, { betType: "PLAYER_PROP", betDetail: "Ohtani anytime HR", category: "TD_PROP" });
  // Not upcoming on this day at all.
  for (const c of [c1, c2, c3, c4]) add(c, STARTED, { betType: "MONEYLINE", betDetail: "Mets ML", pickedSide: "HOME", category: "FAV_ML" });
  for (const c of [c1, c2, c3, c4]) add(c, TOMORROW, mlAway);
  await prisma.pick.createMany({ data: rows });

  const got = await getMostBacked(backedUser, DAY_KEY, DAY_KEY, NOW);
  same(
    "most backed: cappers desc, then earliest start, then label; one row per side with its most common line; five at most",
    backedLine(got.rows),
    [
      "No run in the 1st inning [NRFI/FULL_GAME] Dodgers @ Giants x5",
      "Chiefs -3.5 [SPREAD/FULL_GAME] Chiefs @ Bills x3",
      "Over 45 [TOTAL/FULL_GAME] Chiefs @ Bills x3",
      "Giants [MONEYLINE/FULL_GAME] Dodgers @ Giants x2",
      "Over 4.5 [TOTAL/FIRST_HALF] Dodgers @ Giants x2",
    ]
  );
  const upcoming = rows.filter((r) => r.status === "PENDING" && (r.gameTime as Date).getTime() > NOW.getTime() && (r.gameTime as Date).getTime() < D1).length;
  same("most backed: the footer counts every pending pick still to start that day, ranked or not", got.upcoming, upcoming);
  same("most backed: start times come back as the instants stored", got.rows.map((r) => r.gameTime.getTime()), [B.at, A.at, A.at, B.at, B.at]);
  const again = await Promise.all(Array.from({ length: 5 }, () => getMostBacked(backedUser, DAY_KEY, DAY_KEY, NOW)));
  check("most backed: tied rows keep their order on every load", again.every((r) => JSON.stringify(r) === JSON.stringify(got)));

  // The pill: consensusHints over the same upcoming picks, as the ledger loads them.
  const loaded = await prisma.pick.findMany({ where: { userId: backedUser, status: "PENDING", gameTime: { gt: NOW, lt: new Date(D1) } } });
  const inputs: LedgerPickInput[] = loaded.map((p) => ({ id: p.id, capperId: p.capperId, sportName: "MLB", homeTeam: p.homeTeam, awayTeam: p.awayTeam, betType: p.betType, betDetail: p.betDetail, line: p.line, period: p.period, pickedSide: p.pickedSide, odds: p.odds, status: p.status, gameTime: p.gameTime }));
  const hints = consensusHints(inputs);
  const pillCount = (r: MostBackedRow) => {
    const mine = loaded.filter(
      (p) =>
        p.homeTeam === r.homeTeam && p.awayTeam === r.awayTeam && p.gameTime.getTime() === r.gameTime.getTime() && p.betType === r.betType && p.period === r.period &&
        (r.side === "HOME" || r.side === "AWAY" ? p.pickedSide === r.side : r.side === "OVER" || r.side === "UNDER" ? (p.betDetail ?? "").toLowerCase().includes(r.side.toLowerCase()) : true)
    );
    return Array.from(new Set(mine.map((p) => hints.get(p.id) ?? ""))).map((h) => parseInt(h, 10));
  };
  same("most backed: each row's count is the one its picks' consensus pills show", got.rows.map(pillCount), got.rows.map((r) => [r.cappers]));

  same("most backed: after the last start nothing is upcoming", await getMostBacked(backedUser, DAY_KEY, DAY_KEY, new Date(A.at)), { upcoming: 0, rows: [] });
  const tomorrow = await getMostBacked(backedUser, NEXT_KEY, NEXT_KEY, NOW);
  same("most backed: the next day has only its own game", [backedLine(tomorrow.rows), tomorrow.upcoming], [["Chiefs [MONEYLINE/FULL_GAME] Chiefs @ Bills x4"], 4]);
  same("most backed: another user's picks are not counted", await getMostBacked(otherUser, DAY_KEY, DAY_KEY, NOW), { upcoming: 0, rows: [] });
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
