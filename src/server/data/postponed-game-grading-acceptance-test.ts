// Regression proof for the 2026 ALCS rainout: TB @ CLE, MLB gamePk 849817,
// scheduled 2026-10-17 00:00Z, postponed, replayed 2026-10-18 21:08Z under the
// SAME gamePk. StatsAPI reports a postponed game as abstractGameState "Final"
// with no scores, so the old mapping persisted it as a 0-0 final dated
// 10/17 00:00 and never moved gameDate once the makeup was played. Six picks
// on the makeup (gameTime 10/18 21:08) then matched nothing (45h off, outside
// MAX_GAME_TIME_DRIFT_MS) and sat PENDING. ESPN does the same for its leagues:
// a postponed event is state "post", completed false, scored 0-0.
//
// Every payload below is copied from the live feeds (fetched 2026-10-20):
//   https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-10-16&endDate=2026-10-19&teamId=139
//   https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261016
// Pure - no database. Run with:
//   npx tsx src/server/data/postponed-game-grading-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { espnFeedStatus, isUnplayed, mlbFeedStatus, unplayedLabel } from "@/lib/feed-game-status";
import { computeBoardPulse } from "@/lib/board-pulse";
import { GAME_RESULT_CHANGE_LOG_MAX, outcomeFromResponse } from "@/lib/cron-runs";
import { orderBoardGames } from "@/components/live/live-scoreboard-ordering";
import { candidatesInPickWindow, gameResultIdentityChange, matchGameResult } from "./grading";
import { getMlbLiveScores, resolveScheduleGameFromFeeds, toClientScores } from "./odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const NOW = new Date("2026-10-20T12:00:00Z");
const MLB = "baseball_mlb";
const TB = "Tampa Bay Rays";
const CLE = "Cleveland Guardians";

// ---- 1. Feed status: only a real final is "final" ----
{
  const postponed = { abstractGameState: "Final", codedGameState: "D", detailedState: "Postponed", statusCode: "DR" };
  const final = { abstractGameState: "Final", codedGameState: "F", detailedState: "Final", statusCode: "F" };
  const completedEarly = { abstractGameState: "Final", codedGameState: "F", detailedState: "Completed Early", statusCode: "FR" };
  const cancelled = { abstractGameState: "Final", codedGameState: "C", detailedState: "Cancelled", statusCode: "CR" };
  const gameOver = { abstractGameState: "Final", codedGameState: "O", detailedState: "Game Over", statusCode: "O" };
  const warmup = { abstractGameState: "Live", codedGameState: "P", detailedState: "Warmup", statusCode: "PW" };
  expect("MLB Postponed (D/DR) is postponed, not final", mlbFeedStatus(postponed, "2026-10-17T00:00:00Z", NOW), "postponed");
  expect("MLB Cancelled (C/CR) is cancelled, not final", mlbFeedStatus(cancelled, "2026-09-27T17:05:00Z", NOW), "cancelled");
  expect("MLB Final (F/F) is final", mlbFeedStatus(final, "2026-10-18T21:08:00Z", NOW), "final");
  expect("MLB Completed Early (F/FR) is final", mlbFeedStatus(completedEarly, "2026-03-05T18:05:00Z", NOW), "final");
  expect("MLB Game Over (O) is final", mlbFeedStatus(gameOver, "2026-10-18T21:08:00Z", NOW), "final");
  expect("MLB Warmup is still preview", mlbFeedStatus(warmup, "2026-10-20T11:50:00Z", NOW), "preview");

  const espnPostponed = { id: "6", name: "STATUS_POSTPONED", state: "post", completed: false, description: "Postponed" };
  const espnFinal = { id: "3", name: "STATUS_FINAL", state: "post", completed: true, detail: "Final" };
  const espnFinalSo = { id: "3", name: "STATUS_FINAL", state: "post", completed: true, detail: "Final/SO" };
  const espnFinal4ot = { id: "3", name: "STATUS_FINAL", state: "post", completed: true, detail: "Final/4OT" };
  expect("ESPN Postponed (post, completed false) is postponed, not final", espnFeedStatus(espnPostponed, "2026-10-17T00:00Z", NOW), "postponed");
  expect("ESPN Final is final", espnFeedStatus(espnFinal, "2026-10-18T21:00Z", NOW), "final");
  expect("ESPN Final/SO (NHL shootout) is final", espnFeedStatus(espnFinalSo, "2025-09-20T23:00Z", NOW), "final");
  expect("ESPN Final/4OT is final", espnFeedStatus(espnFinal4ot, "2026-06-28T19:00Z", NOW), "final");
  expect("ESPN in-progress is live once started", espnFeedStatus({ state: "in", completed: false }, "2026-10-20T11:00Z", NOW), "live");
  expect("ESPN pre is preview", espnFeedStatus({ state: "pre", completed: false }, "2026-10-20T23:00Z", NOW), "preview");
}

// ---- 2. getMlbLiveScores on the real 10/16-10/19 schedule ----
async function mlbFeed() {
  const team = (name: string, score?: number) => ({ team: { name }, ...(score === undefined ? {} : { score }) });
  const game = (gamePk: number, gameDate: string, status: object, away: [string, number?], home: [string, number?]) => ({
    gamePk,
    gameDate,
    status,
    gameNumber: 1,
    doubleHeader: "N",
    teams: { away: team(...away), home: team(...home) },
  });
  const F = { abstractGameState: "Final", codedGameState: "F", detailedState: "Final", statusCode: "F" };
  const body = {
    dates: [
      { date: "2026-10-16", games: [game(849817, "2026-10-17T00:00:00Z", { abstractGameState: "Final", codedGameState: "D", detailedState: "Postponed", statusCode: "DR" }, [TB], [CLE])] },
      { date: "2026-10-17", games: [game(849816, "2026-10-18T00:08:00Z", F, [TB, 7], [CLE, 3])] },
      { date: "2026-10-18", games: [game(849817, "2026-10-18T21:08:00Z", F, [TB, 3], [CLE, 1])] },
      { date: "2026-10-19", games: [game(849815, "2026-10-20T00:08:00Z", F, [CLE, 3], [TB, 7])] },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  try {
    return await getMlbLiveScores();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  const feed = await mlbFeed();
  const [postponed, g4, g5, g6] = feed;
  expect("postponed 849817 entry maps to postponed", [postponed.id, postponed.status], ["849817", "postponed"]);
  expect("postponed entry is flagged scoreMissing", postponed.scoreMissing, true);
  expect("postponed carries no scores (was shown as Final 0-0)", postponed.scores, null);
  expect("makeup 849817 is final, TB 3-1", [g5.id, g5.status, g5.scores?.map((s) => s.score)], ["849817", "final", ["1", "3"]]);
  expect("real finals carry no scoreMissing flag", [g4.scoreMissing, g5.scoreMissing, g6.scoreMissing], [undefined, undefined, undefined]);
  expect("toClientScores never sends scoreMissing", toClientScores(feed).some((g) => "scoreMissing" in g), false);

  // ---- 3. gameDate-update guard (persistFinalScores' update branch) ----
  const row849817 = { externalId: "849817", gameDate: new Date("2026-10-17T00:00:00Z"), homeTeam: CLE, awayTeam: TB };
  expect(
    "makeup final moves the stale row's gameDate, teams untouched",
    gameResultIdentityChange(MLB, row849817, g5),
    { sportKey: MLB, externalId: "849817", gameDate: { from: "2026-10-17T00:00:00.000Z", to: "2026-10-18T21:08:00.000Z" } }
  );
  const row849816 = { externalId: "849816", gameDate: new Date("2026-10-18T00:08:00Z"), homeTeam: CLE, awayTeam: TB };
  expect("guard: start time and teams match -> no change", gameResultIdentityChange(MLB, row849816, g4), null);
  expect(
    "guard: same instant in another ISO spelling -> no change",
    gameResultIdentityChange(MLB, row849816, { homeTeam: CLE, awayTeam: TB, commenceTime: "2026-10-18T00:08:00.000Z" }),
    null
  );
  expect(
    "guard: an unparseable feed start time never moves gameDate",
    gameResultIdentityChange(MLB, row849816, { homeTeam: CLE, awayTeam: TB, commenceTime: "" }),
    null
  );
  const row849815 = { externalId: "849815", gameDate: new Date("2026-10-20T00:08:00Z"), homeTeam: TB, awayTeam: CLE };
  expect("guard: Game 6 (CLE @ TB) keeps its own orientation", gameResultIdentityChange(MLB, row849815, g6), null);
  expect(
    "teams change only when the feed's own teams for that id changed",
    gameResultIdentityChange(MLB, row849815, { homeTeam: CLE, awayTeam: TB, commenceTime: "2026-10-20T00:08:00Z" }),
    { sportKey: MLB, externalId: "849815", teams: { from: "Cleveland Guardians @ Tampa Bay Rays", to: "Tampa Bay Rays @ Cleveland Guardians" } }
  );

  // ---- 4. Matcher, on the exact stuck picks ----
  const gr = (id: string, iso: string, home: string, away: string, homeScore: number, awayScore: number) => ({
    id,
    gameDate: new Date(iso),
    homeTeam: home,
    awayTeam: away,
    homeScore,
    awayScore,
    gameNumber: 1,
  });
  const pick = (iso: string, home: string, away: string, betDetail: string | null = null) => ({
    gameTime: new Date(iso),
    homeTeam: home,
    awayTeam: away,
    betDetail,
    gameNumber: null,
  });
  const g4Row = gr("849816", "2026-10-18T00:08:00Z", CLE, TB, 3, 7);
  const g6Row = gr("849815", "2026-10-20T00:08:00Z", TB, CLE, 7, 3);
  // What prod holds today: the makeup's real score on the postponed slot's date.
  const staleG5 = gr("849817", "2026-10-17T00:00:00Z", CLE, TB, 1, 3);
  // What the update guard leaves once the makeup is seen as final.
  const fixedG5 = gr("849817", "2026-10-18T21:08:00Z", CLE, TB, 1, 3);
  // What prod held from the postponement until the makeup went final.
  const phantomG5 = gr("849817", "2026-10-17T00:00:00Z", CLE, TB, 0, 0);

  const makeupMl = pick("2026-10-18T21:08:00Z", CLE, TB, "Guardians Money Line");
  const makeupTotal = pick("2026-10-18T21:08:00Z", CLE, TB, "Guardians Under 6.5");
  const game6Spread = pick("2026-10-20T00:08:00Z", TB, CLE, "Guardians vs. Rays +0.5");

  expect("stale row: makeup ML pick matches nothing (stays PENDING)", matchGameResult([g4Row, staleG5, g6Row], makeupMl, MLB), null);
  expect("stale row: per-pick window count is 3", candidatesInPickWindow([g4Row, staleG5, g6Row], makeupMl), 3);
  expect("fixed row: makeup ML pick -> 849817 exact", matchGameResult([g4Row, fixedG5, g6Row], makeupMl, MLB)?.game.id, "849817");
  expect("fixed row: makeup total pick -> 849817 exact", matchGameResult([g4Row, fixedG5, g6Row], makeupTotal, MLB)?.game.id, "849817");
  expect(
    "Game 6 spread pick -> 849815, exact, not the makeup",
    [matchGameResult([g4Row, fixedG5, g6Row], game6Spread, MLB)?.game.id, matchGameResult([g4Row, fixedG5, g6Row], game6Spread, MLB)?.matchType],
    ["849815", "exact"]
  );

  const originalSlot = pick("2026-10-17T00:00:00Z", CLE, TB, "Rays Money Line");
  expect("MLB: a 0-0 phantom row is refused", matchGameResult([phantomG5, g4Row], originalSlot, MLB), null);
  expect("NHL: a 0-0 row is refused", matchGameResult([phantomG5], originalSlot, "icehockey_nhl"), null);
  expect("no sportKey: 0-0 row still matches (old behavior kept for callers that don't pass one)", matchGameResult([phantomG5], originalSlot)?.game.id, "849817");
  expect("NFL: 0-0 is still a possible final", matchGameResult([phantomG5], originalSlot, "americanfootball_nfl")?.game.id, "849817");

  // Fuzzy path: nickname-only teams. A reversed-orientation game 1h away must
  // lose to the same-orientation one 2h away.
  const sameWay = gr("same", "2026-10-18T19:00:00Z", CLE, TB, 1, 3);
  const flipped = gr("flipped", "2026-10-18T22:00:00Z", TB, CLE, 3, 1);
  const fuzzyPick = pick("2026-10-18T21:00:00Z", "Guardians", "Rays");
  expect("fuzzy: same orientation wins over a closer reversed game", matchGameResult([sameWay, flipped], fuzzyPick, MLB)?.game.id, "same");
  expect("fuzzy: reversed is the fallback inside 6h", matchGameResult([flipped], fuzzyPick, MLB)?.game.id, "flipped");
  expect(
    "fuzzy: reversed game outside 6h is never a fallback",
    matchGameResult([gr("far", "2026-10-20T00:08:00Z", TB, CLE, 7, 3)], fuzzyPick, MLB),
    null
  );

  // ---- 5. Cron run log carries every change, old -> new ----
  const change = gameResultIdentityChange(MLB, row849817, g5);
  const graded = outcomeFromResponse("grade-picks", 200, {
    ok: true,
    results: [{ sport: MLB, persisted: 3, gameResultChanges: [change], grading: { graded: 6, notMatched: 0, remaining: 0 } }],
  });
  expect(
    "grade-picks summary logs the change",
    [graded.summary?.gameResultsChanged, graded.summary?.gameResultChangeLog],
    [1, "baseball_mlb 849817, gameDate 2026-10-17T00:00:00.000Z -> 2026-10-18T21:08:00.000Z"]
  );
  expect("grade-picks rowsTouched unchanged by the log", graded.rowsTouched, 9);
  const refreshed = outcomeFromResponse("refresh-scores", 200, { ok: true, results: [{ sport: MLB, persisted: 3, gameResultChanges: [change] }] });
  expect("refresh-scores rowsTouched stays numeric", refreshed.rowsTouched, 3);
  expect("refresh-scores summary logs the change", refreshed.summary?.gameResultsChanged, 1);
  const quiet = outcomeFromResponse("grade-picks", 200, { ok: true, results: [{ sport: MLB, persisted: 3, gameResultChanges: [] }] });
  expect("a run with no changes adds no keys", "gameResultsChanged" in (quiet.summary ?? {}), false);

  // ---- 6. Change log is capped at the first 20 entries, full count kept ----
  const many = Array.from({ length: 23 }, (_, i) => ({ sportKey: MLB, externalId: "pk" + i, gameDate: { from: "a", to: "b" } }));
  const capped = outcomeFromResponse("refresh-scores", 200, { ok: true, results: [{ sport: MLB, persisted: 23, gameResultChanges: many }] });
  const entries = String(capped.summary?.gameResultChangeLog).split("; ");
  expect("cap: total count is the full 23", capped.summary?.gameResultsChanged, 23);
  expect("cap: log holds the first 20 plus a remainder note", [entries.length, entries[0], entries[19], entries[20]], [
    GAME_RESULT_CHANGE_LOG_MAX + 1,
    "baseball_mlb pk0, gameDate a -> b",
    "baseball_mlb pk19, gameDate a -> b",
    "... +3 more",
  ]);
  const exactly20 = outcomeFromResponse("refresh-scores", 200, { ok: true, results: [{ sport: MLB, persisted: 20, gameResultChanges: many.slice(0, 20) }] });
  expect("cap: exactly 20 has no remainder note", String(exactly20.summary?.gameResultChangeLog).includes("more"), false);

  // ---- 7. Import never attaches a pick to a postponed slot ----
  // The 10/17 feed: the postponed slot plus Game 4 later that night (both TB @ CLE).
  const isTbCle = (g: { homeTeam: string; awayTeam: string }) => g.homeTeam === CLE && g.awayTeam === TB;
  const importAt = new Date("2026-10-16T23:30:00Z");
  const resolvedPick = resolveScheduleGameFromFeeds([postponed, g4], [], isTbCle, importAt);
  expect("import on 10/16 evening resolves Game 4, not the postponed slot", resolvedPick.game?.id, "849816");
  expect("only the postponed slot on the feed -> no match (manual), never the postponed slot", resolveScheduleGameFromFeeds([postponed], [], isTbCle, importAt).game, null);

  // ---- 8. /live board: a postponed game sits with the not-yet-started tier ----
  const board = orderBoardGames(
    [
      { id: "live", game: { commenceTime: "2026-10-20T11:00:00Z" }, score: { status: "live" as const } },
      { id: "later", game: { commenceTime: "2026-10-20T23:00:00Z" }, score: { status: "preview" as const } },
      { id: "ppd", game: { commenceTime: "2026-10-20T10:00:00Z" }, score: { status: "postponed" as const } },
      { id: "final", game: { commenceTime: "2026-10-20T09:00:00Z" }, score: { status: "final" as const } },
    ],
    "2026-10-20",
    NOW
  );
  expect("board: live first, then postponed/upcoming by start time, final off", board.map((g) => g.id), ["live", "ppd", "later"]);
  const yesterday = orderBoardGames([{ id: "ppd", game: { commenceTime: "2026-10-19T23:00:00Z" }, score: { status: "postponed" as const } }], "2026-10-20", NOW);
  expect("board: a past-day postponed game ages off like any carry-over (8h)", yesterday.length, 0);

  // ---- 9. Cancelled: its own label, otherwise identical to postponed ----
  {
    // ESPN shape for a cancelled game (not seen in the 2025-26 scan window, so
    // this mirrors STATUS_POSTPONED with ESPN's cancelled name).
    const espnCancelled = { id: "5", name: "STATUS_CANCELED", state: "post", completed: false, description: "Canceled" };
    expect("ESPN STATUS_CANCELED is cancelled", espnFeedStatus(espnCancelled, "2026-10-17T00:00Z", NOW), "cancelled");
    expect("labels: Postponed vs Cancelled", [unplayedLabel("postponed"), unplayedLabel("cancelled"), unplayedLabel("preview")], ["Postponed", "Cancelled", null]);
    expect("both count as unplayed", [isUnplayed("postponed"), isUnplayed("cancelled"), isUnplayed("final")], [true, true, false]);
    // BAL @ NYY, gamePk 823490, cancelled 2026-09-27 (StatsAPI CR, no scores).
    const cancelledGame = { ...postponed, id: "823490", status: "cancelled" as const, homeTeam: "New York Yankees", awayTeam: "Baltimore Orioles", commenceTime: "2026-09-27T17:05:00Z" };
    const isBalNyy = (g: { homeTeam: string; awayTeam: string }) => g.homeTeam === "New York Yankees" && g.awayTeam === "Baltimore Orioles";
    expect("cancelled slot is never an import target", resolveScheduleGameFromFeeds([cancelledGame], [], isBalNyy, new Date("2026-09-27T16:00:00Z")).game, null);
    const sameDay = orderBoardGames(
      [
        { id: "can", game: { commenceTime: "2026-10-20T10:00:00Z" }, score: { status: "cancelled" as const } },
        { id: "ppd", game: { commenceTime: "2026-10-20T10:30:00Z" }, score: { status: "postponed" as const } },
      ],
      "2026-10-20",
      NOW
    );
    expect("cancelled sorts and stays visible exactly like postponed", sameDay.map((g) => g.id), ["can", "ppd"]);
    // 2-0 to the favorite: a game the pulse did NOT skip would count as a live lead.
    const pulseGame = { status: "cancelled" as const, homeScore: 2, awayScore: 0, inningHalf: null, inningOrdinal: null, favorite: "home" as const, totalLine: 8.5 };
    const pulse = computeBoardPulse([{ id: "c", ...pulseGame }, { id: "p", ...pulseGame, status: "postponed" as const }]);
    expect("board pulse skips cancelled and postponed games", [pulse.favsWon, pulse.favsLeadingLive, pulse.trendingUnder], [0, 0, 0]);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
