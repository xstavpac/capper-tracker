// Proof that conflicting picks compete (selectConflictFreeLegs, through the
// slip build that uses it - lib/parlay/slip-build.ts): of two picks the
// classifier says can't both win (R2/R3) or that are the same bet, the
// higher-ranked one is kept unless the other is locked; the loser gets a
// reason naming the winner; and no parlay ever holds a conflicting pair.
// Pure - no DB. Run with:
//   npx tsx src/lib/parlay/conflict-competition-acceptance-test.ts
import { buildFromSlip, type SlipBuild, type SlipBuildInput } from "@/lib/parlay/slip-build";
import { blocks } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { slateGame, slatePick, slateRecords, type Bet, type GameKey } from "@/lib/parlay/__fixtures__/slip-slate";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function built(r: SlipBuild | ParlayRejection): SlipBuild {
  if ("error" in r) throw new Error("expected a build, got error: " + r.error);
  return r;
}
const ids = (r: SlipBuild) => r.legs.map((l) => l.pickId);

const chiefs = slatePick("chiefsMl", "G1", "HOME"); // Yankees ML stands in for "Chiefs ML"
const opp = slatePick("oppMl", "G1", "AWAY");
const over = slatePick("over", "G1", "OVER");
const under = slatePick("under", "G1", "UNDER");
const records = slateRecords({ chiefsMl: 70, oppMl: 60, over: 55, under: 65 });

function run(over_: Partial<SlipBuildInput>) {
  return buildFromSlip({ picks: [], games: [], pool: [], records, legCount: 4, source: "SLIP_ONLY", ...over_ });
}
const unlocked = (...picks: GeneratorPick[]) => picks.map((pick) => ({ pick, locked: false }));

// ============================================================================
// Opposed picks: the higher-ranked one is kept, whatever order the slip holds them.
// ============================================================================
for (const order of [
  [opp, chiefs],
  [chiefs, opp],
]) {
  const r = built(run({ picks: unlocked(...order) }));
  check(`opposed MLs (slip order ${order.map((p) => p.pickId).join(",")}): higher-ranked kept`, ids(r), ["chiefsMl"]);
  check("...loser skipped as a conflict, won by the higher-ranked pick", r.skipped.map((s) => [s.pickId, s.reason, s.won]), [["oppMl", "conflict", "HIGHER_RANKED"]]);
  check("...reason names the winner", r.skipped[0]?.note, "Skipped Capper oppMl — Red Sox ML — conflicts with Capper chiefsMl — Yankees ML (higher-ranked)");
}
{
  // Over 55% vs Under 65% on the same total: Under ranks higher, Under is kept.
  const r = built(run({ picks: unlocked(over, under) }));
  check("opposite totals (R3): higher-ranked Under kept", ids(r), ["under"]);
  check("...Over skipped with a reason", r.skipped[0]?.note, "Skipped Capper over — Over 8.5 — conflicts with Capper under — Under 8.5 (higher-ranked)");
}

// ============================================================================
// A locked lower-ranked pick beats a higher-ranked one.
// ============================================================================
{
  const r = built(run({ picks: [{ pick: chiefs, locked: false }, { pick: opp, locked: true }] }));
  check("locked lower-ranked ML beats the higher-ranked one", ids(r), ["oppMl"]);
  check("...loser's reason says the winner is locked", r.skipped.map((s) => [s.pickId, s.won, s.note]), [
    ["chiefsMl", "LOCKED", "Skipped Capper chiefsMl — Yankees ML — conflicts with Capper oppMl — Red Sox ML (locked)"],
  ]);
}

// ============================================================================
// The loser is only out of THAT parlay - it is still a candidate elsewhere.
// ============================================================================
{
  const first = built(run({ picks: unlocked(chiefs, opp, over) }));
  check("loser skipped in the parlay its winner is in", first.skipped.map((s) => s.pickId), ["oppMl"]);
  const without = built(run({ picks: unlocked(opp, over) }));
  check("...and taken in a parlay its winner isn't in", ids(without).includes("oppMl"), true);
}

// ============================================================================
// No conflicting pair ever lands in one parlay - every slip, lock set, Source
// and leg count over a dense slate (seeded, so the run is repeatable).
// ============================================================================
{
  const BETS: Bet[] = ["HOME", "AWAY", "OVER", "UNDER"];
  const KEYS: GameKey[] = ["G1", "G2", "G3"];
  const all: GeneratorPick[] = [];
  const pct: Record<string, number> = {};
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const g of KEYS) {
    for (const bet of BETS) {
      for (const n of [1, 2]) {
        const id = `${g}${bet}${n}`;
        all.push(slatePick(id, g, bet));
        pct[id] = 30 + Math.floor(rand() * 14) * 5;
      }
    }
  }
  const recs = slateRecords(pct);
  const pool = KEYS.map((g) => slateGame(g, all.filter((p) => p.gameId === g)));
  let builds = 0;
  let bad = 0;
  let lockWins = 0;
  for (let trial = 0; trial < 300; trial++) {
    const slip = all.filter(() => rand() < 0.35);
    // Lock a couple of picks that don't conflict with each other.
    const locked: GeneratorPick[] = [];
    for (const p of slip) {
      if (locked.length < 2 && rand() < 0.3 && !locked.some((l) => blocks(toBuildCandidate(l), toBuildCandidate(p)).blocked)) locked.push(p);
    }
    const r = buildFromSlip({
      picks: slip.map((pick) => ({ pick, locked: locked.includes(pick) })),
      games: [],
      pool,
      records: recs,
      legCount: 1 + Math.floor(rand() * 6),
      source: rand() < 0.5 ? "SLIP_ONLY" : "SLIP_PLUS_POOL",
    });
    if ("error" in r) continue;
    builds++;
    if (locked.some((l) => !r.legs.includes(l))) bad++;
    lockWins += r.skipped.filter((s) => s.won === "LOCKED").length;
    for (let i = 0; i < r.legs.length; i++) {
      for (let j = i + 1; j < r.legs.length; j++) {
        if (blocks(toBuildCandidate(r.legs[i]), toBuildCandidate(r.legs[j])).blocked) bad++;
      }
    }
    // Every skip's winner is in the parlay.
    for (const s of r.skipped) if (!r.legs.some((l) => l.pickId === s.conflictsWith.pickId)) bad++;
  }
  check("randomized: builds ran", builds > 200, true);
  check("randomized: some conflicts were won by a lock (the case is exercised)", lockWins > 0, true);
  check("randomized: no conflicting or duplicate pair in any parlay, every lock present, every skip's winner present", bad, 0);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
