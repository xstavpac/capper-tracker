// Correctness proof for resolveAdvancedLiveSelection (advanced-live-selection.ts)
// - the single shared rule behind Advanced Live's game fallback. Covers both
// trigger cases the spec calls out as "the same rule": initial load with
// nothing selected, and the selected game dropping off the board (a sport
// switch invalidating the old gameId is the same "not found in
// sortedGameIds" case from this function's point of view as the game going
// Final).
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

// ---- Initial load: no gameId requested at all ----

expect(
  "no requested gameId falls back to the first sorted game",
  resolveAdvancedLiveSelection(["game-1", "game-2"], null),
  { gameId: "game-1" }
);

// ---- A valid requested selection is preserved as-is ----

expect(
  "a requested gameId that's still in the sorted list is kept",
  resolveAdvancedLiveSelection(["game-1", "game-2"], "game-2"),
  { gameId: "game-2" }
);

// ---- Sport switch: the old gameId isn't in the new sport's slate at all ----

expect(
  "a requested gameId absent from the new slate (sport switch) falls back to the first game",
  resolveAdvancedLiveSelection(["nfl-game-a", "nfl-game-b"], "mlb-game-x"),
  { gameId: "nfl-game-a" }
);

// ---- Selected game going Final: it simply drops out of sortedGameIds ----

expect(
  "a requested gameId no longer in the list (game went Final and dropped off) falls back to the first remaining game",
  resolveAdvancedLiveSelection(["game-2", "game-3"], "game-1"),
  { gameId: "game-2" }
);

// ---- Empty slate ----

expect("an empty slate resolves to no game selected", resolveAdvancedLiveSelection([], "game-1"), {
  gameId: null,
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll passed.");
