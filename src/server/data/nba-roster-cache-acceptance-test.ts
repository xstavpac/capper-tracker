// Proof, against a real database, that the NBA migration landed and the cache
// reader reads it - run with DATABASE_URL set:
//   npx tsx src/server/data/nba-roster-cache-acceptance-test.ts
//
// Needs a migrated database (SKIPped by the runner without DATABASE_URL). It
// writes two rows with ids no real player has ("test-nba-cache-..."), reads
// them back through getCachedNbaRoster, and removes exactly those two rows by
// id - it never touches a real roster row, so it is safe against a database
// that already has the roster loaded.
import { prisma } from "@/lib/prisma";
import { getCachedNbaRoster } from "@/server/data/nba-roster-cache";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const TEST_IDS = ["test-nba-cache-1", "test-nba-cache-2"];
const NEW_VALUES = ["REBOUNDS", "THREES_MADE", "STEALS", "BLOCKS", "POINTS_REBOUNDS_ASSISTS", "POINTS_REBOUNDS", "POINTS_ASSISTS", "REBOUNDS_ASSISTS", "DOUBLE_DOUBLE"];

async function main() {
  // ---- the migration ----
  const enumRows = await prisma.$queryRaw<{ value: string }[]>`SELECT unnest(enum_range(NULL::"PropMarket"))::text AS value`;
  const values = enumRows.map((r) => r.value);
  check("the database's PropMarket enum has the nine new values", NEW_VALUES.filter((v) => !values.includes(v)), []);
  check("they are the last nine, in order (appended, nothing reordered)", values.slice(-9), NEW_VALUES);
  check("the NHL values they sit beside are still there", ["POINTS", "ASSISTS", "SAVES"].filter((v) => !values.includes(v)), []);

  const table = await prisma.$queryRaw<{ rls: boolean }[]>`SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'nba_roster_players' AND relkind = 'r'`;
  check("nba_roster_players exists with row-level security on", table, [{ rls: true }]);
  const columns = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'nba_roster_players' ORDER BY ordinal_position`;
  const nhlColumns = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'nhl_roster_players' ORDER BY ordinal_position`;
  check("it has the same columns as nhl_roster_players", columns.map((c) => c.column_name), nhlColumns.map((c) => c.column_name));
  const indexes = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'nba_roster_players' ORDER BY indexname`;
  check("and the same indexes", indexes.map((i) => i.indexname), ["nba_roster_players_espnPlayerId_key", "nba_roster_players_lastName_idx", "nba_roster_players_pkey", "nba_roster_players_team_idx"]);

  // ---- the reader ----
  try {
    await prisma.nbaRosterPlayer.deleteMany({ where: { espnPlayerId: { in: TEST_IDS } } });
    await prisma.nbaRosterPlayer.create({ data: { espnPlayerId: TEST_IDS[0], fullName: "Test Guard", firstName: "Test", lastName: "Guard", team: "LA Clippers", position: "G" } });
    await prisma.nbaRosterPlayer.create({ data: { espnPlayerId: TEST_IDS[1], fullName: "Test Center Jr.", firstName: "Test", lastName: "Center Jr.", team: "Utah Jazz", position: "C" } });

    const roster = await getCachedNbaRoster();
    const mine = roster.filter((p) => TEST_IDS.includes(p.externalPlayerId)).sort((a, b) => a.externalPlayerId.localeCompare(b.externalPlayerId));
    check("getCachedNbaRoster returns the rows in the shared RosterPlayer shape", mine, [
      { playerName: "Test Guard", firstName: "Test", lastName: "Guard", team: "LA Clippers", position: "G", externalPlayerId: TEST_IDS[0] },
      { playerName: "Test Center Jr.", firstName: "Test", lastName: "Center Jr.", team: "Utah Jazz", position: "C", externalPlayerId: TEST_IDS[1] },
    ]);

    // Same per-process memo as the NHL reader: a second call inside the TTL is
    // the same array, not a second table read.
    check("a second call within the TTL is served from the memo", (await getCachedNbaRoster()) === roster, true);

    // espnPlayerId is unique - a second row for the same player is refused.
    let duplicateRefused = false;
    try {
      await prisma.nbaRosterPlayer.create({ data: { espnPlayerId: TEST_IDS[0], fullName: "Dup", firstName: "Dup", lastName: "Dup", team: "Utah Jazz", position: "F" } });
    } catch {
      duplicateRefused = true;
    }
    check("a second row for the same ESPN id is refused", duplicateRefused, true);
  } finally {
    // Exactly the two rows this test wrote, by id.
    await prisma.nbaRosterPlayer.deleteMany({ where: { espnPlayerId: { in: TEST_IDS } } });
  }
  check("the test rows are gone", await prisma.nbaRosterPlayer.count({ where: { espnPlayerId: { in: TEST_IDS } } }), 0);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
