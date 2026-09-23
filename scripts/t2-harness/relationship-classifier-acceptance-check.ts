// Acceptance check for the production Relationship Classifier
// (src/lib/parlay/relationship-classifier.ts) against the investigation
// harness's own classifier (parlay-relationship-classifier.mjs), over the
// exact same set of same-game pick pairs from the Sept 15 snapshot.
//
// This does NOT re-run the parlay-level coverage simulation (qualification,
// point-in-time win rates, ranking, conflict validation are all out of scope
// for the classifier PR) - it only checks that describePick/classifyPair
// agree with the harness's describePick/classifyGeneral on every same-game
// pair of real picks in the snapshot, after normalizing the two systems'
// different outcome vocabularies onto one shape (see normalizeHarness below).
//
// Usage (DATABASE_URL must already point at the disposable run DB):
//   node --import tsx scripts/t2-harness/relationship-classifier-acceptance-check.ts
//
// Prints a human-readable report, then ONE JSON object as the last line of
// stdout (same convention as parlay-coverage-investigation.ts).
import { prisma } from "@/lib/prisma";
import { describePick as harnessDescribePick, classifyGeneral } from "./parlay-relationship-classifier.mjs";
import { classifyPair, type ParlayCandidate, type PairOutcome } from "@/lib/parlay/relationship-classifier";

type DbPick = Awaited<ReturnType<typeof prisma.pick.findMany>>[number] & { sport: { name: string } };

function gameKey(p: DbPick): string {
  return `${p.homeTeam}|||${p.awayTeam}|||${p.gameTime.getTime()}`;
}

// A normalized outcome shape both systems' results collapse onto, so the
// comparison is behavioral (does the same pair end up treated the same way)
// rather than vocabulary-sensitive (INACTIVE vs UNDERIVABLE, EXACT_DUPLICATE
// nested under UNCLASSIFIED vs its own top-level outcome - both are new
// vocabulary this PR introduces, per the task's own instruction to follow it
// where the white paper is silent on implementation terms).
type Normalized = { outcome: string; rule?: string };

function normalizeHarness(result: { bucket: string; rule: string | null; reason?: string }, aBetType: string, bBetType: string): Normalized {
  if (result.bucket === "UNDERIVABLE") {
    return aBetType === "PLAYER_PROP" || bBetType === "PLAYER_PROP" ? { outcome: "INACTIVE" } : { outcome: "UNDERIVABLE" };
  }
  if (result.bucket === "UNCLASSIFIED") {
    return result.reason === "exact duplicate" ? { outcome: "EXACT_DUPLICATE" } : { outcome: "UNCLASSIFIED" };
  }
  // NEITHER / CONTRARIAN / AUTO_HEDGE - a rule always fired.
  return { outcome: "RULE", rule: result.rule ?? undefined };
}

function normalizeProduction(result: PairOutcome): Normalized {
  if (result.outcome === "RULE") return { outcome: "RULE", rule: result.rule };
  return { outcome: result.outcome };
}

type Disagreement = {
  game: string;
  pickA: { id: string; betType: string; period: string; betDetail: string | null; line: number | null };
  pickB: { id: string; betType: string; period: string; betDetail: string | null; line: number | null };
  harness: Normalized;
  production: Normalized;
};

async function main() {
  const allPicks = (await prisma.pick.findMany({ include: { sport: { select: { name: true } } } })) as DbPick[];

  const byGame = new Map<string, DbPick[]>();
  for (const p of allPicks) {
    const k = gameKey(p);
    (byGame.get(k) ?? byGame.set(k, []).get(k)!).push(p);
  }

  let totalPairs = 0;
  let agreement = 0;
  const expected: Disagreement[] = [];
  const unexpected: Disagreement[] = [];

  for (const [game, picks] of byGame) {
    if (picks.length < 2) continue;
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const a = picks[i];
        const b = picks[j];
        totalPairs++;

        const harnessResult = classifyGeneral(
          harnessDescribePick(a, a.sport.name),
          harnessDescribePick(b, b.sport.name),
          { sameGameRowActive: true } // production's R4 has no toggle - always on
        );
        const hNorm = normalizeHarness(harnessResult, a.betType, b.betType);

        const candA: ParlayCandidate = {
          pick: { betType: a.betType, period: a.period, betDetail: a.betDetail, line: a.line },
          game: { homeTeam: a.homeTeam, awayTeam: a.awayTeam, gameTime: a.gameTime, sportName: a.sport.name },
        };
        const candB: ParlayCandidate = {
          pick: { betType: b.betType, period: b.period, betDetail: b.betDetail, line: b.line },
          game: { homeTeam: b.homeTeam, awayTeam: b.awayTeam, gameTime: b.gameTime, sportName: b.sport.name },
        };
        const prodResult = classifyPair(candA, candB);
        const pNorm = normalizeProduction(prodResult);

        if (JSON.stringify(hNorm) === JSON.stringify(pNorm)) {
          agreement++;
          continue;
        }

        const disagreement: Disagreement = {
          game,
          pickA: { id: a.id, betType: a.betType, period: a.period, betDetail: a.betDetail, line: a.line },
          pickB: { id: b.id, betType: b.betType, period: b.period, betDetail: b.betDetail, line: b.line },
          harness: hNorm,
          production: pNorm,
        };

        // Expected: alternate total lines moving from UNCLASSIFIED (old
        // six-row table's blind spot) to R1 (Section 4's broadened rule).
        // Verified structurally, not just by outcome shape: same betType,
        // same period, same direction (over/under text), different line.
        const sameBetType = a.betType === b.betType;
        const sameDirection = (a.betDetail ?? "").toLowerCase().includes("over") === (b.betDetail ?? "").toLowerCase().includes("over");
        const isAlternateTotalLine =
          hNorm.outcome === "UNCLASSIFIED" &&
          pNorm.outcome === "RULE" &&
          pNorm.rule === "R1" &&
          sameBetType &&
          (a.betType === "TOTAL" || a.betType === "TEAM_TOTAL") &&
          a.period === b.period &&
          sameDirection &&
          a.line !== b.line;

        if (isAlternateTotalLine) expected.push(disagreement);
        else unexpected.push(disagreement);
      }
    }
  }

  const report = {
    totalPairs,
    agreement,
    agreementPct: totalPairs > 0 ? (agreement / totalPairs) * 100 : null,
    expectedCount: expected.length,
    unexpectedCount: unexpected.length,
    expectedSample: expected.slice(0, 10),
    unexpected,
  };

  console.log("\n=== Relationship Classifier Acceptance Check ===");
  console.log(`Total same-game pairs checked: ${totalPairs}`);
  console.log(`Agreement: ${agreement} (${report.agreementPct?.toFixed(2)}%)`);
  console.log(`Expected differences (alternate total lines, UNCLASSIFIED -> R1): ${expected.length}`);
  console.log(`Unexpected differences: ${unexpected.length}`);
  if (unexpected.length > 0) {
    console.log("\n--- UNEXPECTED DISAGREEMENTS (first 20) ---");
    for (const d of unexpected.slice(0, 20)) {
      console.log(JSON.stringify(d));
    }
  }

  console.log(JSON.stringify(report));
  await prisma.$disconnect();
  if (unexpected.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
