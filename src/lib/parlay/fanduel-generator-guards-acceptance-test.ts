// Proof for the Send to FanDuel guards (PR B2): FanDuel's price must be believable for the pick, the
// line may only move by a sport- and market-scaled amount, and a leg that is blocked says so in its own
// status - never as a "worse line". Pure: no DB, no network. The hockey scenarios run on the FanDuel
// response captured live on 2026-10-13 (__fixtures__/fanduel-event-nhl.json), whose full-game
// alternate-total ladder starts at Over 2.5 = -6000 - the price the production incident sent.
// Run with:
//   npx tsx src/lib/parlay/fanduel-generator-guards-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import {
  MAX_IMPLIED_PROB_GAP,
  MAX_LINE_MOVE_LOW_SCORING,
  MAX_LINE_MOVE_POINTS,
  MAX_LINE_MOVE_PUCK_RUN_LINE,
  NO_ODDS_MIN_FANDUEL_PRICE,
  PRICE_MOVED_WARN_GAP,
  buildFanDuelLink,
  checkPrice,
  impliedProbability,
  lineMoveCap,
  notSentDisplay,
  type FanDuelDeps,
  type FanDuelLegInput,
  type FanDuelLegResult,
  type FanDuelMarket,
} from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

type Capture = { id: string; sport_key: string; commence_time: string; home_team: string; away_team: string; bookmakers: { key: string; markets: FanDuelMarket[] }[] };
const NHL: Capture = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "fanduel-event-nhl.json"), "utf8"));
const NOW = new Date("2026-10-13T20:00:00Z");
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;

// One event, its markets as given; legs find it by teams + time.
async function run(sportKey: string, home: string, away: string, markets: FanDuelMarket[], legs: FanDuelLegInput[], commence = NHL.commence_time) {
  const deps: FanDuelDeps = {
    now: NOW,
    getEvents: async (k) => (k === sportKey ? [{ id: "evt", sportKey, homeTeam: home, awayTeam: away, commenceTime: commence }] : []),
    getEventMarkets: async (_s, _e, keys) => markets.filter((m) => keys.includes(m.key)),
  };
  const built = await buildFanDuelLink(legs, deps);
  return Object.assign(built, { by: Object.fromEntries(built.legs.map((l) => [l.pickId, l])) as Record<string, FanDuelLegResult> });
}
const nhlLeg = (pickId: string, over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
  pickId,
  sportKey: "icehockey_nhl",
  leagueName: "NHL",
  betType: "TOTAL",
  period: "FULL_GAME",
  betDetail: pickId,
  line: null,
  homeTeam: NHL.home_team,
  awayTeam: NHL.away_team,
  gameTime: NHL.commence_time,
  odds: -110,
  oddsSource: "STATED",
  onBoard: true,
  ...over,
});
const nhlMarkets = NHL.bookmakers[0].markets;
const row = (r: FanDuelLegResult) => [r.status, r.fanDuelOdds, r.sentLine, r.reason];

// A small synthetic totals / spreads board for the college games (the real captures have none for NCAAB).
function totalsBoard(point: number, overPrice = -110, underPrice = -110): FanDuelMarket[] {
  return [
    {
      key: "totals",
      sid: null,
      outcomes: [
        { name: "Over", price: overPrice, point, sid: "9001", link: link("44.1", "9001") },
        { name: "Under", price: underPrice, point, sid: "9002", link: link("44.1", "9002") },
      ],
    },
  ];
}
const collegeLeg = (pickId: string, league: "NCAAB" | "NCAAF", over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
  pickId,
  sportKey: league === "NCAAB" ? "basketball_ncaab" : "americanfootball_ncaaf",
  leagueName: league,
  betType: "TOTAL",
  period: "FULL_GAME",
  betDetail: pickId,
  line: null,
  homeTeam: "Home Team",
  awayTeam: "Away Team",
  gameTime: NHL.commence_time,
  odds: -110,
  oddsSource: "STATED",
  onBoard: true,
  ...over,
});

async function main() {
  // ---- 1. The price math and the constants ----
  check("implied probability: -110, +100, -6000, +150", [-110, 100, -6000, 150].map((o) => Math.round(impliedProbability(o) * 1000) / 1000), [0.524, 0.5, 0.984, 0.4]);
  check("the named constants", [MAX_IMPLIED_PROB_GAP, PRICE_MOVED_WARN_GAP, NO_ODDS_MIN_FANDUEL_PRICE, MAX_LINE_MOVE_POINTS, MAX_LINE_MOVE_LOW_SCORING, MAX_LINE_MOVE_PUCK_RUN_LINE], [0.25, 0.15, -1000, 1.5, 0.5, 0]);
  check(
    "line-move caps: basketball/football 1.5; NHL/MLB full-game totals and every period total 0.5; puck/run line 0",
    [
      lineMoveCap("americanfootball_nfl", "totals", ""),
      lineMoveCap("americanfootball_nfl", "spreads", ""),
      lineMoveCap("americanfootball_nfl", "totals", "_h1"),
      lineMoveCap("americanfootball_nfl", "spreads", "_h1"),
      lineMoveCap("basketball_nba", "totals", "_q1"),
      lineMoveCap("basketball_ncaab", "totals", ""),
      lineMoveCap("icehockey_nhl", "totals", ""),
      lineMoveCap("icehockey_nhl", "totals", "_p1"),
      lineMoveCap("icehockey_nhl", "team_totals", ""),
      lineMoveCap("icehockey_nhl", "spreads", ""),
      lineMoveCap("baseball_mlb", "totals", ""),
      lineMoveCap("baseball_mlb", "totals", "_1st_5_innings"),
      lineMoveCap("baseball_mlb", "spreads", ""),
    ],
    [1.5, 1.5, 0.5, 1.5, 0.5, 1.5, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0]
  );

  // ---- 2. checkPrice ----
  const target = { marketKey: "totals", outcome: { name: "Over" as const }, point: 1.5 };
  const probe = (odds: number, fd: number, oddsSource: FanDuelLegInput["oddsSource"] = "STATED", betType = "TOTAL") =>
    checkPrice(nhlLeg("x", { odds, oddsSource, betType }), target, fd, 1.5);
  check("-110 vs -6000 is blocked", probe(-110, -6000).blocked !== null, true);
  check("-110 vs -400 (gap 0.276) is blocked", probe(-110, -400).blocked !== null, true);
  check("-110 vs -250 (gap 0.19) is sent with a warning", [probe(-110, -250).blocked, probe(-110, -250).warning], [null, "Price moved a lot — your pick was -110, FanDuel has -250."]);
  check("-110 vs -130 (gap 0.03) is silent", probe(-110, -130), { blocked: null, warning: null });
  check("a pick at +150 against FanDuel +140 is silent", probe(150, 140), { blocked: null, warning: null });
  check("no-odds pick (DEFAULTED) at -6000 is blocked", probe(-110, -6000, "DEFAULTED").blocked !== null, true);
  check("no-odds pick at -1000 is blocked (the bar is inclusive)", probe(-110, -1000, "DEFAULTED").blocked !== null, true);
  check("no-odds pick at -999 goes", probe(-110, -999, "DEFAULTED"), { blocked: null, warning: null });
  check("a DEFAULTED -110 is never compared as if it were a price: -110 vs -250 is silent", probe(-110, -250, "DEFAULTED"), { blocked: null, warning: null });
  check("no-odds moneyline at -1500 goes (only spread / total / team total are gated)", probe(-110, -1500, "DEFAULTED", "MONEYLINE"), { blocked: null, warning: null });
  check("the blocked sentence says what and why", probe(-110, -6000).blocked, "Potentially incorrect market match — FanDuel's total Over 1.5 is -6000 but your pick is -110. Not sent: check the bet on FanDuel.");

  // ---- 3. The production incident: a FULL_GAME-stored "over 1.5" against the real ladder ----
  const inc = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [
    nhlLeg("Avalanche over 1.5 1P", { betDetail: "Avalanche over 1.5 1P", line: 1.5, odds: -110, oddsSource: "DEFAULTED" }),
  ]);
  check(
    "FULL_GAME over 1.5, ladder starts at Over 2.5 (-6000): Line unavailable, not sent, no sent-as line",
    [inc.by["Avalanche over 1.5 1P"].status, inc.by["Avalanche over 1.5 1P"].sentLine, inc.url],
    ["line_unavailable", null, null]
  );
  check("...and the reason is the cap, not 'Worse line'", inc.by["Avalanche over 1.5 1P"].reason, "Line unavailable — FanDuel's closest line is Over 2.5, more than 0.5 away from your pick.");
  const exact = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [
    nhlLeg("Over 2.5 stated", { betDetail: "Over 2.5", line: 2.5, odds: -110, oddsSource: "STATED" }),
    nhlLeg("Over 2.5 no odds", { betDetail: "Over 2.5", line: 2.5, odds: -110, oddsSource: "DEFAULTED" }),
  ]);
  check(
    "even on the pick's exact line, Over 2.5 at -6000 against a -110 pick is Potentially incorrect market match, not sent",
    [exact.by["Over 2.5 stated"].status, exact.by["Over 2.5 stated"].sentLine, exact.by["Over 2.5 stated"].fanDuelOdds, exact.url],
    ["price_mismatch", null, null, null]
  );
  check("...and so is a pick with no odds of its own", exact.by["Over 2.5 no odds"].status, "price_mismatch");
  check("a blocked leg shows the label, never 'Worse line'", [notSentDisplay(exact.by["Over 2.5 stated"]).label, /worse/i.test(JSON.stringify(exact.by["Over 2.5 stated"]))], ["Potentially incorrect market match", false]);
  const edge = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [nhlLeg("Over 3.5 no odds", { betDetail: "Over 3.5", line: 3.5, odds: -110, oddsSource: "DEFAULTED" })]);
  check("a no-odds Over 3.5 at the ladder's -950 is above the -1000 bar: sent", [edge.by["Over 3.5 no odds"].status, edge.by["Over 3.5 no odds"].fanDuelOdds], ["matched", -950]);

  // ---- 4. Hockey line moves ----
  const hockey = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [
    nhlLeg("Oilers under 6", { betDetail: "Oilers under 6", line: 6 }),
    nhlLeg("Over 6", { betDetail: "Over 6", line: 6 }),
    nhlLeg("Over 1.5 full game", { betDetail: "Over 1.5", line: 1.5 }),
    nhlLeg("Over 7", { betDetail: "Over 7", line: 7 }),
  ]);
  check("hockey total 6 -> 6.5 still sends (Under: the easier line)", row(hockey.by["Oilers under 6"]).slice(0, 3), ["adjusted", -140, { pick: 6, fanDuel: 6.5, side: "Under", worse: false }]);
  check("hockey Over 6 -> 5.5 still sends (the easier line)", row(hockey.by["Over 6"]).slice(0, 3), ["adjusted", -142, { pick: 6, fanDuel: 5.5, side: "Over", worse: false }]);
  check("hockey total 1.5 -> 2.5 is Line unavailable", [hockey.by["Over 1.5 full game"].status, hockey.by["Over 1.5 full game"].sentLine], ["line_unavailable", null]);
  check("hockey Over 7 -> 6.5 (the ladder's nearest, 0.5, easier) sends", row(hockey.by["Over 7"]).slice(0, 3), ["adjusted", 114, { pick: 7, fanDuel: 6.5, side: "Over", worse: false }]);

  // ---- 5. Puck line: exact or nothing ----
  const puck = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [
    nhlLeg("Red Wings -1.5", { betType: "SPREAD", betDetail: "Red Wings -1.5", line: -1.5, pickedSide: "HOME", odds: 220 }),
  ]);
  check("puck line -1.5 on the board: sent on the exact line", [puck.by["Red Wings -1.5"].status, puck.by["Red Wings -1.5"].fanDuelOdds], ["matched", 220]);
  const noMinus15 = nhlMarkets.map((m) => ({ ...m, outcomes: m.outcomes.filter((o) => !(o.name === "Detroit Red Wings" && o.point === -1.5)) }));
  const puck2 = await run("icehockey_nhl", NHL.home_team, NHL.away_team, noMinus15, [
    nhlLeg("Red Wings -1.5", { betType: "SPREAD", betDetail: "Red Wings -1.5", line: -1.5, pickedSide: "HOME", odds: 220 }),
  ]);
  check(
    "puck line -1.5 -> -2.5 (the ladder has -2.5): not sent, Line unavailable",
    [puck2.by["Red Wings -1.5"].status, puck2.by["Red Wings -1.5"].sentLine, puck2.url],
    ["line_unavailable", null, null]
  );
  check("...with the exact-line reason", puck2.by["Red Wings -1.5"].reason, "Line unavailable — FanDuel isn't offering this exact line right now.");

  // ---- 6. College lines: same-market moves with the right better/worse label ----
  const bc = await run("basketball_ncaab", "Home Team", "Away Team", totalsBoard(143.5), [
    collegeLeg("Boston College Under 144.5", "NCAAB", { betDetail: "Boston College Under 144.5", line: 144.5 }),
  ]);
  check("Boston College Under 144.5 -> 143.5: sent, WORSE (harder to win)", row(bc.by["Boston College Under 144.5"]).slice(0, 3), ["adjusted", -110, { pick: 144.5, fanDuel: 143.5, side: "Under", worse: true }]);
  const dx = await run("basketball_ncaab", "Home Team", "Away Team", totalsBoard(145.5), [collegeLeg("Drexel Under 144.5", "NCAAB", { betDetail: "Drexel Under 144.5", line: 144.5 })]);
  check("Drexel Under 144.5 -> 145.5: sent, better", row(dx.by["Drexel Under 144.5"]).slice(0, 3), ["adjusted", -110, { pick: 144.5, fanDuel: 145.5, side: "Under", worse: false }]);
  const oh = await run("americanfootball_ncaaf", "Home Team", "Away Team", totalsBoard(50.5), [collegeLeg("Ohio Over 51", "NCAAF", { betDetail: "Ohio Over 51", line: 51 })]);
  check("Ohio Over 51 -> 50.5: sent, better", row(oh.by["Ohio Over 51"]).slice(0, 3), ["adjusted", -110, { pick: 51, fanDuel: 50.5, side: "Over", worse: false }]);
  const far = await run("basketball_ncaab", "Home Team", "Away Team", totalsBoard(146.5), [collegeLeg("Under 144.5", "NCAAB", { betDetail: "Under 144.5", line: 144.5 })]);
  check("a college total 2 away is past the 1.5 cap: Line unavailable", far.by["Under 144.5"].status, "line_unavailable");

  // ---- 7. Price band on a sent leg, and a blocked leg that would also have been a line move ----
  const warn = await run("basketball_ncaab", "Home Team", "Away Team", totalsBoard(145.5, -250, 200), [collegeLeg("Over 145.5", "NCAAB", { betDetail: "Over 145.5", line: 145.5, odds: -110 })]);
  check("pick -110, FanDuel -250: sent, with the warning on the leg", [warn.by["Over 145.5"].status, warn.by["Over 145.5"].warning], ["matched", "Price moved a lot — your pick was -110, FanDuel has -250."]);
  check("a leg without a warning carries null", (await run("basketball_ncaab", "Home Team", "Away Team", totalsBoard(145.5), [collegeLeg("Over 145.5", "NCAAB", { betDetail: "Over 145.5", line: 145.5 })])).by["Over 145.5"].warning, null);
  const both = await run("americanfootball_ncaaf", "Home Team", "Away Team", totalsBoard(50.5, -900), [collegeLeg("Ohio Over 51", "NCAAF", { betDetail: "Ohio Over 51", line: 51 })]);
  check(
    "a line move at an absurd price is blocked, not 'adjusted / Worse line'",
    [both.by["Ohio Over 51"].status, both.by["Ohio Over 51"].sentLine, both.by["Ohio Over 51"].fanDuelOdds, both.url],
    ["price_mismatch", null, null, null]
  );

  // ---- 8. A missing period market is Market unavailable, never the full game ----
  const noP1 = nhlMarkets.filter((m) => !/_p1$/.test(m.key));
  const p1 = await run("icehockey_nhl", NHL.home_team, NHL.away_team, noP1, [
    nhlLeg("Penguins over 1.5 1P", { betDetail: "Penguins over 1.5 first period", line: 1.5, period: "FIRST_PERIOD" }),
  ]);
  check(
    "1P Over 1.5 with no first-period market: Market unavailable, not sent (the full-game ladder is never looked at)",
    [p1.by["Penguins over 1.5 1P"].status, p1.url],
    ["market_unavailable", null]
  );
  const withP1 = await run("icehockey_nhl", NHL.home_team, NHL.away_team, nhlMarkets, [
    nhlLeg("1P over 1.5", { betDetail: "Penguins over 1.5 first period", line: 1.5, period: "FIRST_PERIOD" }),
    nhlLeg("FG over 1.5", { betDetail: "Penguins over 1.5", line: 1.5 }),
  ]);
  check("a first-period Over 1.5 is a different bet from the full-game Over 1.5", [withP1.by["1P over 1.5"].status, withP1.by["1P over 1.5"].fanDuelOdds, withP1.by["FG over 1.5"].status], ["matched", -122, "line_unavailable"]);

  // ---- 8b. Live legs: the price gap only warns; the line caps still apply ----
  const LIVE_AT = "2026-10-13T19:30:00Z"; // 30 min before NOW
  const SOON_AT = "2026-10-13T23:00:00Z"; // not started
  const liveRun = (gameTime: string, over: Partial<FanDuelLegInput>, board: FanDuelMarket[]) =>
    run("icehockey_nhl", NHL.home_team, NHL.away_team, board, [nhlLeg("t", { gameTime, betDetail: "Over 6.5", line: 6.5, ...over })], gameTime).then((r) => r.by.t);
  const wide = totalsBoard(6.5, -400, 300);
  const liveWide = await liveRun(LIVE_AT, { odds: 150 }, wide);
  check("LIVE leg, +150 pick vs -400 (gap far past 0.25): sent with the Price-moved warning", [liveWide.status, liveWide.warning], ["matched", "Price moved a lot — your pick was +150, FanDuel has -400."]);
  const preWide = await liveRun(SOON_AT, { odds: 150 }, wide);
  check("NON-live leg with the same +150 vs -400 gap: Potentially incorrect market match, not sent", [preWide.status, preWide.warning, preWide.sentLine], ["price_mismatch", null, null]);
  const liveNoOdds = await liveRun(LIVE_AT, { odds: -110, oddsSource: "DEFAULTED" }, totalsBoard(6.5, -1500, 700));
  check("LIVE no-real-price leg at -1500 (past the -1000 floor): sent with a warning", [liveNoOdds.status, liveNoOdds.warning], ["matched", "Price moved a lot — your pick has no stated price, FanDuel has -1500."]);
  const preNoOdds = await liveRun(SOON_AT, { odds: -110, oddsSource: "DEFAULTED" }, totalsBoard(6.5, -1500, 700));
  check("NON-live no-real-price leg at -1500: blocked", preNoOdds.status, "price_mismatch");
  const liveCap = await liveRun(LIVE_AT, { odds: -110, line: 6, betDetail: "Over 6" }, totalsBoard(7.5, -110, -110));
  check("LIVE leg still obeys the line cap: hockey total 6 -> 7.5 is Line unavailable", [liveCap.status, liveCap.sentLine], ["line_unavailable", null]);
  const liveAdj = await liveRun(LIVE_AT, { odds: -110, line: 6, betDetail: "Over 6" }, totalsBoard(6.5, -110, -110));
  check("LIVE leg inside the cap: hockey total 6 -> 6.5 sends adjusted", liveAdj.status, "adjusted");

  // ---- 8c. MLB / NHL team totals follow the 0.5 cap ----
  const teamTotalBoard: FanDuelMarket[] = [
    {
      key: "team_totals",
      sid: null,
      outcomes: [
        { name: "Over", description: "Colorado Rockies", price: -110, point: 2.5, sid: "9101", link: link("45.1", "9101") },
        { name: "Under", description: "Colorado Rockies", price: -110, point: 2.5, sid: "9102", link: link("45.1", "9102") },
      ],
    },
  ];
  const mlbTt = (betDetail: string, line: number) => ({
    pickId: "tt", sportKey: "baseball_mlb", leagueName: "MLB", betType: "TEAM_TOTAL", period: "FULL_GAME" as const, betDetail, line,
    homeTeam: "Colorado Rockies", awayTeam: "Arizona Diamondbacks", gameTime: SOON_AT, odds: -110, oddsSource: "STATED" as const, onBoard: true,
  });
  const tt = await run("baseball_mlb", "Colorado Rockies", "Arizona Diamondbacks", teamTotalBoard, [mlbTt("Colorado Rockies Team Total Over 1.5", 1.5)], SOON_AT);
  check("MLB Colorado team total Over 1.5 vs a ladder starting at 2.5: Line unavailable, not sent", [tt.by.tt.status, tt.by.tt.sentLine, tt.url], ["line_unavailable", null, null]);
  const ttOk = await run("baseball_mlb", "Colorado Rockies", "Arizona Diamondbacks", teamTotalBoard, [mlbTt("Colorado Rockies Team Total Over 2", 2)], SOON_AT);
  check("MLB Colorado team total Over 2 vs 2.5 (0.5 away) still sends", ttOk.by.tt.status, "adjusted");

  // ---- 9. Labels ----
  check(
    "labels for the new statuses",
    ["market_unavailable", "line_unavailable", "price_mismatch", "needs_clarification"].map((status) => notSentDisplay({ status, reason: "r" }).label),
    ["Market unavailable", "Line unavailable", "Potentially incorrect market match", "Needs clarification"]
  );

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}
main();
