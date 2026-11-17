// Slate Bar counts (buildSlateCounts / slateTotals / orderSlateLeagues) and the Live tab's
// ?status= filter (orderBoardGames' `status`). Pure: no DB, no network.
import { buildSlateCounts, orderSlateLeagues, slateTotals, SLATE_LEAGUES } from "@/lib/slate-counts";
import { orderBoardGames, parseBoardStatusFilter } from "@/components/live/live-scoreboard-ordering";
import { resolveInitialScope } from "@/lib/live-list-scope";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " " + JSON.stringify(detail)));
  if (!ok) failed++;
}

// Noon Eastern on 2026-11-17 (EST, UTC-5).
const now = new Date("2026-11-17T17:00:00Z");
const at = (iso: string) => iso;
const feeds = [
  {
    sportKey: "basketball_nba",
    inSeason: true,
    failed: false,
    games: [
      { status: "live", commenceTime: at("2026-11-17T15:00:00Z") },
      { status: "preview", commenceTime: at("2026-11-17T23:00:00Z") },
      { status: "preview", commenceTime: at("2026-11-18T00:30:00Z") }, // 7:30pm ET still today
      { status: "final", commenceTime: at("2026-11-16T23:00:00Z") }, // yesterday
      { status: "postponed", commenceTime: at("2026-11-17T23:00:00Z") }, // never counted
      { status: "preview", commenceTime: at("2026-11-18T23:00:00Z") }, // tomorrow
      { status: "preview", commenceTime: at("2026-11-25T23:00:00Z") }, // outside the 3 days
    ],
  },
  { sportKey: "icehockey_nhl", inSeason: true, failed: false, games: [{ status: "live", commenceTime: at("2026-11-17T02:00:00Z") }] }, // started 9pm ET yesterday, still live
  { sportKey: "baseball_mlb", inSeason: false, failed: false, games: [] },
  { sportKey: "americanfootball_nfl", inSeason: true, failed: false, games: [] },
  { sportKey: "basketball_wnba", inSeason: false, failed: true, games: [] },
  { sportKey: "basketball_ncaab", inSeason: true, failed: false, games: [{ status: "preview", commenceTime: at("2026-11-17T23:00:00Z") }] },
  { sportKey: "americanfootball_ncaaf", inSeason: true, failed: false, games: [] },
];
const counts = buildSlateCounts(feeds, now);
const nba = counts.leagues.find((l) => l.sportKey === "basketball_nba")!;
check("NBA today: 3 games (postponed excluded), 1 live, 2 pending", nba.days.today.games === 3 && nba.days.today.live === 1 && nba.days.today.pending === 2, nba.days.today);
check("NBA yesterday: 1 final game", nba.days.yesterday.games === 1 && nba.days.yesterday.live === 0 && nba.days.yesterday.pending === 0, nba.days.yesterday);
check("NBA tomorrow: 1 pending; a game 8 days out is in no day", nba.days.tomorrow.games === 1 && nba.days.tomorrow.pending === 1, nba.days.tomorrow);
const nhl = counts.leagues.find((l) => l.sportKey === "icehockey_nhl")!;
check("a game live past midnight counts as live today, not yesterday", nhl.days.today.live === 1 && nhl.days.yesterday.games === 0, nhl.days);
check("out-of-season league with no games is offseason", counts.leagues.find((l) => l.sportKey === "baseball_mlb")!.offseason === true);
check("in-season league with no games is not offseason", counts.leagues.find((l) => l.sportKey === "americanfootball_nfl")!.offseason === false);
check("a failed feed is flagged and never offseason", counts.leagues.find((l) => l.sportKey === "basketball_wnba")!.failed === true && counts.leagues.find((l) => l.sportKey === "basketball_wnba")!.offseason === false);

const t = slateTotals(counts, "today");
check("today totals: 2 live, 3 pending (NBA 2 + NCAAB 1)", t.live === 2 && t.pending === 3, t);
check("live link lands on a league with the most live games (tie: first in feed order)", t.liveTop === "basketball_nba", t);
check("pending link lands on NBA (2 > NCAAB 1)", t.pendingTop === "basketball_nba", t);
check("no live games tomorrow: no top league", slateTotals(counts, "tomorrow").liveTop === null);

const order = orderSlateLeagues(counts, "today").map((l) => l.sportKey);
check("leagues with games first, in chip order", order.slice(0, 3).join() === "basketball_nba,icehockey_nhl,basketball_ncaab", order);
check("then the rest in chip order", order.slice(3).join() === ["americanfootball_nfl", "americanfootball_ncaaf", "baseball_mlb", "basketball_wnba"].join(), order);
check("every league has a logo URL on ESPN's CDN", SLATE_LEAGUES.every((l) => l.logo.startsWith("https://a.espncdn.com/")));
check("chip order is NBA NFL NHL NCAAB NCAAF MLB WNBA", SLATE_LEAGUES.map((l) => l.label).join() === "NBA,NFL,NHL,NCAAB,NCAAF,MLB,WNBA");

// A weekly scoreboard (ESPN returns the whole week for NFL and NCAAF): only the selected day's games count.
// "Now" is Tuesday 2026-11-17 noon ET. Games on Sun 15th .. Sun 22nd, none on the 17th itself for NFL.
const weekly = (sportKey: string, days: { iso: string; status: string; n: number }[]) => ({
  sportKey,
  inSeason: true,
  failed: false,
  games: days.flatMap((d) => Array.from({ length: d.n }, () => ({ status: d.status, commenceTime: d.iso }))),
});
const week = buildSlateCounts(
  [
    weekly("americanfootball_nfl", [
      { iso: "2026-11-15T18:00:00Z", status: "final", n: 13 }, // Sunday (2 days back)
      { iso: "2026-11-17T01:15:00Z", status: "final", n: 1 }, // Mon 8:15pm ET = yesterday
      { iso: "2026-11-20T01:15:00Z", status: "preview", n: 1 }, // Thu 8:15pm ET (Nov 19: the day after tomorrow)
      { iso: "2026-11-22T18:00:00Z", status: "preview", n: 13 }, // next Sunday
    ]),
    weekly("americanfootball_ncaaf", [
      { iso: "2026-11-14T17:00:00Z", status: "final", n: 40 }, // last Saturday
      { iso: "2026-11-18T01:00:00Z", status: "preview", n: 2 }, // Tue 8pm ET = today
      { iso: "2026-11-19T01:00:00Z", status: "preview", n: 3 }, // Wed 8pm ET = tomorrow
      { iso: "2026-11-21T17:00:00Z", status: "preview", n: 50 }, // Saturday
    ]),
  ],
  now
);
const wk = (key: string) => week.leagues.find((l) => l.sportKey === key)!;
check("weekly NFL: today has 0 games (no game on the 17th)", wk("americanfootball_nfl").days.today.games === 0, wk("americanfootball_nfl").days);
check("weekly NFL: yesterday counts only the Monday-night game, not Sunday's 13", wk("americanfootball_nfl").days.yesterday.games === 1, wk("americanfootball_nfl").days);
check("weekly NFL: tomorrow has 0 games (the Thursday game is 2 days out)", wk("americanfootball_nfl").days.tomorrow.games === 0, wk("americanfootball_nfl").days);
check("weekly NCAAF: today 2, tomorrow 3, yesterday 0 (Saturdays never leak in)", (() => { const d = wk("americanfootball_ncaaf").days; return d.today.games === 2 && d.tomorrow.games === 3 && d.yesterday.games === 0; })(), wk("americanfootball_ncaaf").days);
check("weekly leagues: totals use the selected day only", slateTotals(week, "today").pending === 2 && slateTotals(week, "tomorrow").pending === 3, [slateTotals(week, "today"), slateTotals(week, "tomorrow")]);
check("weekly NFL with no game today is ordered after leagues that have games today", orderSlateLeagues(week, "today").map((l) => l.sportKey).join() === "americanfootball_ncaaf,americanfootball_nfl", orderSlateLeagues(week, "today").map((l) => l.sportKey));

// ?status= filter on the Live board.
check("status param parsing", parseBoardStatusFilter("live") === "live" && parseBoardStatusFilter("pending") === "pending" && parseBoardStatusFilter("x") === null && parseBoardStatusFilter(undefined) === null);
const todayKey = "2026-11-17";
// Only the fields orderBoardGames reads; cast to its input type.
const g = (id: string, iso: string, status?: string) =>
  ({ game: { id, commenceTime: iso }, score: status ? { status } : undefined }) as unknown as Parameters<typeof orderBoardGames>[0][number];
const board = [g("a", "2026-11-17T15:00:00Z", "live"), g("b", "2026-11-17T23:00:00Z", "preview"), g("c", "2026-11-17T23:30:00Z"), g("d", "2026-11-19T23:00:00Z", "preview")];
const ids = (xs: unknown[]) => (xs as { game: { id: string } }[]).map((x) => x.game.id).join();
check("live filter keeps only live games", ids(orderBoardGames(board, todayKey, now, { status: "live" })) === "a");
check("pending filter keeps not-started games, unmatched included", ids(orderBoardGames(board, todayKey, now, { status: "pending" })) === "b,c,d");
check("pending + today-only drops later days", ids(orderBoardGames(board, todayKey, now, { todayOnly: true, status: "pending" })) === "b,c");
check("a filter with no match is empty (no fallback to the full board)", orderBoardGames([g("x", "2026-11-17T23:00:00Z", "preview")], todayKey, now, { status: "live" }).length === 0);
check("no filter: unchanged", ids(orderBoardGames(board, todayKey, now)) === "a,b,c,d");
check("initial scope respects the status filter", resolveInitialScope(board as never[], todayKey, null, now, "live").gameIds.join() === "a");

if (failed > 0) {
  console.log(failed + " check(s) failed");
  process.exit(1);
}
console.log("all slate checks passed");
