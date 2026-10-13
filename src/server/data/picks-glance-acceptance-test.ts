// The /picks "at a glance" row's statements (picks-glance.ts).
//
//   Winners / Losers: net units over the day's graded picks by GAME time (Eastern day), ranked and
//   cut to five in the database; ties broken by wins (losses for Losers) then name, the same on
//   every load; pending picks, test cappers, other days and other users in neither list.
//
//   Most Backed: the consensus sides (2+ distinct cappers) of the day's games that have not started,
//   grouped by game + market + side from stored fields, the side's most common line, cut to five.
//
//   Consensus pills: counted over the whole day (getDayConsensus), so a pill reads the same number
//   under any filter, and every Most Backed row's count is the count on its picks' pills - with the
//   ledger unfiltered and with it filtered down to one capper.
//
// DB-backed and WRITING: creates its own users/cappers/picks (ids prefixed `__PicksGlance__`) and
// deletes them by exact id at the end. Refuses to run unless DATABASE_URL points at localhost. Run
// against a disposable local Postgres with migrations applied:
//   npx tsx --env-file=.env src/server/data/picks-glance-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { easternDayStart } from "@/lib/dates";
import { getDayConsensus, getDayWinnersAndLosers, getMostBacked, type GlanceCapper, type MostBackedRow } from "@/server/data/picks-glance";
import { dayConsensusHints, sideLabel, storedSide, type LedgerPickInput } from "@/lib/pick-display";

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
const soloUser = PREFIX + "solo";
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
  for (const u of [userId, otherUser, backedUser, soloUser]) {
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
  add(c2, A, mlAway);
  add(c3, A, mlAway, "WIN"); // graded by hand before the game: still a capper on that side, as on its pill
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
    "most backed: cappers desc, then earliest start, then label and line; one row per side with its most common line; five at most",
    backedLine(got.rows),
    [
      "No run in the 1st inning [NRFI/FULL_GAME] Dodgers @ Giants x5",
      "Chiefs [MONEYLINE/FULL_GAME] Chiefs @ Bills x3",
      "Chiefs -3.5 [SPREAD/FULL_GAME] Chiefs @ Bills x3",
      "Over 45 [TOTAL/FULL_GAME] Chiefs @ Bills x3",
      "Giants [MONEYLINE/FULL_GAME] Dodgers @ Giants x2", // "1H over" x2 at the same start is sixth: cut
    ]
  );
  const upcoming = rows.filter((r) => r.status === "PENDING" && (r.gameTime as Date).getTime() > NOW.getTime() && (r.gameTime as Date).getTime() < D1).length;
  same("most backed: the footer counts every pending pick still to start that day, ranked or not", got.upcoming, upcoming);
  same("most backed: start times come back as the instants stored", got.rows.map((r) => r.gameTime.getTime()), [B.at, A.at, A.at, A.at, B.at]);
  const again = await Promise.all(Array.from({ length: 5 }, () => getMostBacked(backedUser, DAY_KEY, DAY_KEY, NOW)));
  check("most backed: tied rows keep their order on every load", again.every((r) => JSON.stringify(r) === JSON.stringify(got)));

  // The pills: the day's picks as the ledger loads them, hinted from the day's counts.
  const day = await prisma.pick.findMany({ where: { userId: backedUser, gameTime: { gte: new Date(D0), lt: new Date(D1) } } });
  const asInput = (p: (typeof day)[number]): LedgerPickInput => ({ id: p.id, capperId: p.capperId, sportName: "MLB", homeTeam: p.homeTeam, awayTeam: p.awayTeam, betType: p.betType, betDetail: p.betDetail, line: p.line, period: p.period, pickedSide: p.pickedSide, odds: p.odds, status: p.status, gameTime: p.gameTime, category: p.category });
  const counts = await getDayConsensus(backedUser, DAY_KEY, DAY_KEY);
  // The distinct pill numbers on a row's picks, among the picks a filter leaves on screen.
  const pillsFor = (r: MostBackedRow, onScreen: typeof day) => {
    const hints = dayConsensusHints(onScreen.map(asInput), counts);
    const mine = onScreen.filter((p) => p.homeTeam === r.homeTeam && p.awayTeam === r.awayTeam && p.gameTime.getTime() === r.gameTime.getTime() && p.betType === r.betType && p.period === r.period && storedSide(p) === r.side);
    return Array.from(new Set(mine.map((p) => parseInt(hints.get(p.id) ?? "0", 10))));
  };
  same("pills, no filter: every Most Backed row's picks all read that row's count", got.rows.map((r) => pillsFor(r, day)), got.rows.map((r) => [r.cappers]));
  const onlyOne = day.filter((p) => p.capperId === c1);
  check("the capper filter leaves one capper's picks on every row", got.rows.every((r) => pillsFor(r, onlyOne).length === 1));
  same("pills, filtered to one capper: still the day's count, and still each Most Backed row's count", got.rows.map((r) => pillsFor(r, onlyOne)), got.rows.map((r) => [r.cappers]));
  const pending = day.filter((p) => p.status === "PENDING");
  same("pills, filtered to one result: unchanged", got.rows.map((r) => pillsFor(r, pending)), got.rows.map((r) => [r.cappers]));
  const allHints = dayConsensusHints(day.map(asInput), counts);
  const oneHints = dayConsensusHints(onlyOne.map(asInput), counts);
  const sided = onlyOne.filter((p) => storedSide(p) !== null);
  check("a pill on a stored side reads the same text with and without the capper filter", sided.length > 0 && sided.every((p) => oneHints.get(p.id) === allHints.get(p.id)));
  const text = (betType: string, period = "FULL_GAME") => allHints.get(day.find((p) => p.capperId === c1 && p.betType === betType && p.period === period && p.homeTeam === (betType === "NRFI" || period !== "FULL_GAME" ? B : A).homeTeam)!.id);
  same("pill wording: side / over / NRFI", [text("SPREAD"), text("TOTAL"), text("NRFI"), text("TOTAL", "FIRST_HALF")], ["3 cappers on this side", "3 cappers on this over", "5 cappers on this NRFI", "2 cappers on this over"]);
  const lone = day.find((p) => p.capperId === c4 && p.betType === "SPREAD")!;
  same("a side with one capper has no pill and no day count", [allHints.get(lone.id) ?? null, counts.get([lone.homeTeam, lone.awayTeam, lone.gameTime.getTime(), "SPREAD", "FULL_GAME", "HOME"].join("|")) ?? null], [null, null]);
  // No stored side: the team total keeps the text-derived hint, counted among the picks on screen.
  const teamTotals = day.filter((p) => p.betType === "TEAM_TOTAL");
  same("team totals (no stored side): the hint is still the on-screen count", [teamTotals.map((p) => allHints.get(p.id)), teamTotals.filter((p) => p.capperId === c1).map((p) => oneHints.get(p.id) ?? null)], [["2 cappers on this over", "2 cappers on this over"], [null]]);
  check("the day's counts are one entry per consensus side, never per pick", counts.size > 0 && counts.size < day.length && Array.from(counts.values()).every((n) => n >= 2));

  // Nothing with two cappers: no rows, but the footer still counts what is yet to start.
  await prisma.user.create({ data: { id: soloUser, supabaseId: `${PREFIX}sb-s`, email: `${PREFIX}s@example.invalid` } });
  const solo: Row[] = [];
  for (const [i, g] of [A, B].entries()) {
    const id = `${PREFIX}solo-${i}`;
    await prisma.capper.create({ data: { id, userId: soloUser, name: "Solo " + i, source: "OTHER" } });
    solo.push({ ...pick(soloUser, id, mlb, "PENDING", g.at), homeTeam: g.homeTeam, awayTeam: g.awayTeam, betType: "MONEYLINE", betDetail: "ML", pickedSide: "HOME", category: "FAV_ML" });
  }
  await prisma.pick.createMany({ data: solo });
  same("most backed: one capper a side is not a consensus - no rows, two picks yet to start", await getMostBacked(soloUser, DAY_KEY, DAY_KEY, NOW), { upcoming: 2, rows: [] });
  same("no consensus: no day counts either", (await getDayConsensus(soloUser, DAY_KEY, DAY_KEY)).size, 0);

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
