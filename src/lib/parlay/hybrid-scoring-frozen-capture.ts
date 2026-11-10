// What the Hybrid scoring frozen diff compares, per case and gate: the positions (in rank order, with
// their supporters, opposers, anchor and score), the box-eligible games, the games priced, the
// optimizer's result and "Why only N games?". The flow is runHybridGenerate's from step 2 (no
// ladder backfill: every case's ladders are present). Uses only what existed before PR 8, so the
// before JSON is written by this same file on the base commit:
//   npx tsx src/lib/parlay/hybrid-scoring-frozen-capture.ts <out.json> "<label>"
import { writeFileSync } from "node:fs";
import { buildConsensusPositions } from "@/lib/parlay/consensus";
import { boxEligibleGames, optimizeHybridReport, type Hybrid } from "@/lib/parlay/hybrid";
import { explainSkips } from "@/lib/parlay/hybrid-diagnostics";
import { caseLadders, caseSnapshot, FROZEN_CASES, FROZEN_GATES, SLATE_NOW, type FrozenCase } from "@/lib/parlay/hybrid-scoring-frozen-cases";
import { chooseCandidateEvents } from "@/server/data/hybrid-generate";

export type CapturedCase = {
  positions: unknown[];
  boxes: string[];
  priced: string[];
  result: unknown;
  skipped: [string, string, string][];
};
export type Capture = { capturedFrom: string; cases: Record<string, CapturedCase> };

export const captureKey = (c: FrozenCase, gate: number) => `${c.name} @ ${gate}%`;

function digest(h: Hybrid | null) {
  if (!h) return null;
  return {
    s: h.structure,
    legs: h.legs.map((l) => [l.positionKey, l.marketKey, l.point, l.price, l.opposite]),
    price: Math.round(h.combinedAmerican * 100) / 100,
    inT: h.inTarget,
    score: h.consensusScore,
  };
}

export function captureCase(c: FrozenCase, gate: number): CapturedCase {
  const snap = caseSnapshot(c);
  const ranked = buildConsensusPositions(snap as never, { now: SLATE_NOW, minWinPct: gate } as never);
  const candidateEvents = chooseCandidateEvents(ranked, c.maxLegs, c.boxLegs);
  const priced = new Set(candidateEvents);
  const positions = ranked.filter((p) => priced.has(p.eventId));
  const { result, report } = optimizeHybridReport({ positions, ladders: caseLadders(c), swings: {}, settings: { maxLegs: c.maxLegs, boxLegs: c.boxLegs } });
  const d = explainSkips({
    games: snap.games,
    pickCounts: Object.fromEntries(snap.games.map((g) => [g.gameId, g.picks.length])),
    snapshotSkipped: [],
    records: snap as never,
    minWinPct: gate,
    filtered: false,
    positions: ranked,
    candidateEvents,
    notes: [],
    report,
    result,
  } as never);
  return JSON.parse(
    JSON.stringify({
      positions: ranked.map((p) => [
        p.key,
        p.anchorLine,
        p.anchorIsMoneyline,
        p.supporters.map((s) => [s.capperId, s.record.source, s.record.wins, s.record.losses, s.postedMarket, s.endorsedLine, s.score]),
        p.opposers.map((s) => s.capperId),
        p.score,
      ]),
      boxes: boxEligibleGames(ranked).map((b) => b.eventId),
      priced: candidateEvents,
      result: { p: digest(result.primary), alts: result.alternates.map(digest), note: result.note, d: result.delivery },
      skipped: d.skipped.map((r) => [r.eventId, r.reason, r.text]),
    })
  );
}

export function capture(capturedFrom: string): Capture {
  const cases: Record<string, CapturedCase> = {};
  for (const c of FROZEN_CASES) for (const gate of FROZEN_GATES) cases[captureKey(c, gate)] = captureCase(c, gate);
  return { capturedFrom, cases };
}

if (/hybrid-scoring-frozen-capture\.ts$/.test(process.argv[1] ?? "")) {
  const [out, label] = process.argv.slice(2);
  writeFileSync(out, JSON.stringify(capture(label)) + "\n");
  console.log("wrote " + out);
}
