// The 7-day schedule store, pure half (lib/schedule-store.ts) and the resolver
// wiring that reads it (odds.ts resolveScheduleGameFromFeeds /
// resolveTokenDayGameFromFeeds), against fixed inputs:
//   1. the window (today..today+6 ET) and season gating per date
//   2. ESPN / MLB responses -> compact stored games; a malformed body throws
//   3. feed_syncs outcome: success only when every planned date came back
//   4. stored -> schedule-only feed games (today+2 on, postponed dropped, preview)
//   5. catalog import: a team with no game in the score feed matches its stored
//      game 3 days out; ESPN-first still wins when the score feed has one; a
//      series' game 2 is not dropped as a copy of the odds feed's game 1
//   6. token day rule: "Thursday Celtics ML" sent on Tuesday matches Thursday's
//      stored game (2 days out), and still nothing when Thursday has no game
//
// No DB, no network. Run with:
//   npx tsx src/lib/schedule-store-acceptance-test.ts
import {
  dedupeById,
  espnEventsToStored,
  espnScheduleUrl,
  mlbScheduleToStored,
  mlbScheduleUrl,
  plannedScheduleDates,
  scheduleSyncOutcome,
  scheduleWindowKeys,
  storedToScheduleGames,
  type StoredScheduleGame,
} from "@/lib/schedule-store";
import { resolveScheduleGameFromFeeds, resolveTokenDayGameFromFeeds, type OddsGame, type ScoreGame } from "@/server/data/odds";
import { teamNameEndsWith } from "@/lib/team-name-match";
import { namedPickDay } from "@/lib/ingest-line-outcome";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}
function expectThrows(label: string, fn: () => unknown) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  expect(label, threw, true);
}

const NBA = "basketball_nba";
// Tuesday 2026-12-01, 15:00 ET.
const NOW = new Date("2026-12-01T20:00:00Z");

// 1. Window and season gating ----------------------------------------------------
expect("window: today..today+6 ET", scheduleWindowKeys(NOW), [
  "2026-12-01",
  "2026-12-02",
  "2026-12-03",
  "2026-12-04",
  "2026-12-05",
  "2026-12-06",
  "2026-12-07",
]);
expect("window: 02:00 UTC is still the previous ET day", scheduleWindowKeys(new Date("2026-12-02T02:00:00Z"))[0], "2026-12-01");
expect("NBA in season: all 7 dates planned", plannedScheduleDates(NBA, NOW).length, 7);
expect("WNBA off season: nothing planned", plannedScheduleDates("basketball_wnba", NOW), []);
expect("MLB off season: nothing planned", plannedScheduleDates("baseball_mlb", NOW), []);
// MLB's 2026 window opens 03-15: on 03-12 only 03-15..03-18 are planned.
expect("a season opening mid-window: only its in-season dates", plannedScheduleDates("baseball_mlb", new Date("2026-03-12T17:00:00Z")), [
  "2026-03-15",
  "2026-03-16",
  "2026-03-17",
  "2026-03-18",
]);
expect("unknown league: nothing planned (fails closed)", plannedScheduleDates("cricket_ipl", NOW), []);

expect(
  "ESPN url: YYYYMMDD date, group, no limit",
  espnScheduleUrl("basketball/mens-college-basketball", "2026-12-03", "50"),
  "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=20261203&groups=50"
);
expect("MLB url: one start-end range", mlbScheduleUrl("2026-06-01", "2026-06-07"), "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-06-01&endDate=2026-06-07");

// 2. Parsing -------------------------------------------------------------------------
const espnEvent = (id: string, home: string, away: string, date: string, type: object) => ({
  id,
  date,
  status: { type },
  competitions: [{ competitors: [{ homeAway: "home", team: { displayName: home } }, { homeAway: "away", team: { displayName: away } }] }],
});
const espnBody = {
  events: [
    espnEvent("401", "Boston Celtics", "Miami Heat", "2026-12-04T00:30Z", { state: "pre" }),
    espnEvent("402", "Denver Nuggets", "Utah Jazz", "2026-12-04T02:00Z", { state: "post", completed: false, name: "STATUS_POSTPONED" }),
    { id: "403", date: "2026-12-04T02:00Z", competitions: [{ competitors: [] }] },
  ],
};
expect("ESPN: two named games kept, a sideless event dropped", espnEventsToStored(espnBody, NOW), [
  { id: "401", home: "Boston Celtics", away: "Miami Heat", start: "2026-12-04T00:30Z", status: "preview" },
  { id: "402", home: "Denver Nuggets", away: "Utah Jazz", start: "2026-12-04T02:00Z", status: "postponed" },
]);
expect("ESPN: an empty slate is [] (a real answer, not a failure)", espnEventsToStored({ events: [] }, NOW), []);
expectThrows("ESPN: a body with no events array throws (recorded as a failed date)", () => espnEventsToStored({ error: "x" }, NOW));

const mlbGame = (pk: number, officialDate: string, extra: object = {}) => ({
  gamePk: pk,
  officialDate,
  gameDate: officialDate + "T23:05:00Z",
  status: { abstractGameState: "Preview", codedGameState: "S" },
  teams: { home: { team: { name: "New York Yankees" } }, away: { team: { name: "Boston Red Sox" } } },
  doubleHeader: "N",
  gameNumber: 1,
  ...extra,
});
const mlb = mlbScheduleToStored(
  {
    dates: [
      { date: "2026-06-01", games: [mlbGame(1, "2026-06-01")] },
      { date: "2026-06-02", games: [mlbGame(2, "2026-06-02", { doubleHeader: "S", gameNumber: 1 }), mlbGame(3, "2026-06-02", { doubleHeader: "S", gameNumber: 2 })] },
    ],
  },
  NOW
);
expect("MLB: grouped by officialDate", [...mlb.keys()], ["2026-06-01", "2026-06-02"]);
expect("MLB: a single game carries no doubleheader fields", mlb.get("2026-06-01")![0], {
  id: "1",
  home: "New York Yankees",
  away: "Boston Red Sox",
  start: "2026-06-01T23:05:00Z",
  status: "preview",
});
expect("MLB: doubleheader legs keep gameNumber + flag", mlb.get("2026-06-02")!.map((g) => [g.gameNumber, g.doubleHeader]), [
  [1, "S"],
  [2, "S"],
]);
expectThrows("MLB: a body with no dates array throws", () => mlbScheduleToStored({}, NOW));
expect(
  "dedupeById: an FBS-vs-FCS game in both groups is stored once",
  dedupeById([
    { id: "1", home: "a", away: "b", start: "x", status: "preview" },
    { id: "1", home: "a", away: "b", start: "x", status: "preview" },
  ]).length,
  1
);

// 3. feed_syncs outcome --------------------------------------------------------------
const pull = (planned: string[], failed: string[]) => ({
  sportKey: NBA,
  planned,
  days: new Map(planned.filter((d) => !failed.includes(d)).map((d) => [d, [] as StoredScheduleGame[]])),
  failed: failed.map((date) => ({ date, error: "ESPN: HTTP 503" })),
});
expect("every date back: success", scheduleSyncOutcome(pull(["2026-12-01", "2026-12-02"], [])), { sportKey: NBA, ok: true });
expect("one date failed: an error naming it (Feed health shows a sync error, not 'no games')", scheduleSyncOutcome(pull(["2026-12-01", "2026-12-02"], ["2026-12-02"])), {
  sportKey: NBA,
  ok: false,
  error: "schedule pull failed for 1 of 2 dates (2026-12-02): ESPN: HTTP 503",
});
expect("nothing planned (off season): nothing recorded", scheduleSyncOutcome(pull([], [])), null);

// 4. Stored -> feed games ------------------------------------------------------------
const stored = (id: string, home: string, away: string, start: string, status: StoredScheduleGame["status"] = "preview"): StoredScheduleGame => ({ id, home, away, start, status });
const rows = [
  { gameDate: "2026-12-01", games: [stored("t0", "Boston Celtics", "Miami Heat", "2026-12-02T00:30:00Z")] },
  { gameDate: "2026-12-02", games: [stored("t1", "Boston Celtics", "Orlando Magic", "2026-12-03T00:30:00Z")] },
  {
    gameDate: "2026-12-03",
    games: [
      stored("t2", "Boston Celtics", "New York Knicks", "2026-12-04T00:30:00Z", "live"),
      stored("t2p", "Denver Nuggets", "Utah Jazz", "2026-12-04T02:00:00Z", "postponed"),
    ],
  },
  { gameDate: "2026-12-05", games: [stored("t4", "Chicago Bulls", "Boston Celtics", "2026-12-06T01:00:00Z")] },
];
const feed = storedToScheduleGames(rows, NOW);
expect("feed games: only today+2 on (the score feed owns yesterday..tomorrow), postponed dropped", feed.map((g) => g.id), ["t2", "t4"]);
expect("feed games: a day-old stored status reads as preview", feed[0].status, "preview");

// 5. Catalog import (resolveScheduleGameFromFeeds) -------------------------------------
const team = (sportKey: string, nickname: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nickname, sportKey) || teamNameEndsWith(g.awayTeam, nickname, sportKey);
const score = (id: string, home: string, away: string, commenceTime: string, status: ScoreGame["status"]): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  status,
  scores: null,
  commenceTime,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
});
const odds = (id: string, home: string, away: string, commenceTime: string): OddsGame =>
  ({ id, sportKey: NBA, homeTeam: home, awayTeam: away, commenceTime, bookmakers: [] }) as unknown as OddsGame;
const bulls = team(NBA, "bulls");
const celtics = team(NBA, "celtics");

expect(
  "import: Bulls not in the score feed or odds -> their stored game 4 days out",
  resolveScheduleGameFromFeeds([], [], bulls, NOW, null, feed, { sportKey: NBA }).game?.id,
  "t4"
);
expect("import: before the store, the same pick matched nothing", resolveScheduleGameFromFeeds([], [], bulls, NOW, null, [], { sportKey: NBA }).game, null);
expect(
  "import: ESPN first - a score-feed game tomorrow wins over a stored one",
  resolveScheduleGameFromFeeds([score("s1", "Boston Celtics", "Orlando Magic", "2026-12-03T00:30:00Z", "preview")], [], celtics, NOW, null, feed, { sportKey: NBA }).game?.id,
  "s1"
);
// A series: the odds feed lists game 1 (Dec 4), the store has game 1 (its twin) and game 2 (Dec 5).
const series = [
  { id: "g1", homeTeam: "Boston Bruins", awayTeam: "Toronto Maple Leafs", commenceTime: "2026-12-04T00:00:00Z" },
  { id: "g2", homeTeam: "Boston Bruins", awayTeam: "Toronto Maple Leafs", commenceTime: "2026-12-05T00:00:00Z" },
].map((g) => score(g.id, g.homeTeam, g.awayTeam, g.commenceTime, "preview"));
const bruinsOdds = [odds("o1", "Boston Bruins", "Toronto Maple Leafs", "2026-12-04T00:05:00Z")];
const bruins = team("icehockey_nhl", "bruins");
const thu = resolveTokenDayGameFromFeeds([], bruinsOdds, bruins, NOW, null, { requestDay: "2026-12-01", namedDay: "2026-12-04" }, series, "icehockey_nhl");
expect("series: game 2 (Dec 5 UTC, Dec 4 ET evening) is kept, not dropped as game 1's twin", thu.game?.id, "g2");
const wed = resolveTokenDayGameFromFeeds([], bruinsOdds, bruins, NOW, null, { requestDay: "2026-12-01", namedDay: "2026-12-03" }, series, "icehockey_nhl");
expect("series: game 1 comes from the odds feed (its stored twin is not doubled)", wed.game?.id, "o1");

// 6. Token day rule: a named future day ----------------------------------------------
const requestDay = "2026-12-01"; // Tuesday
const namedDay = namedPickDay("Thursday Celtics ML", requestDay);
expect("'Thursday' sent on Tuesday names Thursday", namedDay, "2026-12-03");
const tokenThu = resolveTokenDayGameFromFeeds([], [], celtics, NOW, null, { requestDay, namedDay }, feed, NBA);
expect("token: 'Thursday Celtics ML' matches Thursday's stored game, 2 days out", tokenThu.game?.id, "t2");
expect("token: without the store it matched nothing", resolveTokenDayGameFromFeeds([], [], celtics, NOW, null, { requestDay, namedDay }, [], NBA).game, null);
const tokenSun = resolveTokenDayGameFromFeeds([], [], celtics, NOW, null, { requestDay, namedDay: "2026-12-06" }, feed, NBA);
expect("token: a named day with no stored Celtics game still matches nothing", tokenSun.game, null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
