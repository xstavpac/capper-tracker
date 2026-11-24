// Proof for fresh-live-scores.ts: the Parlay Generator never acts on a game state
// older than LIVE_STATE_MAX_AGE_MS. A cached read past the max age is replaced by a
// direct read; a direct read that times out or fails leaves the league UNAVAILABLE,
// and an UNAVAILABLE started game is judged by time since its start alone (#531
// backstops) - never by the old rows.
// Pure: fake fetchers, no DB, no network. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/fresh-live-scores-acceptance-test.ts
import {
  FREE_SCORE_FEEDS,
  LIVE_STATE_MAX_AGE_MS,
  isFreshEnough,
  readFreshLiveScores,
  scoresReadAt,
  type FreshLiveScoreDeps,
} from "@/server/data/fresh-live-scores";
import { freshLiveFeedsForBoards, liveStatesFromFeeds } from "@/server/data/live-state";
import { gameStatusFor } from "@/server/data/expander-pick";
import { toClientScores, type OddsGame, type ScoreGame } from "@/server/data/odds";
import { isGameOver } from "@/lib/parlay/game-over";
import { poolEligible } from "@/lib/parlay/game-progress";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

// The 2026-11-24 case: puck drop 00:10Z, generator run at 03:09Z.
const START = "2026-11-24T00:10:00.000Z";
const NOW = new Date("2026-11-24T03:09:35.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function row(status: ScoreGame["status"], fetchedAt: string | undefined, period: number | null = null, clock: string | null = null): ScoreGame {
  return {
    id: "401892770",
    homeTeam: "New Jersey Devils",
    awayTeam: "Columbus Blue Jackets",
    status,
    scores: status === "preview" ? null : [{ name: "New Jersey Devils", score: "1" }, { name: "Columbus Blue Jackets", score: "2" }],
    commenceTime: START,
    inningHalf: null,
    inningOrdinal: null,
    innings: null,
    period,
    clock,
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}
const boardGame: OddsGame = { id: "odds-cbj-njd", sportKey: "icehockey_nhl", homeTeam: "New Jersey Devils", awayTeam: "Columbus Blue Jackets", commenceTime: START } as OddsGame;

type Calls = { cached: number; uncached: number };
function deps(cached: () => Promise<ScoreGame[]>, uncached: () => Promise<ScoreGame[]>, calls: Calls, over: Partial<FreshLiveScoreDeps> = {}): FreshLiveScoreDeps {
  return {
    readCached: () => (calls.cached++, cached()),
    fetchUncached: () => (calls.uncached++, uncached()),
    maxAgeMs: LIVE_STATE_MAX_AGE_MS,
    timeoutMs: 100,
    ...over,
  };
}
const never = () => new Promise<ScoreGame[]>(() => {});

async function main() {
  check("max age is 45 s", LIVE_STATE_MAX_AGE_MS, 45_000);

  // ---- age of a read ----
  check("readAt: the oldest row's stamp", scoresReadAt([row("live", ago(10_000)), row("live", ago(30_000))]), NOW.getTime() - 30_000);
  check("readAt: any unstamped row or no rows = unknown", [scoresReadAt([row("live", ago(1)), row("live", undefined)]), scoresReadAt([])], [null, null]);
  check("fresh enough: 45 s yes, 46 s no, unknown no", [isFreshEnough([row("live", ago(45_000))], NOW, LIVE_STATE_MAX_AGE_MS), isFreshEnough([row("live", ago(46_000))], NOW, LIVE_STATE_MAX_AGE_MS), isFreshEnough([row("live", undefined)], NOW, LIVE_STATE_MAX_AGE_MS)], [true, false, false]);

  // ---- 1. fresh cached state is used, no extra read ----
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => [row("live", ago(10_000), 2, "5:01")], never, calls));
    check("fresh cache (10 s old): used as is", [r.kind, r.kind !== "UNAVAILABLE" && r.scores[0].period], ["CACHED", 2]);
    check("fresh cache: no direct read", calls.uncached, 0);
  }

  // ---- 2. stale cached state past the max age is NOT used ----
  {
    const calls = { cached: 0, uncached: 0 };
    const stale = [row("live", ago(2 * 3600_000), 1, "12:00")]; // what the cle1 entry still said
    const fresh = [row("final", NOW.toISOString())];
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => stale, async () => fresh, calls));
    check("stale cache (2 h old): read again directly", [r.kind, calls.uncached], ["REFETCHED", 1]);
    const scores = r.kind === "UNAVAILABLE" ? [] : r.scores;
    const status = gameStatusFor(scores, boardGame, "icehockey_nhl");
    check("stale cache: the fresh status (final) is what the game gets, not the old live P1", status, "final");
    check("stale cache: the game is over, so out of the pool", [isGameOver({ gameTime: START, gameStatus: status }, NOW), poolEligible({ gameTime: START, gameStatus: status, leagueName: "NHL" }, NOW)], [true, false]);
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => [row("live", ago(46_000), 1, "12:00")], async () => [row("live", NOW.toISOString(), 2, "8:00")], calls));
    check("cache 46 s old: just past the max age, read again", [r.kind, r.kind !== "UNAVAILABLE" && r.scores[0].period], ["REFETCHED", 2]);
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => [row("preview", undefined)], async () => [row("live", NOW.toISOString(), 3, "10:00")], calls));
    check("unstamped cache (entry from before this change): read again", [r.kind, calls.uncached], ["REFETCHED", 1]);
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => { throw new Error("data cache down"); }, async () => [row("live", NOW.toISOString(), 1, "3:00")], calls));
    check("cache read throws: read directly", r.kind, "REFETCHED");
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(never, async () => [row("live", NOW.toISOString(), 1, "3:00")], calls));
    check("cache read hangs: bounded, then read directly", r.kind, "REFETCHED");
  }

  // ---- 3. direct read times out / fails: UNAVAILABLE, never the stale rows ----
  {
    const calls = { cached: 0, uncached: 0 };
    const started = Date.now();
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => [row("preview", ago(2 * 3600_000))], never, calls));
    check("stale cache + direct read times out: UNAVAILABLE", r.kind, "UNAVAILABLE");
    check("the wait is bounded by the timeout", Date.now() - started < 1000, true);
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("icehockey_nhl", NOW, deps(async () => [row("preview", ago(2 * 3600_000))], async () => { throw new Error("fetch failed"); }, calls));
    check("stale cache + direct read fails: UNAVAILABLE", r.kind, "UNAVAILABLE");
  }
  {
    const calls = { cached: 0, uncached: 0 };
    const r = await readFreshLiveScores("americanfootball_cfl", NOW, deps(async () => [row("live", ago(2 * 3600_000), 1, "5:00")], async () => [], calls));
    check("a paid feed (CFL: Odds API credits) is never read again; stale -> UNAVAILABLE", [FREE_SCORE_FEEDS.has("americanfootball_cfl"), r.kind, calls.uncached], [false, "UNAVAILABLE", 0]);
  }
  check("every generator league is a free feed", ["americanfootball_nfl", "americanfootball_ncaaf", "basketball_nba", "basketball_wnba", "basketball_ncaab", "icehockey_nhl", "baseball_mlb"].every((k) => FREE_SCORE_FEEDS.has(k)), true);

  // ---- UNAVAILABLE -> the #531 time limits, not the stale state ----
  {
    const at = (min: number) => new Date(new Date(START).getTime() + min * 60_000);
    const unavailable = { gameTime: START, leagueName: "NHL", gameStatus: null, liveState: null, stateUnavailable: true };
    check("UNAVAILABLE NHL game: in up to its 110-min limit, out after", [poolEligible(unavailable, at(30)), poolEligible(unavailable, at(110)), poolEligible(unavailable, at(111))], [true, true, false]);
    check("UNAVAILABLE at 03:09 (179 min after 00:10): out", poolEligible(unavailable, NOW), false);
    check("without the flag, no status after kickoff stays out (unchanged)", poolEligible({ gameTime: START, leagueName: "NHL", gameStatus: null }, at(30)), false);
    const win = autoGenerateWindow("NHL", [START], at(30));
    check("window passes the flag through", [win(START, { gameStatus: null, liveState: null, stateUnavailable: true }), win(START, { gameStatus: null, liveState: null })], [true, false]);
  }

  // ---- the boards: one read per league, in parallel; UNAVAILABLE has no states ----
  {
    const calls = { cached: 0, uncached: 0 };
    const boards = [
      { key: "icehockey_nhl", board: { odds: [boardGame] } },
      { key: "basketball_nba", board: { odds: [] as OddsGame[] } },
      { key: "icehockey_nhl", board: { odds: [boardGame] } },
    ];
    const feeds = await freshLiveFeedsForBoards(boards, NOW, deps(async () => [row("live", ago(5_000), 2, "4:00")], never, calls));
    check("one read per league, not per board", [Array.from(feeds.keys()).sort(), calls.cached], [["basketball_nba", "icehockey_nhl"], 2]);
    const states = liveStatesFromFeeds(boards, feeds);
    check("state from the fresh read", [states.get("odds-cbj-njd")?.period, states.get("odds-cbj-njd")?.clock], [2, "4:00"]);
    const none = liveStatesFromFeeds(boards, new Map([["icehockey_nhl", { kind: "UNAVAILABLE" as const }]]));
    check("UNAVAILABLE league: no state at all", none.size, 0);
  }

  // ---- fetchedAt stays server-side ----
  check("toClientScores strips fetchedAt", "fetchedAt" in toClientScores([row("live", NOW.toISOString(), 1, "1:00")])[0], false);

  if (failures) {
    console.log(failures + " failure(s)");
    process.exit(1);
  }
  console.log("All fresh-live-scores checks passed");
  process.exit(0);
}
main();
