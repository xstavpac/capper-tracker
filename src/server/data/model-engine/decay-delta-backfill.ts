// Build Step 7 backfill - run ONCE to populate DecayDeltaPrediction's
// initial history from the currently-already-graded games (the same
// ~832-row baseball_mlb set Build Step 5 already proved correct), so the
// table doesn't start empty and the cron only ever has to keep it current
// from here on. Calls persistGradedDecayDeltaGames directly - the exact
// same function the cron itself calls every day, not a separate
// implementation of "compute and persist a graded row."
// Run with: npx tsx src/server/data/model-engine/decay-delta-backfill.ts
import { prisma } from "@/lib/prisma";
import { persistGradedDecayDeltaGames } from "./decay-delta-predictions";

async function main() {
  const sportKey = "baseball_mlb";
  const start = Date.now();
  const result = await persistGradedDecayDeltaGames(sportKey);
  const elapsedMs = Date.now() - start;

  console.log(`Backfill (${sportKey}) result:`, result);
  console.log(`Elapsed: ${elapsedMs}ms.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
