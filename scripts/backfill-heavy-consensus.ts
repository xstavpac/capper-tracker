// One-off backfill of heavy_consensus_markets from ALL history (the nightly
// pass in refresh-scores only recomputes the last few Eastern dates). Run it
// once, by hand, after the 20261027120000_add_heavy_consensus_markets migration
// is live:
//
//   npx tsx --env-file=<file with DATABASE_URL> scripts/backfill-heavy-consensus.ts            (dry run: reads only)
//   npx tsx --env-file=<file with DATABASE_URL> scripts/backfill-heavy-consensus.ts --apply    (writes)
//
// Prints the DATABASE_URL host (password masked) first so the target is obvious.
// The dry run reads the same picks and prints the markets and, per user, the rate the
// badge would show; --apply then upserts every qualifying market and deletes, by
// id, stored rows that no longer qualify. Safe to re-run. The rate's cache
// (24 h TTL) is not revalidated from here - there is no Next context - so a
// fresh number shows after the next refresh-scores run or the TTL.
import { loadHeavyConsensusInstances, recomputeHeavyConsensusMarkets } from "@/server/data/heavy-consensus";
import { HEAVY_CONSENSUS_MIN_CAPPERS, viewerHeavyConsensusRate } from "@/lib/heavy-consensus";
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "") || "(DATABASE_URL unset)";
  console.log("Database: " + dbHost);
  console.log(APPLY ? "Mode: APPLY (writes heavy_consensus_markets)\n" : "Mode: dry run (reads only; pass --apply to write)\n");

  const now = new Date();
  if (!APPLY) {
    const { picksRead, instances } = await loadHeavyConsensusInstances(now, null);
    console.log(`Picks read: ${picksRead}`);
    console.log(`Per-viewer markets that would be stored (>= stored floor): ${instances.length}`);
    // The badge rate is each viewer's own (never pooled across users): one line per viewer with a settled market.
    const viewers = Array.from(new Set(instances.map((i) => i.userId))).sort();
    let shown = 0;
    for (const viewerId of viewers) {
      const rate = viewerHeavyConsensusRate(instances, viewerId, HEAVY_CONSENSUS_MIN_CAPPERS);
      if (rate.hitRatePct === null) continue;
      shown++;
      console.log(`  viewer ${viewerId.slice(0, 8)}: ${rate.hitRatePct}% based on ${rate.games} games (>= ${HEAVY_CONSENSUS_MIN_CAPPERS} cappers)`);
    }
    console.log(`Viewers with a badge rate: ${shown} of ${viewers.length}`);
    return;
  }
  const result = await recomputeHeavyConsensusMarkets(now, null);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
