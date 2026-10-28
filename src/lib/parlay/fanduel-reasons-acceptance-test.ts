// Proof for fanduel-reasons.ts: every leg Send to FanDuel leaves out says which
// kind of problem it is and the detail that makes it fixable. Pure: no DB, no
// network. The player-prop scenarios run on the FanDuel response captured live
// on 2026-10-27 (Trail Blazers @ Lakers, __fixtures__/).
// Run with:
//   npx tsx src/lib/parlay/fanduel-reasons-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { buildFanDuelLink, type FanDuelDeps, type FanDuelEvent, type FanDuelLegInput, type FanDuelMarket } from "@/lib/parlay/fanduel-link";
import {
  gameNotOnFanDuel,
  gameTimeMismatch,
  marketLabel,
  marketNotOffered,
  marketNotSupported,
  playerNotMatched,
  playersAmbiguous,
  propMarketLabel,
  twoGamesFound,
} from "@/lib/parlay/fanduel-reasons";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---- 1. The sentences ----
check("game not on FanDuel names the teams", gameNotOnFanDuel("Los Angeles Kings", "Chicago Blackhawks"), "Game not on FanDuel — couldn't find Los Angeles Kings @ Chicago Blackhawks.");
check("game time mismatch names both times", gameTimeMismatch("7:11 PM ET", "7:00 PM ET"), "Game time mismatch — FanDuel has this game at 7:11 PM ET; your pick is at 7:00 PM ET.");
check("two games found lists both starts", twoGamesFound(["1:05 PM ET", "4:35 PM ET"]), "Two games found — couldn't tell which (1:05 PM ET and 4:35 PM ET).");
check("two games found with no times still reads", twoGamesFound([]), "Two games found — couldn't tell which.");
check("market not offered", marketNotOffered("no blocks market for this game right now"), "Market not offered by FanDuel — no blocks market for this game right now.");
check("player not matched names the player and the market", playerNotMatched("Nobody Special", "points"), 'Player not matched — no "Nobody Special" with points on FanDuel for this game.');
check(
  "players ambiguous lists up to three",
  playersAmbiguous("Williams", ["Ziaire Williams", "Robert Williams", "Mark Williams", "Jalen Williams"]),
  'Player not matched — more than one player on FanDuel fits "Williams": Ziaire Williams, Robert Williams, Mark Williams.'
);
check("market not supported names the league", marketNotSupported("NFL", "pass attempts props"), "Market not supported for NFL yet — pass attempts props.");

// ---- 2. Markets and stats in words ----
check(
  "market keys in words",
  ["h2h", "h2h_3_way", "spreads", "alternate_spreads", "totals_p1", "team_totals_h1", "h2h_1st_5_innings", "player_points_rebounds_assists", "player_rush_reception_yds", "player_goal_scorer_anytime", "player_made_up_stat"].map(marketLabel),
  ["moneyline", "3-way moneyline", "spread", "spread", "total (1st period)", "team total (1st half)", "moneyline (first 5 innings)", "points + rebounds + assists", "rushing + receiving yards", "anytime goal", "made up stat"]
);
check("stored prop markets in words", ["PASS_ATTEMPTS", "RUSH_ATTEMPTS", "PASS_INTERCEPTIONS", "RUSH_REC_YDS", "SHOTS_ON_GOAL", "POINTS_REBOUNDS_ASSISTS"].map(propMarketLabel), [
  "pass attempts",
  "rush attempts",
  "pass interceptions",
  "rush rec yards",
  "shots on goal",
  "points rebounds assists",
]);

// ---- 3. Each reason, from the real code path ----
const nba = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "fanduel-event-nba-player-props-2026-10-27.json"), "utf8"));
const NOW = new Date("2026-10-27T20:00:00Z"); // 3 h 10 min before the game
const GAME = nba.commence_time as string;
const at = (offsetMin: number) => new Date(new Date(GAME).getTime() + offsetMin * 60 * 1000).toISOString();
const ev = (id: string, commenceTime: string): FanDuelEvent => ({ id, sportKey: "basketball_nba", homeTeam: nba.home_team, awayTeam: nba.away_team, commenceTime });
const leg = (over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
  pickId: "p",
  sportKey: "basketball_nba",
  leagueName: "NBA",
  betType: "PLAYER_PROP",
  period: "FULL_GAME",
  betDetail: null,
  line: null,
  homeTeam: nba.home_team,
  awayTeam: nba.away_team,
  gameTime: GAME,
  odds: -110,
  onBoard: true,
  ...over,
});
const FIXTURE_MARKETS: FanDuelMarket[] = nba.bookmakers[0].markets;

async function run(legs: FanDuelLegInput[], events: FanDuelEvent[] = [ev("evt", GAME)], markets: FanDuelMarket[] = FIXTURE_MARKETS) {
  const deps: FanDuelDeps = { now: NOW, getEvents: async () => events, getEventMarkets: async (_s, _e, keys) => markets.filter((m) => keys.includes(m.key)) };
  const built = await buildFanDuelLink(legs, deps);
  return built.legs.map((l) => [l.pickId, l.status, l.reason]);
}
const ALL: string[] = [];
const one = async (...args: Parameters<typeof run>) => {
  const rows = await run(...args);
  rows.forEach((r) => typeof r[2] === "string" && ALL.push(r[2]));
  return rows;
};

async function main() {
  check("no event for the teams: Game not on FanDuel", await one([leg({ pickId: "a", betDetail: "Austin Reaves over 23.5 points" })], []), [
    ["a", "not_found", "Game not on FanDuel — couldn't find Portland Trail Blazers @ Los Angeles Lakers."],
  ]);
  check("the right teams at another time: Game time mismatch", await one([leg({ pickId: "b", betDetail: "Austin Reaves over 23.5 points" })], [ev("evt", at(-130))]), [
    ["b", "not_found", "Game time mismatch — FanDuel has this game at 9:00 PM ET; your pick is at 11:10 PM ET."],
  ]);
  check("a doubleheader: Two games found", await one([leg({ pickId: "c", betDetail: "Austin Reaves over 23.5 points" })], [ev("e1", at(0)), ev("e2", at(60))]), [
    ["c", "ambiguous", "Two games found — couldn't tell which (11:10 PM ET and Oct 28, 12:10 AM ET)."],
  ]);

  const noBlocks = FIXTURE_MARKETS.filter((m) => m.key !== "player_blocks");
  check("FanDuel has the game but not the market: Market not offered", await one([leg({ pickId: "d", betDetail: "Donovan Clingan over 1.5 blocks" })], undefined, noBlocks), [
    ["d", "not_found", "Market not offered by FanDuel — no blocks market for this game right now."],
  ]);
  check("a player with no line in a market another leg asked for: Market not offered, with the player", await one(
    [leg({ pickId: "e", betDetail: "Austin Reaves over 0.5 blocks" }), leg({ pickId: "e2", betDetail: "Austin Reaves over 23.5 points" })]
  ), [
    ["e", "not_found", "Market not offered by FanDuel — FanDuel has no blocks line for Austin Reaves."],
    ["e2", "matched", null],
  ]);
  check("nobody by that name: Player not matched", await one([leg({ pickId: "f", betDetail: "Nobody Special over 10.5 points" })]), [
    ["f", "not_found", 'Player not matched — no "Nobody Special" with points on FanDuel for this game.'],
  ]);
  check("a surname two players share: Player not matched", await one([leg({ pickId: "g", betDetail: "Williams over 9.5 points" })]), [
    ["g", "ambiguous", 'Player not matched — more than one player on FanDuel fits "Williams": Ziaire Williams, Robert Williams.'],
  ]);

  const unsupported = await one([
    leg({ pickId: "h", leagueName: "NHL", sportKey: "icehockey_nhl", betDetail: "Tage Thompson over 1.5 points" }),
    leg({ pickId: "i", leagueName: "NFL", sportKey: "americanfootball_nfl", betDetail: "Josh Allen over 33.5 pass attempts" }),
    leg({ pickId: "j", betDetail: "Austin Reaves over 23.5 points", period: "FIRST_HALF" }),
    leg({ pickId: "k", betDetail: "Nikola Jokic double double" }),
    leg({ pickId: "m", betDetail: "Some capper note" }),
  ]);
  check("a stat this app doesn't send for the league: Market not supported", unsupported.map((r) => [r[0], r[2]]), [
    ["h", "Market not supported for NHL yet — points props."],
    ["i", "Market not supported for NFL yet — pass attempts props."],
    ["j", "Market not supported for NBA yet — only full-game player props."],
    ["k", "Market not supported for NBA yet — double double props."],
    ["m", "Couldn't read this player prop: \"Some capper note\"."],
  ]);

  const periodNotSold = await one([leg({ pickId: "l", sportKey: "icehockey_nhl", leagueName: "NHL", betType: "MONEYLINE", betDetail: "Kings ML", period: "FIRST_HALF" })]);
  check("a period FanDuel doesn't sell: Market not offered", periodNotSold.map((r) => r[2]), ["Market not offered by FanDuel — no first half bets for NHL."]);

  // ---- 4. Nothing generic is left, and every reason opens with its kind ----
  const KINDS = ["Game not on FanDuel", "Game time mismatch", "Two games found", "Market not offered by FanDuel", "Player not matched", "Market not supported for", "Couldn't read this player prop"];
  check("every reason above opens with one of the kinds", ALL.filter((r) => !KINDS.some((k) => r.startsWith(k))), []);
  const GENERIC = ["Couldn't find this game on FanDuel.", "FanDuel isn't offering this market right now.", "FanDuel isn't offering this selection right now.", "This player prop market can't be sent yet.", "This bet type can't be sent yet.", "More than one game fits this pick."];
  check("none of the old generic sentences is produced", ALL.filter((r) => GENERIC.includes(r)), []);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main();
