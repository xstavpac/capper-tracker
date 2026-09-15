// Proof of the two T3 field-equivalence audit constraints
// (pick-aggregates-cappers-adapter.ts): (a) getSportCategoryPanelData must
// explicitly join capperId against a separately-fetched roster for
// capper.name, since T3's dataset carries only the capperId scalar, and
// (b) every window (ALL especially) must keep showing a zero-pick capper by
// iterating the roster array, never dataset.byCapperId.keys() (which has no
// entry for a capper with zero picks).
//
// Pure: prisma.pick.findMany / prisma.capper.findMany are swapped for spies
// backed by an in-memory fixture before each call, so no database is
// touched. Run with:
//   npx tsx src/server/data/pick-aggregates-cappers-adapter-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import { getCapperLeaderboardTable, getSportCategoryPanelData } from "@/server/data/pick-aggregates-cappers-adapter";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const USER_ID = "user-1";

type FakeCapper = { id: string; userId: string; name: string; colorTag: string | null; isFavorite: boolean };
type FakePick = Record<string, unknown> & {
  id: string;
  userId: string;
  capperId: string;
  status: string;
  gameTime: Date;
  gradedAt: Date | null;
  sport: { name: string };
};

let pickBase = 0;
function makePick(overrides: Partial<FakePick> & { capperId: string }): FakePick {
  pickBase++;
  return {
    id: `pick-${pickBase}`,
    userId: USER_ID,
    sportId: "sport-1",
    leagueId: null,
    homeTeam: "Home",
    awayTeam: "Away",
    betType: "MONEYLINE",
    betDetail: null,
    odds: -110, // favorite by odds sign -> FAV_ML
    line: null,
    period: "FULL_GAME",
    sportsbook: null,
    units: 1,
    datePosted: new Date("2026-01-01T00:00:00Z"),
    gameTime: new Date("2026-01-01T00:00:00Z"),
    notes: null,
    status: "WIN",
    gradedAt: new Date("2026-01-02T00:00:00Z"),
    gradedViaFuzzyMatch: null,
    pickedSide: null,
    mlFavoredSide: null,
    playerName: null,
    propMarket: null,
    sport: { name: "MLB" },
    ...overrides,
  } as FakePick;
}

function installPrismaSpies(roster: FakeCapper[], picks: FakePick[]) {
  (prisma.capper as unknown as { findMany: (args: { where?: Record<string, unknown> }) => Promise<FakeCapper[]> }).findMany = async (
    args
  ) => {
    const where = args.where ?? {};
    return roster
      .filter((c) => (!where.userId || c.userId === where.userId))
      .filter((c) => where.isFavorite === undefined || c.isFavorite === where.isFavorite)
      .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || a.name.localeCompare(b.name));
  };

  (prisma.pick as unknown as { findMany: (args: { where?: Record<string, unknown> }) => Promise<FakePick[]> }).findMany = async (
    args
  ) => {
    const where = args.where ?? {};
    const sportName = (where.sport as { name?: string } | undefined)?.name;
    const capperIdIn = (where.capperId as { in?: string[] } | undefined)?.in;
    return picks
      .filter((p) => !where.userId || p.userId === where.userId)
      .filter((p) => !sportName || p.sport.name === sportName)
      .filter((p) => !capperIdIn || capperIdIn.includes(p.capperId));
  };
}

async function testZeroPickCapperShowsInAllWindow() {
  const roster: FakeCapper[] = [
    { id: "cap-active", userId: USER_ID, name: "Active Capper", colorTag: null, isFavorite: false },
    { id: "cap-zero", userId: USER_ID, name: "Zero Pick Capper", colorTag: null, isFavorite: false },
  ];
  const picks: FakePick[] = [makePick({ capperId: "cap-active", status: "WIN" }), makePick({ capperId: "cap-active", status: "LOSS" })];
  installPrismaSpies(roster, picks);

  const entries = await getCapperLeaderboardTable(USER_ID, "ALL");
  const zeroPick = entries.find((e) => e.capperId === "cap-zero");
  expect("zero-pick capper is present in the ALL window (roster-based iteration)", Boolean(zeroPick), true);
  expect(
    "zero-pick capper's decided-pick count is 0",
    zeroPick ? zeroPick.stats.wins + zeroPick.stats.losses + zeroPick.stats.pushes : -1,
    0
  );
  expect("active capper is also present", entries.some((e) => e.capperId === "cap-active"), true);
}

async function testCategoryPanelJoinsRosterForCapperName() {
  const roster: FakeCapper[] = [{ id: "cap-1", userId: USER_ID, name: "Real Roster Name", colorTag: null, isFavorite: false }];
  // 3 decided MONEYLINE-favorite picks clears CATEGORY_LEADERBOARD_MIN_PICKS
  // (3) so cap-1 actually shows up in the FAV_ML leaderboard.
  const picks: FakePick[] = [
    makePick({ capperId: "cap-1", status: "WIN", sport: { name: "MLB" } }),
    makePick({ capperId: "cap-1", status: "WIN", sport: { name: "MLB" } }),
    makePick({ capperId: "cap-1", status: "LOSS", sport: { name: "MLB" } }),
  ];
  installPrismaSpies(roster, picks);

  const panel = await getSportCategoryPanelData(USER_ID, "MLB");
  const favMlEntry = panel.leaderboards.FAV_ML?.find((e) => e.capperId === "cap-1");
  expect("FAV_ML leaderboard has an entry for cap-1", Boolean(favMlEntry), true);
  expect(
    "cap-1's name is resolved via the roster join, not a placeholder",
    favMlEntry?.name,
    "Real Roster Name"
  );
}

async function main() {
  await testZeroPickCapperShowsInAllWindow();
  await testCategoryPanelJoinsRosterForCapperName();

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s)`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
