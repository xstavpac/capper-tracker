// Read-only check that persistGradedDecayDeltaGames's new scoped read agrees
// with the old full scan on REAL data. Runs inside a READ ONLY transaction
// (Postgres rejects any write), and never calls persistGradedDecayDeltaGames
// itself - that function writes. Instead it re-issues the exact same queries:
//   old: every rated game (favTeam + totalLine set), filtered in memory
//   new: count() for `scanned`, and id notIn [already-persisted] for pending
// and asserts they agree. Usage (point DATABASE_URL at prod yourself):
//   npx tsx scripts/verify-decay-delta-graded-scope.ts
import { prisma } from "@/lib/prisma";
import { GRADED_GAME_SELECT } from "@/server/data/model-engine/decay-delta-predictions";

const MODEL_ID = "decay-delta-v1";
const sportKey = "baseball_mlb";
let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} (${detail})`);
  if (!pass) failures++;
}

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

    const eligible = { sportKey, favTeam: { not: null }, totalLine: { not: null } };

    // OLD path
    const all = await tx.gameResult.findMany({ where: eligible, orderBy: { gameDate: "asc" }, select: GRADED_GAME_SELECT });
    const existing = await tx.decayDeltaPrediction.findMany({
      where: { modelId: MODEL_ID, gameResultId: { not: null } },
      select: { gameResultId: true },
    });
    const persisted = new Set(existing.map((r) => r.gameResultId!));
    const oldPending = all.filter((r) => !persisted.has(r.id));

    // NEW path
    const scanned = await tx.gameResult.count({ where: eligible });
    const newPending = await tx.gameResult.findMany({
      where: { ...eligible, id: { notIn: [...persisted] } },
      orderBy: { gameDate: "asc" },
      select: GRADED_GAME_SELECT,
    });

    check("scanned (count) == all rated games", scanned === all.length, `count=${scanned} full-scan=${all.length}`);
    check(
      "notIn pending set == old in-memory pending set, same order, same columns",
      JSON.stringify(newPending) === JSON.stringify(oldPending),
      `new=${newPending.length} old=${oldPending.length}`
    );
    console.log(`info: persisted ids (all sports) = ${persisted.size}; rows the daily cron now reads = ${newPending.length} instead of ${all.length}`);
  }, { timeout: 60000, maxWait: 15000 }); // prod round-trips exceed the 5s default
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
  console.log("ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
