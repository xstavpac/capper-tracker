// Correctness proof for the Live tab's "today and live only" game list and its single
// "See more" toggle (orderBoardGames' `todayOnly` scope, lib/live-list-scope.ts, and the
// three surfaces that read it). Covers:
//   1. the default scope: live games and games dated today or earlier (Eastern); Finals
//      stay hidden; later-day games inside the lookahead window are hidden
//   2. the fallback: nothing left in that scope AFTER Finals are removed -> the whole
//      window, never an empty board (and no "See more" button for it)
//   3. the toggle moves Grid's list, Feed's list and the category panel's tile counts
//      together - same orderBoardGames call, same flag, wired in each component
//   4. a deep link (?gameId= or a category-panel jump) to a hidden later-day game opens
//      the list expanded instead of falling back to another game
//   5. a league switch resets the toggle
//   6. the server-side window and pick matching are untouched (display-only change)
// Run with:
//   npx tsx src/lib/live-list-scope-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenLaterGameCount, orderBoardGames } from "@/components/live/live-scoreboard-ordering";
import { needsExpandToShow, resolveInitialScope, resolveShowAll } from "@/lib/live-list-scope";
import { slatePicksByCategory, visibleGameIndexes, type LiveCategoryPick } from "@/lib/live-category-picks";
import { resolveGridLiveSelection } from "@/lib/grid-live-selection";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const TODAY = "2026-08-29"; // EDT (UTC-4): explicit offsets so the Eastern day boundary is unambiguous
const NOW = new Date("2026-08-29T15:00:00-04:00");
type Status = "preview" | "live" | "final";
const g = (id: string, iso: string, status?: Status) => ({
  id,
  game: { id, commenceTime: iso },
  score: status ? { status } : undefined,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const scoped = (rows: ReturnType<typeof g>[]) => ids(orderBoardGames(rows, TODAY, NOW, { todayOnly: true }));
const full = (rows: ReturnType<typeof g>[]) => ids(orderBoardGames(rows, TODAY, NOW));

// ---- 1. default scope ----

const slate = [
  g("sat-late", "2026-08-29T21:00:00-04:00"),
  g("sat-live", "2026-08-29T13:00:00-04:00", "live"),
  g("sat-final", "2026-08-29T12:00:00-04:00", "final"),
  g("sun", "2026-08-30T13:00:00-04:00"),
  g("mon", "2026-08-31T20:00:00-04:00"),
  g("tue", "2026-09-01T20:00:00-04:00"), // inside the 4-day lookahead (cutoff 2026-09-02)
  g("beyond", "2026-09-09T20:00:00-04:00"), // past it: never on the board in either scope
];
expect("default scope: today's + live only, Finals hidden, later days hidden", scoped(slate), ["sat-live", "sat-late"]);
expect("no scope = the whole lookahead window, as before", full(slate), ["sat-live", "sat-late", "sun", "mon", "tue"]);
expect("'See more' hides exactly the later-day games", hiddenLaterGameCount(slate, TODAY, NOW), 3);

{
  // A still-live game from last night is "dated earlier" and stays in the default scope.
  const board = [g("last-night-live", "2026-08-28T22:00:00-04:00", "live"), g("tomorrow", "2026-08-30T13:00:00-04:00"), g("tonight", "2026-08-29T19:00:00-04:00")];
  expect("a live carry-over from last night is in the default scope", scoped(board), ["last-night-live", "tonight"]);
}

// ---- 2. empty-after-Finals fallback ----

{
  // Today's only game is Final: the default scope is empty AFTER Finals are removed, so the
  // later-day games show instead of a blank board.
  const board = [g("sat-final", "2026-08-29T12:00:00-04:00", "final"), g("sun", "2026-08-30T13:00:00-04:00"), g("mon", "2026-08-31T20:00:00-04:00")];
  expect("today's last game just ended -> falls back to the whole window", scoped(board), ["sun", "mon"]);
  expect("the fallback hides nothing, so no 'See more'", hiddenLaterGameCount(board, TODAY, NOW), 0);
}
{
  // A Tuesday-style board: nothing today at all.
  const board = [g("thu", "2026-09-01T20:00:00-04:00"), g("sat", "2026-09-03T12:00:00-04:00")];
  expect("zero games today -> the full list, not an empty state", scoped(board), ["thu", "sat"]);
  expect("no games today: nothing hidden", hiddenLaterGameCount(board, TODAY, NOW), 0);
}
{
  const board = [g("only-final", "2026-08-29T12:00:00-04:00", "final")];
  expect("nothing on the board at all stays empty", scoped(board), []);
}

// ---- 3. the toggle moves all three surfaces ----

{
  const games = slate.map((r) => ({ id: r.id, homeTeam: "H" + r.id, awayTeam: "A" + r.id, commenceTime: r.game.commenceTime }));
  const picks: LiveCategoryPick[] = games.map((game, gameIndex) => ({
    pickId: "p-" + game.id,
    gameIndex,
    category: "FAV_ML",
    betDetail: "x",
    capperId: "c",
    capperName: "C",
    status: "PENDING",
    gameTime: game.commenceTime,
  }));
  // Category panel: the visible-card set, and the tile pool built from it, follow the flag.
  const collapsed = visibleGameIndexes(games, [], TODAY, undefined, true);
  const expanded = visibleGameIndexes(games, [], TODAY, undefined, false);
  expect("category panel, collapsed: only today's cards count", [...collapsed].sort(), [0, 1, 2]);
  expect("category panel, expanded: the whole window counts", [...expanded].sort(), [0, 1, 2, 3, 4, 5]);
  expect("tile pool, collapsed", slatePicksByCategory(picks, collapsed).get("FAV_ML")?.length, 3);
  expect("tile pool, expanded", slatePicksByCategory(picks, expanded).get("FAV_ML")?.length, 6);
  expect("category panel defaults to the full window when no flag is passed (unchanged callers)", [...visibleGameIndexes(games, [], TODAY)].length, 6);

  // Grid and Feed call the same orderBoardGames; the wiring is what makes them one toggle.
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  const grid = read("src/components/live/grid-live-board.tsx");
  const feed = read("src/components/live/live-scoreboard.tsx");
  const panel = read("src/components/live/live-category-panel.tsx");
  expect("Grid reads the shared toggle and filters with it", grid.includes("useLiveListScope()") && grid.includes("{ todayOnly: !showAll }"), true);
  expect("Feed reads the shared toggle and filters with it", feed.includes("useLiveListScope()") && feed.includes("{ todayOnly: !showAll }"), true);
  expect("category panel reads the shared toggle and filters with it", panel.includes("useLiveListScope()") && panel.includes("!showAll)"), true);
  expect("Grid and Feed both render the See more button", grid.includes("hiddenCount={hiddenCount}") && feed.includes("<SeeMoreGamesButton"), true);
}

// ---- 4. deep link auto-expand ----

{
  const rows = [g("sat", "2026-08-29T19:00:00-04:00"), g("mon", "2026-08-31T20:00:00-04:00")];
  const hidden = resolveInitialScope(rows, TODAY, "mon", NOW);
  expect("?gameId= for a hidden later-day game opens the list expanded", hidden, { showAll: true, gameIds: ["sat", "mon"] });
  expect("...and the selection lands on that game", resolveGridLiveSelection(hidden.gameIds, "mon"), { gameId: "mon" });

  const visible = resolveInitialScope(rows, TODAY, "sat", NOW);
  expect("?gameId= for a game already shown stays collapsed", visible, { showAll: false, gameIds: ["sat"] });
  expect("no ?gameId= stays collapsed", resolveInitialScope(rows, TODAY, null, NOW), { showAll: false, gameIds: ["sat"] });
  const unknown = resolveInitialScope(rows, TODAY, "gone", NOW);
  expect("?gameId= for a game on no board stays collapsed (selection falls back as before)", [unknown.showAll, resolveGridLiveSelection(unknown.gameIds, "gone")], [false, { gameId: "sat" }]);

  // In-page jumps (category-panel row, game click): the same question, asked on the client.
  expect("a jump to a hidden game needs the list expanded", needsExpandToShow(rows, TODAY, "mon", NOW), true);
  expect("a jump to a shown game does not", needsExpandToShow(rows, TODAY, "sat", NOW), false);
  expect("a jump to a game on no board does not (nothing to reveal)", needsExpandToShow(rows, TODAY, "gone", NOW), false);
  expect("with an empty-scope fallback nothing is hidden, so nothing to expand", needsExpandToShow([g("mon", "2026-08-31T20:00:00-04:00")], TODAY, "mon", NOW), false);
}

// ---- 5. sport-switch reset ----

{
  expect("toggle on for NFL reads on for NFL", resolveShowAll({ sportKey: "nfl", showAll: true }, "nfl"), true);
  expect("...and reads collapsed after switching to NCAAF", resolveShowAll({ sportKey: "nfl", showAll: true }, "ncaaf"), false);
  expect("collapsed stays collapsed", resolveShowAll({ sportKey: "nfl", showAll: false }, "nfl"), false);
  const page = readFileSync(join(process.cwd(), "src/app/(app)/live/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  expect("the provider is keyed on the league, so a switch remounts it collapsed", /<LiveListScopeProvider key=\{activeSport\}/.test(page), true);
  expect("the page's initial selection resolves against the same scoped list", page.includes("resolveGridLiveSelection(initialScope.gameIds"), true);
}

// ---- 6. display-only: the server window and pick matching are not touched ----

{
  const board = readFileSync(join(process.cwd(), "src/server/data/live-board-picks.ts"), "utf8");
  expect("live-board-picks.ts does not use the display scope", board.includes("todayOnly"), false);
  const picks = readFileSync(join(process.cwd(), "src/server/data/picks.ts"), "utf8");
  expect("pick matching does not use the display scope", picks.includes("todayOnly"), false);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
