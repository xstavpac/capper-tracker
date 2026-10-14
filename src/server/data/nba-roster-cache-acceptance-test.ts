// Proof, against a real database, that the NBA migration landed and the cache
// reader reads it - run with DATABASE_URL set:
//   npx tsx src/server/data/nba-roster-cache-acceptance-test.ts
//
// Needs a migrated database (SKIPped by the runner without DATABASE_URL). It
// writes two rows with ids no real player has ("test-nba-cache-..."), reads
// them back through getCachedNbaRoster, soft-deletes and reactivates one through
// the refresh's table adapter, and removes exactly those two rows by
// id - it never touches a real roster row, so it is safe against a database
// that already has the roster loaded.
import { prisma } from "@/lib/prisma";
import { getCachedNbaGradingRoster, getCachedNbaRoster } from "@/server/data/nba-roster-cache";
import { rosterTableFor } from "@/server/data/roster-tables";
import { __clearTtlMemo } from "@/server/data/ttl-memo";

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

    // ---- soft delete (migration 20261016000000) through the real adapter ----
    for (const t of ["nfl_roster_players", "nhl_roster_players", "nba_roster_players", "mlb_roster_players"]) {
      const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = ${t} AND column_name IN ('active', 'removedAt') ORDER BY column_name`;
      check(`${t} has active (NOT NULL, default true) and removedAt (nullable)`, cols, [
        { column_name: "active", is_nullable: "NO", column_default: "true" },
        { column_name: "removedAt", is_nullable: "YES", column_default: null },
      ]);
    }
    const table = rosterTableFor("NBA");
    const mineInDiff = async () => (await table.readForDiff()).filter((r) => TEST_IDS.includes(r.externalId)).sort((a, b) => a.externalId.localeCompare(b.externalId));
    const before = await mineInDiff();
    check("new rows default to active", before.map((r) => r.active), [true, true]);
    const at = new Date("2026-10-15T10:45:00Z");
    await table.deactivate([before[1].id], at);
    const deactivated = await prisma.nbaRosterPlayer.findUnique({ where: { espnPlayerId: TEST_IDS[1] }, select: { active: true, removedAt: true } });
    check("deactivate marks the row inactive with removedAt - the row is still there", deactivated, { active: false, removedAt: at });
    __clearTtlMemo();
    check("getCachedNbaRoster (import matching) leaves the inactive player out", (await getCachedNbaRoster()).filter((p) => TEST_IDS.includes(p.externalPlayerId)).map((p) => p.externalPlayerId), [TEST_IDS[0]]);
    check("getCachedNbaGradingRoster still has him", (await getCachedNbaGradingRoster()).filter((p) => TEST_IDS.includes(p.externalPlayerId)).map((p) => p.externalPlayerId).sort(), TEST_IDS);
    await table.updateRow(before[1].id, { fullName: "Test Center Jr.", firstName: "Test", lastName: "Center Jr.", team: "Boston Celtics", position: "C" });
    const reactivated = await prisma.nbaRosterPlayer.findUnique({ where: { espnPlayerId: TEST_IDS[1] }, select: { active: true, removedAt: true, team: true } });
    check("updateRow reactivates: active again, removedAt cleared, new data", reactivated, { active: true, removedAt: null, team: "Boston Celtics" });
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
