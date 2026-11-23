// Measures Parlay Generator variety on the fixture pools (variety-pools.ts) through the real session
// (generator-session.ts) and engine (generator.ts). Written against the API both before and after the
// variety change has - Generate's options and the request's `draw` are passed loosely - so the
// same code gives the before/after tables (scripts/variety-harness/measure.ts) and the acceptance test's
// numbers (generator-variety-acceptance-test.ts). Fixed seeds throughout - reproducible. Pure - no DB.
import * as gen from "@/lib/parlay/generator";
import { createGeneratorSession, type PoolInputs } from "@/lib/parlay/generator-session";
import type { GeneratedParlay, GeneratorSnapshot } from "@/lib/parlay/generator";
import { makePool, NOW, settingsFor, type PoolSpec } from "@/lib/parlay/__fixtures__/variety-pools";

export type Mode = "BEST" | "DIVERSIFIED" | "EXPLORE";
export const MODES: Mode[] = ["BEST", "DIVERSIFIED", "EXPLORE"];
export const REGENERATES = 10;
export const GENERATES = 10;
// Cards (sessions) each Regenerate figure is averaged over.
export const CARDS = 5;
const INPUTS: PoolInputs = { leagues: ["MLB"], slipPickIds: [], targets: [] };

// The server action's build, as the fake request handler: the request's Generate draw when it carries one
// (after), the rank order otherwise (before - the old request never carries one).
function fakeGenerate(snap: GeneratorSnapshot) {
  const variationOf = (gen as Record<string, unknown>).generateVariation as ((d: unknown) => gen.Variation | null) | undefined;
  return async (req: PoolInputs & { settings: gen.GeneratorSettings; draw?: unknown }) => ({
    snapshot: snap,
    parlay: gen.buildGeneratedParlay(snap, req.settings, variationOf && req.draw ? variationOf(req.draw) : null, NOW),
  });
}

export const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);
export const gamesOf = (p: GeneratedParlay) => p.legs.map((l) => l.gameId);
export const meanScore = (p: GeneratedParlay) => p.legs.reduce((s, l) => s + (l.score ?? 0), 0) / Math.max(1, p.legs.length);
// The share of the larger parlay's legs (or games) the two have in common.
export const share = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length / Math.max(1, Math.max(a.length, b.length));
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

const session = (snap: GeneratorSnapshot, seed: number) => createGeneratorSession({ generate: fakeGenerate(snap) as never, now: () => NOW, firstSeed: seed });

export type VarietyRow = {
  mode: Mode;
  // Regenerate (Generate + 10 Regenerates per card, CARDS cards): mean share of legs / games the same as the
  // parlay before it, the lowest such leg share seen, distinct games a card used, mean leg score, NO_ALTERNATIVEs.
  regenSame: number;
  regenMinSame: number;
  regenGamesSame: number;
  regenDistinctGames: number;
  regenScore: number;
  noAlt: number;
  // Generate (10 fresh sessions): mean share between pairs of first parlays, with the rank-order (top)
  // parlay, and their mean leg score.
  genPair: number;
  genTop: number;
  genScore: number;
};

export async function measure(spec: PoolSpec): Promise<{ spec: PoolSpec; topScore: number; topLegs: number; rows: VarietyRow[] }> {
  const snap = makePool(spec);
  const settings = settingsFor(spec);
  const top = gen.buildGeneratedParlay(snap, settings, null, NOW);
  const rows: VarietyRow[] = [];
  for (const mode of MODES) {
    const parlays: GeneratedParlay[] = [];
    const distinct: number[] = [];
    const same: number[] = [];
    const sameGames: number[] = [];
    let noAlt = 0;
    for (let c = 0; c < CARDS; c++) {
      const s = session(snap, 1000 + 31 * c + spec.seed);
      const g = await s.generate(INPUTS, settings, { mode, reseed: true } as never);
      if ("error" in g) throw new Error(g.error);
      let shown = g.parlay;
      const card = [shown];
      for (let i = 0; i < REGENERATES; i++) {
        const r = await s.regenerate(INPUTS, settings, mode);
        if ("error" in r) throw new Error(r.error);
        // A NO_ALTERNATIVE leaves the card as it was.
        const next = r.parlay.variety === "NO_ALTERNATIVE" ? shown : r.parlay;
        if (r.parlay.variety === "NO_ALTERNATIVE") noAlt++;
        same.push(share(ids(next), ids(shown)));
        sameGames.push(share(gamesOf(next), gamesOf(shown)));
        shown = next;
        card.push(shown);
      }
      parlays.push(...card);
      distinct.push(new Set(card.flatMap(gamesOf)).size);
    }
    const firsts: GeneratedParlay[] = [];
    for (let k = 0; k < GENERATES; k++) {
      const r = await session(snap, 7919 * (k + 1) + spec.seed).generate(INPUTS, settings, { mode, reseed: true } as never);
      if ("error" in r) throw new Error(r.error);
      firsts.push(r.parlay);
    }
    const pairs: number[] = [];
    for (let i = 0; i < firsts.length; i++) for (let j = i + 1; j < firsts.length; j++) pairs.push(share(ids(firsts[i]), ids(firsts[j])));
    rows.push({
      mode,
      regenSame: avg(same),
      regenMinSame: Math.min(...same),
      regenGamesSame: avg(sameGames),
      regenDistinctGames: avg(distinct),
      regenScore: avg(parlays.map(meanScore)),
      noAlt,
      genPair: avg(pairs),
      genTop: avg(firsts.map((p) => share(ids(p), ids(top)))),
      genScore: avg(firsts.map(meanScore)),
    });
  }
  return { spec, topScore: meanScore(top), topLegs: top.legs.length, rows };
}

const pct = (x: number) => (x * 100).toFixed(0) + "%";
export function varietyTable(m: Awaited<ReturnType<typeof measure>>): string {
  return [
    `## ${m.spec.name} - ${m.spec.picks} picks, top parlay ${m.topLegs} legs, mean score ${m.topScore.toFixed(2)}`,
    "| mode | regen % legs same as prev | min | regen % games same as prev | distinct games / card | regen mean score | NO_ALT | gen % shared (pairs) | gen % shared w/ top | gen mean score |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...m.rows.map(
      (r) =>
        `| ${r.mode} | ${pct(r.regenSame)} | ${pct(r.regenMinSame)} | ${pct(r.regenGamesSame)} | ${r.regenDistinctGames.toFixed(1)} | ${r.regenScore.toFixed(2)} | ${r.noAlt} | ${pct(r.genPair)} | ${pct(r.genTop)} | ${r.genScore.toFixed(2)} |`
    ),
  ].join("\n");
}
