// Capper-detail PR: page-level parity of getCapperDetailData (ONE statement + the existing JS over the
// narrow decided series) vs the frozen legacy derivation (computeCapperDetailLegacy) on a restored
// (anonymized) production snapshot. Read-only. Point DATABASE_URL at a disposable local DB holding the
// snapshot (README.md "Getting a real snapshot"), with categories stamped first:
//   DATABASE_URL=... npx tsx scripts/backfill-pick-category.ts --apply
// so this proves SQL == JS given identical stamps (G1's --verify is what proves the stamps).
//
// Design doc §8: at each pinned `now` (the latest gameTime, -1d, -7d, -30d, -60d) the FULL matrix
// window x categoryWindow x categorySport (unset, each sport the capper has, one it lacks) runs for the 10
// heaviest cappers plus a seeded stratified sample of 20 more; every other capper (including the ones with
// no picks) runs the diagonal (window == categoryWindow). Zero diffs required (=== with -0 == +0); exit 1
// otherwise. `--quick` keeps only the latest `now`.
//   node --import tsx scripts/t2-harness/capper-detail-parity.ts [--user-id=<cuid>] [--quick]
import { prisma } from "@/lib/prisma";
import { SCORECARD_WINDOWS } from "@/server/data/stats";
import { getCapperDetailData, type CapperDetailParams } from "@/server/data/capper-detail";
import { computeCapperDetailLegacy, firstDiff, loadLegacyCapperPicks } from "@/server/data/capper-detail-legacy";
import { assertNotProd } from "./lib/prod-guard.mjs";

assertNotProd(process.env.DATABASE_URL ?? "", "DATABASE_URL (capper-detail-parity.ts)");

const DAY = 86400000;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--user-id="))?.slice("--user-id=".length);
  const quick = process.argv.includes("--quick");
  const unstamped = await prisma.pick.count({ where: { categoryVersion: 0 } });
  console.log(`unstamped picks (categoryVersion 0): ${unstamped}${unstamped > 0 ? "  <-- stamp first (backfill-pick-category --apply); tiles will differ" : ""}`);

  const cappers = await prisma.$queryRaw<{ userId: string; capperId: string; picks: number; maxGame: Date | null }[]>`
    SELECT c."userId", c.id AS "capperId", count(p.id)::int AS picks, max(p."gameTime") AS "maxGame"
    FROM cappers c LEFT JOIN picks p ON p."capperId" = c.id AND p."userId" = c."userId"
    GROUP BY c."userId", c.id ORDER BY picks DESC, c.id`;
  const userMax = new Map<string, Date>();
  for (const c of cappers) if (c.maxGame && (!userMax.has(c.userId) || c.maxGame > userMax.get(c.userId)!)) userMax.set(c.userId, c.maxGame);

  const scoped = cappers.filter((c) => !only || c.userId === only);
  const heavy = new Set(scoped.slice(0, 10).map((c) => c.capperId));
  const r = rng(20260929);
  const sample = new Set(
    scoped
      .filter((c) => !heavy.has(c.capperId) && c.picks > 0)
      .map((c) => ({ id: c.capperId, k: r() }))
      .sort((a, b) => a.k - b.k)
      .slice(0, 20)
      .map((x) => x.id)
  );

  let cases = 0;
  let failed = 0;
  let cappersRun = 0;
  const t0 = Date.now();
  for (const [i, c] of scoped.entries()) {
    const full = heavy.has(c.capperId) || sample.has(c.capperId);
    const rows = await loadLegacyCapperPicks(c.userId, c.capperId);
    const sports = Array.from(new Set(rows.map((p) => p.sport.name)));
    const sportChoices = [undefined, ...sports, "Curling"];
    const base = userMax.get(c.userId) ?? new Date();
    const nows = (quick ? [0] : [0, 1, 7, 30, 60]).map((off) => new Date(base.getTime() - off * DAY));
    let bad = 0;
    let firstBad = "";
    let n = 0;
    for (const now of nows)
      for (const w of SCORECARD_WINDOWS)
        for (const cw of SCORECARD_WINDOWS) {
          if (!full && w !== cw) continue;
          for (const cs of sportChoices) {
            const p: CapperDetailParams = { window: w, categoryWindow: cw, categorySport: cs };
            const legacy = computeCapperDetailLegacy(rows, p, now);
            const next = await getCapperDetailData(c.userId, c.capperId, p, now);
            const d = firstDiff(next, legacy);
            n++;
            if (d) {
              bad++;
              if (!firstBad) firstBad = `${JSON.stringify(p)} now=${now.toISOString()}  ${d}`;
            }
          }
        }
    cases += n;
    failed += bad;
    cappersRun++;
    if (bad || (full && heavy.has(c.capperId))) console.log(`${bad ? "FAIL" : "PASS"}  capper #${i + 1} picks=${c.picks} sports=${sports.length} ${full ? "full-matrix" : "diagonal"} cases=${n}${bad ? `  ${bad} differ; first: ${firstBad}` : ""}`);
  }
  console.log(`\n${cappersRun} capper(s) (${heavy.size} heaviest + ${sample.size} sampled on the full matrix, the rest diagonal), ${cases} case(s), ${failed} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
main();
