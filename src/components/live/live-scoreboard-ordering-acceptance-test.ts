// Correctness proof for orderBoardGames (live-scoreboard-ordering.ts) - the
// Live tab's filter + sort. Covers the two bugs it fixes:
//   1. a completed early game must sort to the bottom, below still-upcoming
//      later games, not in among them by start time
//   2. a game that started last night and is still in progress after
//      midnight must stay on the board (it was carried over from yesterday's
//      odds snapshot) - and drop off only once it goes Final
// Run with:
//   npx tsx src/components/live/live-scoreboard-ordering-acceptance-test.ts
//
// Exits non-zero if any assertion fails.
import { orderBoardGames } from "./live-scoreboard-ordering";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const TODAY = "2026-08-29";
// August ET is EDT (UTC-4) - explicit offsets so the day boundary is unambiguous.
const g = (id: string, iso: string, status?: "preview" | "live" | "final") => ({
  id,
  game: { commenceTime: iso },
  score: status ? { status } : undefined,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

// ---- Bug 1: 3-tier status order, start-time tiebreak within a tier ----

{
  const board = [
    g("upcoming-7pm", "2026-08-29T19:00:00-04:00"), // no score yet
    g("final-1pm", "2026-08-29T13:00:00-04:00", "final"),
    g("live-541pm", "2026-08-29T17:41:00-04:00", "live"),
    g("upcoming-541pm", "2026-08-29T17:41:00-04:00", "preview"),
    g("final-4pm", "2026-08-29T16:00:00-04:00", "final"),
  ];
  expect(
    "user's case (b): live, then upcoming by time, then finals grouped at the bottom by time",
    ids(orderBoardGames(board, TODAY)),
    ["live-541pm", "upcoming-541pm", "upcoming-7pm", "final-1pm", "final-4pm"]
  );
}

{
  // The regression the previous live-first sort was added for: a live game
  // that started at 1 PM must still sit above a 7 PM game that hasn't started.
  const board = [
    g("upcoming-7pm", "2026-08-29T19:00:00-04:00", "preview"),
    g("live-1pm", "2026-08-29T13:00:00-04:00", "live"),
  ];
  expect("live-above-upcoming is preserved", ids(orderBoardGames(board, TODAY)), ["live-1pm", "upcoming-7pm"]);
}

{
  // A same-day Final is kept - it just sorts to the bottom (not dropped the
  // way a carried-over Final is).
  const board = [
    g("final-1pm", "2026-08-29T13:00:00-04:00", "final"),
    g("upcoming-8pm", "2026-08-29T20:00:00-04:00", "preview"),
  ];
  expect("same-day Final stays on the board, at the bottom", ids(orderBoardGames(board, TODAY)), ["upcoming-8pm", "final-1pm"]);
}

// ---- Bug 2: a game that crossed midnight ----

{
  // Started 11 PM yesterday, still in progress at ~2 AM today.
  const crossedMidnight = g("giants-dbacks", "2026-08-28T23:00:00-04:00", "live");
  const board = [g("today-1pm", "2026-08-29T13:00:00-04:00", "preview"), crossedMidnight];
  const out = orderBoardGames(board, TODAY);
  expect("user's case (a): a still-live game from last night stays on the board", ids(out).includes("giants-dbacks"), true);
  expect("...and sorts into the live tier, above today's not-yet-started games", ids(out), ["giants-dbacks", "today-1pm"]);
}

{
  // Same game, once it goes Final: it belongs on its own date now, not
  // today's board.
  const board = [
    g("today-1pm", "2026-08-29T13:00:00-04:00", "preview"),
    g("giants-dbacks", "2026-08-28T23:00:00-04:00", "final"),
  ];
  expect("a carried-over game drops off the board the moment it goes Final", ids(orderBoardGames(board, TODAY)), ["today-1pm"]);
}

{
  // A yesterday game that never went live (postponed / stale in the
  // snapshot) is not carried over.
  const board = [
    g("today-1pm", "2026-08-29T13:00:00-04:00", "preview"),
    g("yesterday-ppd", "2026-08-28T19:00:00-04:00", "preview"),
    g("yesterday-no-score", "2026-08-28T19:00:00-04:00"),
  ];
  expect("carried-over games that aren't live are dropped", ids(orderBoardGames(board, TODAY)), ["today-1pm"]);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
