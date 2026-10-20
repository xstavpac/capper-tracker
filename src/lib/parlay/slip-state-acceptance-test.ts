// The Parlay slip's state model (slip-state.ts): reading every stored shape
// (the old one, v2, corrupt), round-tripping, targets vs games of picks, what
// the generator is told, the caps, Send to FanDuel's clear, and the quiet
// "games started" line. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/slip-state-acceptance-test.ts
import {
  addRemoved,
  clearedSlip,
  EMPTY_SLIP_STATE,
  generatorTargets,
  isTargetedViaPicks,
  MAX_SLIP_TARGETS,
  migrateStoredSlip,
  REMOVED_LINE_MS,
  removedLineText,
  serializeSlip,
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
  check("v1: add mode, ticks and leg count carried in legacy; locks and Source dropped", s.legacy, { addMode: true, legCount: 4, checkedPicks: [pick("c", "g3")] });
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
// Send to FanDuel clears the slip; the league scope stays
// ============================================================================
{
  const s: SlipStateV2 = {
    version: 2,
    picks: [pick("a", "g1")],
    targets: [game("g2")],
    excludedLeagues: ["NHL"],
    legacy: { addMode: true, legCount: 5, checkedPicks: [pick("b", "g3")] },
  };
  const c = clearedSlip(s);
  check("cleared: no picks, no targets, nothing ticked, slip mode off", [c.picks, c.targets, c.legacy.checkedPicks, c.legacy.addMode], [[], [], [], false]);
  check("cleared: league scope and leg count stay", [c.excludedLeagues, c.legacy.legCount], [["NHL"], 5]);
}

// ============================================================================
// "3 picks removed — games started"
// ============================================================================
{
  const t = 1_000_000;
  let line = addRemoved(null, 2, t);
  check("two picks removed", removedLineText(line, t), "2 picks removed — games started");
  line = addRemoved(line, 1, t + 1000);
  check("another one while it shows: they add up", removedLineText(line, t + 1000), "3 picks removed — games started");
  check("one", removedLineText(addRemoved(null, 1, t), t), "1 pick removed — games started");
  check("it clears itself", removedLineText(line, t + 1000 + REMOVED_LINE_MS), null);
  check("after it cleared, a new prune starts from zero", removedLineText(addRemoved(line, 1, t + 1000 + REMOVED_LINE_MS + 1), t + 1000 + REMOVED_LINE_MS + 1), "1 pick removed — games started");
  check("nothing removed: no line", addRemoved(null, 0, t), null);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
