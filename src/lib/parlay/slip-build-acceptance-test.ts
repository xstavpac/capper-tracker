// Proof for buildFromSlip (lib/parlay/slip-build.ts): the slip's picks and
// games, locks, and the Source. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/slip-build-acceptance-test.ts
import { buildFromSlip, slipShortfallText, type SlipBuild, type SlipBuildInput } from "@/lib/parlay/slip-build";
import { selectConflictFreeLegs } from "@/lib/parlay/build-my-picks";
import { rankPoolPicks } from "@/lib/parlay/pick-record";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { slateGame, slatePick, slateRecords } from "@/lib/parlay/__fixtures__/slip-slate";
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

// The slate. Records (win %) set the ranking: higher first.
const P = {
  g1Home: slatePick("g1Home", "G1", "HOME"), // 80
  g1Away: slatePick("g1Away", "G1", "AWAY"), // 75 - opposes g1Home (R2)
  g1Over: slatePick("g1Over", "G1", "OVER"), // 50
  g2Home: slatePick("g2Home", "G2", "HOME"), // 70
  g2Over: slatePick("g2Over", "G2", "OVER"), // 45
  g3Away: slatePick("g3Away", "G3", "AWAY"), // 65
  g3Home: slatePick("g3Home", "G3", "HOME"), // 40
  g4Home: slatePick("g4Home", "G4", "HOME"), // 60
  g5Under: slatePick("g5Under", "G5", "UNDER"), // 35
};
const records = slateRecords({ g1Home: 80, g1Away: 75, g1Over: 50, g2Home: 70, g2Over: 45, g3Away: 65, g3Home: 40, g4Home: 60, g5Under: 35 });
const POOL = [
  slateGame("G1", [P.g1Home, P.g1Away, P.g1Over]),
  slateGame("G2", [P.g2Home, P.g2Over]),
  slateGame("G3", [P.g3Away, P.g3Home]),
  slateGame("G4", [P.g4Home]),
  slateGame("G5", [P.g5Under]),
];
const game = (key: string) => POOL.find((g) => g.gameId === key)!;

function run(over: Partial<SlipBuildInput>): SlipBuild | ParlayRejection {
  return buildFromSlip({ picks: [], games: [], pool: POOL, records, legCount: 3, source: "SLIP_ONLY", ...over });
}

// ============================================================================
// Slip only, unlocked picks only: exactly today's My Picks build.
// ============================================================================
{
  const slip = [P.g5Under, P.g1Away, P.g2Over, P.g1Home];
  for (const n of [1, 2, 3, 4]) {
    const r = built(run({ picks: slip.map((pick) => ({ pick, locked: false })), legCount: n }));
    const today = selectConflictFreeLegs(rankPoolPicks(slip, records).map((p) => toBuildCandidate(p, records)), n);
    check(`slip only, ${n} legs: same legs as today's My Picks`, ids(r), today.legs.map((l) => l.pickId));
    check(`slip only, ${n} legs: same skip notes as today's My Picks`, r.skipped, today.skipped);
  }
}

// ============================================================================
// Slip only can't fill the leg count -> shortfall, said so, never filled from outside.
// ============================================================================
{
  const r = built(run({ picks: [P.g4Home, P.g5Under].map((pick) => ({ pick, locked: false })), legCount: 4 }));
  check("slip only short: only the slip's 2 picks", ids(r), ["g4Home", "g5Under"]);
  check("slip only short: shortfall is 2", r.shortfall, 2);
  check(
    "slip only short: the message says so and points at the other Source",
    slipShortfallText(r),
    'Slip only never adds picks from outside your slip. Switch Source to "Slip + qualified picks" to fill the rest from your cappers\' other picks.'
  );
}

// ============================================================================
// Slip + qualified picks fills the remainder from the pool, one leg per game.
// ============================================================================
{
  const r = built(run({ picks: [P.g5Under].map((pick) => ({ pick, locked: false })), legCount: 4, source: "SLIP_PLUS_POOL" }));
  check("hybrid: fills 4 legs", r.legs.length, 4);
  check("hybrid: no shortfall", r.shortfall, 0);
  // Best first: g1Home 80, g2Home 70, g3Away 65 from the pool; the slip's
  // g5Under (35) is outranked by g4Home (60) - unlocked slip picks compete.
  check("hybrid: unlocked slip pick competes with the pool on the same ranking", ids(r), ["g1Home", "g2Home", "g3Away", "g4Home"]);
  check("hybrid: one leg per pool game", new Set(r.legs.map((l) => l.gameId)).size, r.legs.length);
  check("hybrid: nothing is tagged from the slip that isn't", r.slipPickIds, []);
}
{
  const r = built(run({ picks: [P.g5Under].map((pick) => ({ pick, locked: false })), legCount: 5, source: "SLIP_PLUS_POOL" }));
  check("hybrid, 5 legs: the slip pick makes it once the pool's better games are used", ids(r), ["g1Home", "g2Home", "g3Away", "g4Home", "g5Under"]);
  check("hybrid, 5 legs: the slip pick is marked as the slip's", r.slipPickIds, ["g5Under"]);
}
{
  // The slip's own game is the slip's: the pool doesn't add a second leg on G1.
  const r = built(run({ picks: [P.g1Over].map((pick) => ({ pick, locked: false })), legCount: 5, source: "SLIP_PLUS_POOL" }));
  check("hybrid: a game the slip has a pick on gets no pool leg", r.legs.filter((l) => l.gameId === "G1").map((l) => l.pickId), ["g1Over"]);
}

// ============================================================================
// Locked pick: always in the parlay, even when everything outranks it.
// ============================================================================
{
  const r = built(run({ picks: [{ pick: P.g5Under, locked: true }], legCount: 2, source: "SLIP_PLUS_POOL" }));
  check("locked pick: present though it ranks last", ids(r).includes("g5Under"), true);
  check("locked pick: placed first", ids(r)[0], "g5Under");
  check("locked pick: the rest is the pool's best", ids(r), ["g5Under", "g1Home"]);
  check("locked pick: reported as locked", r.lockedPickIds, ["g5Under"]);
}
{
  // Locked lower-ranked pick vs an unlocked opposing pick: the lock wins.
  const r = built(run({ picks: [{ pick: P.g1Away, locked: true }, { pick: P.g1Home, locked: false }], legCount: 2 }));
  check("locked pick beats a higher-ranked unlocked pick it conflicts with", ids(r), ["g1Away"]);
  check("...and the loser gets a conflict note", r.skipped.map((s) => s.pickId + ":" + s.reason), ["g1Home:conflict"]);
}

// ============================================================================
// Locked game: yields a leg from that game - the generator's choice.
// ============================================================================
{
  const r = built(run({ games: [{ game: game("G3"), locked: true }], picks: [{ pick: P.g1Home, locked: false }], legCount: 1 }));
  check("locked game: its leg is in even at 1 leg, over a better slip pick", ids(r), ["g3Away"]);
  check("locked game: the leg is from that game", r.legs[0].gameId, "G3");
  check("locked game: its leg is reported as locked and from the slip", [r.lockedPickIds, r.slipPickIds], [["g3Away"], ["g3Away"]]);
}
{
  // The game's best pick conflicts with a locked pick: the next one that fits is taken.
  const r = built(run({ games: [{ game: game("G1"), locked: true }], picks: [{ pick: P.g1Away, locked: true }], legCount: 2 }));
  check("locked game already covered by a locked pick on it: no second leg forced", ids(r), ["g1Away"]);
}
{
  const r = built(run({ games: [{ game: game("G1"), locked: true }], picks: [{ pick: P.g2Home, locked: true }], legCount: 2 }));
  check("locked game: takes the game's best pick", ids(r), ["g2Home", "g1Home"]);
}
{
  // Unlocked game item: one leg at most, its best pick at that pick's rank.
  const r = built(run({ games: [{ game: game("G1"), locked: false }], picks: [{ pick: P.g4Home, locked: false }], legCount: 3 }));
  check("unlocked game: gives at most one leg (its best), slip only can't fill 3", [ids(r), r.shortfall], [["g1Home", "g4Home"], 1]);
}

// ============================================================================
// Locks that can't be honoured -> an error that names them. Never a silent drop.
// ============================================================================
{
  const r = run({ picks: [{ pick: P.g1Home, locked: true }, { pick: P.g1Away, locked: true }], legCount: 3 });
  check(
    "conflicting locks: error naming both",
    "error" in r ? r.error : null,
    "Locked picks Capper g1Home — Yankees ML and Capper g1Away — Red Sox ML conflict - unlock one."
  );
}
{
  const r = run({ picks: [{ pick: P.g1Home, locked: true }, { pick: P.g2Home, locked: true }], games: [{ game: game("G3"), locked: true }], legCount: 2 });
  check("more locks than legs: error", "error" in r ? r.error : null, "3 slip items are locked, but the parlay is only 2 legs - unlock some or add legs.");
}
{
  const r = run({ games: [{ game: slateGame("G4", []), locked: true }], legCount: 2 });
  check("locked game with no picks: error naming it", "error" in r ? r.error : null, "Locked game Detroit Tigers @ Cleveland Guardians has no pending picks from your cappers.");
}
{
  // G1's only pick opposes the locked g1Home - but that lock is on G1 itself,
  // so the game lock is already met by it, not an error.
  const onlyAway = slateGame("G1", [P.g1Away]);
  const r = built(run({ games: [{ game: onlyAway, locked: true }], picks: [{ pick: P.g1Home, locked: true }], legCount: 2 }));
  check("locked game met by a locked pick on it: its conflicting pick isn't forced in", ids(r), ["g1Home"]);
}
{
  const r = built(run({ games: [{ game: game("G4"), locked: true }], picks: [{ pick: P.g2Over, locked: true }], legCount: 2 }));
  check("locked pick + locked game on different games: both in", ids(r), ["g2Over", "g4Home"]);
}

// ============================================================================
// No gate on slip picks: a slip pick with a sub-55% record is still built from.
// ============================================================================
{
  const r = built(run({ picks: [{ pick: P.g3Home, locked: false }, { pick: P.g5Under, locked: false }], legCount: 2 }));
  check("slip picks below 55% are not excluded (no gate - ranking only)", ids(r), ["g3Home", "g5Under"]);
}

// ============================================================================
// Order the slip holds its items in never changes the result.
// ============================================================================
{
  const a = built(run({ picks: [P.g1Home, P.g2Home, P.g4Home].map((pick) => ({ pick, locked: false })), legCount: 4, source: "SLIP_PLUS_POOL" }));
  const b = built(run({ picks: [P.g4Home, P.g1Home, P.g2Home].map((pick) => ({ pick, locked: false })), legCount: 4, source: "SLIP_PLUS_POOL" }));
  check("slip order doesn't matter", ids(a), ids(b));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
