// The Parlay slip's state model (slip-state.ts): reading every stored shape
// (the old one, v2, corrupt), round-tripping, targets vs games of picks, what
// the generator is told, the caps, Clear all picks, the named prune notice and
// reading another tab's change. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/slip-state-acceptance-test.ts
import {
  addRemoved,
  clearedSlip,
  EMPTY_SLIP_STATE,
  generatorTargets,
  isTargetedViaPicks,
  MAX_SLIP_TARGETS,
  migrateStoredSlip,
  removedHeading,
  removedPickText,
  serializeSlip,
  slipFromStorageEvent,
  targetedGames,
  togglePick,
  toggleTarget,
  type SlipPick,
  type SlipStateV2,
  type SlipTarget,
} from "@/lib/parlay/slip-state";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const pick = (id: string, gameId: string, leagueName = "NFL"): SlipPick =>
  ({ pickId: id, gameId, gameLabel: "Away @ Home " + gameId, gameTime: "2099-01-01T00:00:00.000Z", leagueName, capperId: "c-" + id, capperName: "C " + id, betDetail: "Home ML" }) as SlipPick;
const game = (gameId: string, leagueName = "NFL"): SlipTarget => ({ gameId, gameLabel: "Away @ Home " + gameId, gameTime: "2099-01-01T00:00:00.000Z", leagueName });

// ============================================================================
// Reading what's stored
// ============================================================================
{
  const v1 = {
    pool: [pick("a", "g1"), pick("b", "g2"), pick("a", "g1")],
    excludedLeagues: ["NHL"],
    legCount: 4,
    addMode: true,
    checkedPicks: [pick("c", "g3")],
    games: [game("g9"), game("g9"), { gameId: "broken" }],
    locked: ["a", 7],
    source: "SLIP_ONLY",
  };
  const s = migrateStoredSlip(v1);
  check("v1: pool -> picks (duplicates dropped)", s.picks.map((p) => p.pickId), ["a", "b"]);
  check("v1: game items -> targets (duplicates and malformed dropped)", s.targets.map((t) => t.gameId), ["g9"]);
  check("v1: league scope kept", s.excludedLeagues, ["NHL"]);
  check("v1: the leg count carried in legacy; add mode, ticks, locks and Source dropped", s.legacy, { legCount: 4 });
  check("v1 -> v2 -> read again: identical", migrateStoredSlip(JSON.parse(serializeSlip(s))), s);
  check("stored v2 says its version", JSON.parse(serializeSlip(s)).version, 2);

  check("v1 with only a pool (the oldest slips)", migrateStoredSlip({ pool: [pick("a", "g1")], leagueScope: { MLB: false }, legCount: 2 }), {
    ...EMPTY_SLIP_STATE,
    picks: [pick("a", "g1")],
  });
  for (const bad of [null, undefined, 3, "x", [], { pool: "nope" }, { version: 2, picks: [{}], targets: null }]) {
    check(`corrupt ${JSON.stringify(bad) ?? "undefined"}: the empty slip, no throw`, migrateStoredSlip(bad).picks.length + migrateStoredSlip(bad).targets.length, 0);
  }
  check("more than the target cap stored: held to the cap", migrateStoredSlip({ version: 2, targets: Array.from({ length: MAX_SLIP_TARGETS + 5 }, (_, i) => game("g" + i)) }).targets.length, MAX_SLIP_TARGETS);
}

// ============================================================================
// Targets and games of picks
// ============================================================================
{
  let s: SlipStateV2 = { ...EMPTY_SLIP_STATE, picks: [pick("a", "g1")], targets: [game("g2")], excludedLeagues: ["NBA"] };
  check("in play: the target, then the pick's game", targetedGames(s).map((g) => [g.gameId, g.explicit, g.viaPicks]), [
    ["g2", true, false],
    ["g1", false, true],
  ]);
  check("the generator is told the explicit targets only", generatorTargets(s), [{ gameId: "g2", leagueName: "NFL" }]);
  check("a pick alone is not a target (full slate stays possible)", generatorTargets({ targets: [] }), []);
  check("a pick's game is targeted via picks", [isTargetedViaPicks(s, "g1"), isTargetedViaPicks(s, "g2")], [true, false]);

  const viaPicks = toggleTarget(s, game("g1"));
  check("untargeting a pick's game is refused", [viaPicks.refused, viaPicks.state === s], ["VIA_PICKS", true]);
  s = toggleTarget(s, game("g3", "NBA")).state;
  check("targeting a game adds it and switches its league on", [s.targets.map((t) => t.gameId), s.excludedLeagues], [["g2", "g3"], []]);
  s = toggleTarget(s, game("g2")).state;
  check("toggling a target off removes it", s.targets.map((t) => t.gameId), ["g3"]);
  const full: SlipStateV2 = { ...EMPTY_SLIP_STATE, targets: Array.from({ length: MAX_SLIP_TARGETS }, (_, i) => game("t" + i)) };
  check("past the target cap: refused", toggleTarget(full, game("one-more")).refused, "TARGET_CAP");
}

// ============================================================================
// Picks: straight into the slip
// ============================================================================
{
  let s: SlipStateV2 = { ...EMPTY_SLIP_STATE, excludedLeagues: ["MLB"] };
  s = togglePick(s, pick("a", "g1", "MLB")).state;
  check("a pick goes straight in and switches its league on", [s.picks.map((p) => p.pickId), s.excludedLeagues], [["a"], []]);
  s = togglePick(s, pick("a", "g1", "MLB")).state;
  check("toggling it again removes it", s.picks.length, 0);
  const atCap: SlipStateV2 = { ...EMPTY_SLIP_STATE, picks: Array.from({ length: MAX_PARLAY_LEGS }, (_, i) => pick("p" + i, "g" + i)) };
  const over = togglePick(atCap, pick("extra", "gx"));
  check(`a ${MAX_PARLAY_LEGS + 1}th pick is refused, nothing added`, [over.refused, over.state.picks.length], ["PICK_CAP", MAX_PARLAY_LEGS]);
  check("removing one at the cap still works", togglePick(atCap, pick("p0", "g0")).state.picks.length, MAX_PARLAY_LEGS - 1);
}

// ============================================================================
// Clear all picks; the league scope stays
// ============================================================================
{
  const s: SlipStateV2 = {
    version: 2,
    picks: [pick("a", "g1")],
    targets: [game("g2")],
    excludedLeagues: ["NHL"],
    legacy: { legCount: 5 },
  };
  const c = clearedSlip(s);
  check("cleared: no picks, no targets", [c.picks, c.targets], [[], []]);
  check("cleared: league scope and leg count stay", [c.excludedLeagues, c.legacy.legCount], [["NHL"], 5]);
}

// ============================================================================
// The prune notice names every removed pick and why, and stays
// ============================================================================
{
  const a = { pickId: "a", label: "Cap A - Away @ Home - Home ML", result: "Over" as const };
  const b = { pickId: "b", label: "Cap B - X @ Y - Over 5", result: "Removed" as const };
  const c = { pickId: "c", label: "Cap C - P @ Q - Q ML", result: "Won" as const };
  let line = addRemoved(null, [a, b]);
  check("two picks removed: heading", line && removedHeading(line), "2 picks removed from your slip");
  check("each pick is named with its reason", line?.picks.map(removedPickText), ["Cap A - Away @ Home - Home ML — game over", "Cap B - X @ Y - Over 5 — no longer in your picks"]);
  line = addRemoved(line, [b, c]);
  check("another prune adds up; a pick already listed is not listed twice", line?.picks.map((p) => p.pickId), ["a", "b", "c"]);
  check("graded picks say so", removedPickText(c), "Cap C - P @ Q - Q ML — graded Won");
  check("one pick: singular heading", removedHeading({ picks: [a] }), "1 pick removed from your slip");
  check("nothing removed: no notice", addRemoved(null, []), null);
}

// ============================================================================
// Another tab's change (a storage event)
// ============================================================================
{
  const stored = { ...EMPTY_SLIP_STATE, picks: [{ ...pick("f", "gf"), status: "PENDING" as const }, { ...pick("graded", "gg"), status: "WIN" as const }, { ...pick("started", "gs"), status: "PENDING" as const, gameTime: "2000-01-01T00:00:00.000Z" }] };
  const got = slipFromStorageEvent(serializeSlip(stored), Date.parse("2020-01-01T00:00:00.000Z"));
  check("keeps pending picks whose game is not over only", got.picks.map((p) => p.pickId), ["f"]);
  check("a removed key is the empty slip", slipFromStorageEvent(null, 0), EMPTY_SLIP_STATE);
  check("corrupt storage is the empty slip", slipFromStorageEvent("{nope", 0), EMPTY_SLIP_STATE);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
