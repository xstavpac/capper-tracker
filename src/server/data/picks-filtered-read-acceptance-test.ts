// /picks read: the narrow select + withCapperAndSportNames gives the page the
// same rows, in the same order, as the old `include: { capper, sport, league }`
// read - on every column the page reads, plus capper.name and sport.name.
//
// Real-database test, run with DATABASE_URL set (run-tests.mjs loads the
// server-only stub):
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/picks-filtered-read-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
//  1. Default day, each filter (capper, status), a two-day range: same rows,
//     same order, same values on every FILTERED_PICK_SELECT column + names.
//  2. Only the selected columns are read (no capper/sport/league objects
//     beyond the two names).
//  3. Fallback: a pick whose capper is NOT in the passed roster (another
//     user's capper - the schema does not rule it out) still gets its real
//     name, as does every pick when the roster and sports lists are empty.
//
// gameTimes are distinct on purpose: both reads order by gameTime alone, so
// tied rows could come back in either order from either query.
import { prisma } from "@/lib/prisma";
import { easternDateRange, easternDayStart } from "@/lib/dates";
import { FILTERED_PICK_SELECT, getFilteredPicksForUser, getSportsWithLeagues, withCapperAndSportNames } from "@/server/data/picks";
import { getCappersForUser } from "@/server/data/cappers";
import type { PickStatus } from "@prisma/client";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const TAG = `pfr-${Date.now()}`;
const DAY = "2031-03-15";
const NEXT_DAY = "2031-03-16";
const COLUMNS = Object.keys(FILTERED_PICK_SELECT);

type Filters = { capperId?: string; status?: PickStatus; startDateKey: string; endDateKey: string };

// The old read, verbatim, projected to what the page reads.
async function referenceRows(userId: string, f: Filters) {
  const range = easternDateRange(f.startDateKey, f.endDateKey);
  const rows = await prisma.pick.findMany({
    where: {
      userId,
      ...(f.capperId ? { capperId: f.capperId } : {}),
      ...(f.status ? { status: f.status } : {}),
      gameTime: { gte: range.start, lt: range.end },
    },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
  return rows.map((r) => ({
    ...Object.fromEntries(COLUMNS.map((c) => [c, r[c as keyof typeof r]])),
    capper: { name: r.capper.name },
    sport: { name: r.sport.name },
  }));
}

async function main() {
  const userIds: string[] = [];
  const sportIds: string[] = [];
  try {
    const u1 = await prisma.user.create({ data: { supabaseId: `${TAG}-u1`, email: `${TAG}-u1@example.test` } });
    const u2 = await prisma.user.create({ data: { supabaseId: `${TAG}-u2`, email: `${TAG}-u2@example.test` } });
    userIds.push(u1.id, u2.id);
    const s1 = await prisma.sport.create({ data: { name: `${TAG} Sport A` } });
    const s2 = await prisma.sport.create({ data: { name: `${TAG} Sport B` } });
    sportIds.push(s1.id, s2.id);
    const league = await prisma.league.create({ data: { name: `${TAG} League`, sportId: s1.id } });

    const capA = await prisma.capper.create({ data: { userId: u1.id, name: "Alpha", source: "OTHER", notes: "n", isFavorite: true } });
    const capB = await prisma.capper.create({ data: { userId: u1.id, name: "beta", source: "OTHER", photoUrl: "https://example.test/b.png" } });
    const foreign = await prisma.capper.create({ data: { userId: u2.id, name: "Foreign Capper", source: "OTHER" } });

    const at = (dayKey: string, hours: number) => new Date(easternDayStart(dayKey).getTime() + hours * 3_600_000);
    const base = { userId: u1.id, homeTeam: "Home Team", awayTeam: "Away Team", odds: -110, units: 1 };
    await prisma.pick.createMany({
      data: [
        { ...base, capperId: capA.id, sportId: s1.id, leagueId: league.id, betType: "SPREAD", betDetail: "Home Team -3.5", line: -3.5, pickedSide: "HOME", gameTime: at(DAY, 13), status: "WIN", gradedAt: at(DAY, 17), category: "FAV_SPREAD", notes: "note", sportsbook: "FD" },
        { ...base, capperId: capB.id, sportId: s2.id, betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, period: "FIRST_HALF", gameTime: at(DAY, 14), status: "LOSS", gradedAt: at(DAY, 18), units: 2.5, odds: 120 },
        { ...base, capperId: capA.id, sportId: s2.id, betType: "PLAYER_PROP", betDetail: "J Doe over 1.5 hits", propMarket: "HITS", playerName: "J Doe", gameTime: at(DAY, 19), gameNumber: 2 },
        { ...base, capperId: capB.id, sportId: s1.id, betType: "MONEYLINE", betDetail: "Away Team ML", pickedSide: "AWAY", mlFavoredSide: "HOME", gameTime: at(DAY, 20), status: "PUSH", gradedAt: at(DAY, 23) },
        // u1's pick on another user's capper: the fallback path.
        { ...base, capperId: foreign.id, sportId: s1.id, betType: "NRFI", betDetail: "NRFI", gameTime: at(DAY, 21) },
        // Next day: in the range case only. Previous day: never.
        { ...base, capperId: capA.id, sportId: s1.id, betType: "SPREAD", gameTime: at(NEXT_DAY, 12) },
        { ...base, capperId: capA.id, sportId: s1.id, betType: "SPREAD", gameTime: at("2031-03-14", 12) },
      ],
    });
    // Another user's pick on the same day must never appear.
    await prisma.pick.create({ data: { ...base, userId: u2.id, capperId: foreign.id, sportId: s1.id, betType: "SPREAD", gameTime: at(DAY, 15) } });

    const [roster, sports] = await Promise.all([getCappersForUser(u1.id), getSportsWithLeagues()]);
    const narrow = async (f: Filters, r = roster, s: { id: string; name: string }[] = sports) =>
      withCapperAndSportNames(await getFilteredPicksForUser(u1.id, f), r, s);

    // 1
    const cases: [string, Filters, number][] = [
      ["default day", { startDateKey: DAY, endDateKey: DAY }, 5],
      ["capper filter", { capperId: capA.id, startDateKey: DAY, endDateKey: DAY }, 2],
      ["status filter", { status: "PENDING", startDateKey: DAY, endDateKey: DAY }, 2],
      ["two-day range", { startDateKey: DAY, endDateKey: NEXT_DAY }, 6],
    ];
    for (const [label, f, n] of cases) {
      const [want, got] = await Promise.all([referenceRows(u1.id, f), narrow(f)]);
      check(`${label}: ${n} rows`, got.length === n && want.length === n, `want ${want.length}, got ${got.length}`);
      check(`${label}: same rows, order and values as the include read`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify({ want, got }));
    }

    // 2
    const day = await narrow({ startDateKey: DAY, endDateKey: DAY });
    const expectedKeys = [...COLUMNS, "capper", "sport"].join(",");
    check("only the selected columns plus the two names", day.every((r) => Object.keys(r).join(",") === expectedKeys), Object.keys(day[0] ?? {}).join(","));
    check("dropped columns are not read (notes, league, user)", day.every((r) => !("notes" in r) && !("league" in r) && !("userId" in r)));
    check("the capper object carries the name only", day.every((r) => Object.keys(r.capper).join(",") === "name" && Object.keys(r.sport).join(",") === "name"));

    // 3
    const foreignRow = day.find((r) => r.capperId === foreign.id);
    check("a pick on a capper outside the roster still gets its real name", foreignRow?.capper.name === "Foreign Capper", JSON.stringify(foreignRow));
    const bare = await narrow({ startDateKey: DAY, endDateKey: DAY }, [], []);
    const want = await referenceRows(u1.id, { startDateKey: DAY, endDateKey: DAY });
    check("empty roster and sports lists: every name read by id, same result", JSON.stringify(bare) === JSON.stringify(want));
  } finally {
    // Users cascade to their cappers and picks; sports cascade to the league.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.sport.deleteMany({ where: { id: { in: sportIds } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
