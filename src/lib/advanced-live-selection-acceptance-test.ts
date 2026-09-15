// Correctness proof for resolveAdvancedLiveSelection (advanced-live-selection.ts)
// - the single shared rule behind Advanced Live's game/team fallback. Covers
// all three trigger cases the spec calls out as "the same rule": initial
// load with nothing selected, a sport switch invalidating the old gameId,
// and the selected game dropping off the board (both same as "not found in
// sortedGameIds" from this function's point of view) - plus the
// unconditional home-team default.
// Run with:
//   npx tsx src/lib/advanced-live-selection-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { resolveAdvancedLiveSelection } from "./advanced-live-selection";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

// ---- Initial load: no gameId/team requested at all ----

expect(
  "no requested gameId falls back to the first sorted game, team defaults to home",
  resolveAdvancedLiveSelection(["game-1", "game-2"], null, null),
  { gameId: "game-1", team: "home" }
);

// ---- A valid requested selection is preserved as-is ----

expect(
  "a requested gameId that's still in the sorted list is kept",
  resolveAdvancedLiveSelection(["game-1", "game-2"], "game-2", "away"),
  { gameId: "game-2", team: "away" }
);

// ---- Sport switch: the old gameId isn't in the new sport's slate at all ----

expect(
  "a requested gameId absent from the new slate (sport switch) falls back to the first game",
  resolveAdvancedLiveSelection(["nfl-game-a", "nfl-game-b"], "mlb-game-x", "away"),
  { gameId: "nfl-game-a", team: "away" }
);

// ---- Selected game going Final: it simply drops out of sortedGameIds ----

expect(
  "a requested gameId no longer in the list (game went Final and dropped off) falls back to the first remaining game",
  resolveAdvancedLiveSelection(["game-2", "game-3"], "game-1", "home"),
  { gameId: "game-2", team: "home" }
);

// ---- Empty slate ----

expect("an empty slate resolves to no game selected", resolveAdvancedLiveSelection([], "game-1", "away"), {
  gameId: null,
  team: "away",
});

// ---- Team default is unconditional ----

expect(
  "team defaults to home when nothing (or anything other than 'away') is requested",
  resolveAdvancedLiveSelection(["game-1"], "game-1", "bogus"),
  { gameId: "game-1", team: "home" }
);

expect(
  "team defaults to home when null is requested",
  resolveAdvancedLiveSelection(["game-1"], "game-1", null),
  { gameId: "game-1", team: "home" }
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll passed.");
