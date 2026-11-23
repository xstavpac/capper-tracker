// Prints the Parlay Generator variety tables for the fixture pools (lib/parlay/__fixtures__/variety-pools.ts,
// variety-measure.ts). Run on any commit that has those two files to get its numbers - the before/after
// of the variety change came from running it on origin/main (eb31d89) and on its branch:
//   npx tsx scripts/variety-harness/measure.ts
import { POOLS } from "@/lib/parlay/__fixtures__/variety-pools";
import { measure, varietyTable } from "@/lib/parlay/__fixtures__/variety-measure";

(async () => {
  for (const spec of POOLS) console.log("\n" + varietyTable(await measure(spec)));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
