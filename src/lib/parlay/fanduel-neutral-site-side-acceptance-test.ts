// Regression proof for the wrong-side FanDuel send (UAB vs Rhode Island, NCAAB, 2026-11-22, a neutral site:
// Colonial Hall at The Greenbrier). ESPN, which resolves a pick at import, listed it "Rhode Island @ UAB", so the
// pick row stored Rhode Island as AWAY (pickedSide AWAY). The board and FanDuel (the Odds API) listed it
// "UAB @ Rhode Island", so AWAY read on the board's game was UAB, and UAB's +110 went into the betslip.
//
// The side of a team bet is now a TEAM: the row's pickedSide is read against the row's own teams (sideTeams), then
// each FanDuel runner's name is resolved to a team (teamNamesMatch, sport-scoped). Exactly one runner may be the
// pick's team; otherwise the leg is "Couldn't confirm side on FanDuel" and never sent. Pure - the Odds API is the two
// functions in FanDuelDeps. Run with:
//   npx tsx src/lib/parlay/fanduel-neutral-site-side-acceptance-test.ts
import {
  buildFanDuelLink,
  fanDuelSelectionText,
  notSentDisplay,
  resolveRunnerTeam,
  type FanDuelDeps,
  type FanDuelEvent,
  type FanDuelLegInput,
  type FanDuelLinkResponse,
  type FanDuelMarket,
  type FanDuelOutcome,
} from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-11-22T20:00:00Z");
const START = "2026-11-23T00:40:00Z";
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;
const sentSelection = (r: FanDuelLinkResponse, i = 0) => (r.url ? new URL(r.url).searchParams.get(`selectionId[${i}]`) : null);

type Runner = { name: string; sid: string; price: number; point?: number; description?: string };
const market = (key: string, marketId: string, runners: Runner[]): FanDuelMarket => ({
  key,
  sid: null,
  outcomes: runners.map(
    (r): FanDuelOutcome => ({
      name: r.name,
      price: r.price,
      sid: r.sid,
      link: link(marketId, r.sid),
      ...(r.point === undefined ? {} : { point: r.point }),
      ...(r.description === undefined ? {} : { description: r.description }),
    })
  ),
});

function deps(events: FanDuelEvent[], markets: FanDuelMarket[], now: Date = NOW): FanDuelDeps & { marketCalls: string[][] } {
  const marketCalls: string[][] = [];
  return {
    now,
    marketCalls,
    getEvents: async (key) => events.filter((e) => e.sportKey === key),
    getEventMarkets: async (_key, _id, keys) => {
      marketCalls.push(keys);
      return markets.filter((m) => keys.includes(m.key));
    },
  };
}

const send = (legs: FanDuelLegInput[], events: FanDuelEvent[], markets: FanDuelMarket[], now?: Date) => buildFanDuelLink(legs, deps(events, markets, now));

// ---------------------------------------------------------------------
// 1. The exact case: UAB vs Rhode Island, neutral site, pick Rhode Island ML.
// ---------------------------------------------------------------------
const UAB = "UAB Blazers";
const URI = "Rhode Island Rams";
// The Odds API / FanDuel / our board: "UAB @ Rhode Island".
const oddsEvent: FanDuelEvent = { id: "ev-uri", sportKey: "basketball_ncaab", homeTeam: URI, awayTeam: UAB, commenceTime: START };
// FanDuel's moneyline, runners in its own order (UAB first). UAB +110 is the price the bad send carried.
const h2h = market("h2h", "734.1", [
  { name: UAB, sid: "901", price: 110 },
  { name: URI, sid: "902", price: -134 },
]);
const spreads = market("spreads", "734.2", [
  { name: UAB, sid: "911", price: -110, point: 2.5 },
  { name: URI, sid: "912", price: -110, point: -2.5 },
]);

const uriLeg = (over: Partial<FanDuelLegInput> = {}): FanDuelLegInput => ({
  pickId: "uri-ml",
  sportKey: "basketball_ncaab",
  leagueName: "NCAAB",
  betType: "MONEYLINE",
  period: "FULL_GAME",
  betDetail: "Rhode Island ML",
  // ESPN's listing at import: UAB home, Rhode Island away (neutralSite true) - so the row says AWAY.
  pickedSide: "AWAY",
  sideTeams: { homeTeam: UAB, awayTeam: URI },
  line: null,
  // The board's game: the Odds API's orientation.
  homeTeam: URI,
  awayTeam: UAB,
  gameTime: START,
  odds: -110,
  oddsSource: "DEFAULTED",
  onBoard: true,
  ...over,
});

async function main() {
  {
    const r = await send([uriLeg()], [oddsEvent], [h2h]);
    const leg = r.legs[0];
    check("neutral site, pick Rhode Island ML: sent", leg.status, "matched");
    check("...the Rhode Island runner's selection, never UAB's", sentSelection(r), "902");
    check("...at Rhode Island's price (-134), not UAB's +110", leg.fanDuelOdds, -134);
    check(
      "...the panel gets FanDuel's own runner and market",
      [leg.fanDuelSelection && fanDuelSelectionText(leg.fanDuelSelection), leg.sideCheck],
      ["Rhode Island Rams — Moneyline", { pickTeam: URI, runner: URI, ok: true }]
    );
  }

  // ---------------------------------------------------------------------
  // 2. Same matchup, home/away reversed between our Game row and FanDuel (and runners in the other order).
  // ---------------------------------------------------------------------
  {
    // The board listed it the way ESPN did (UAB home); FanDuel's event the other way round, Rhode Island's runner first.
    const reversedEvent: FanDuelEvent = { ...oddsEvent, homeTeam: URI, awayTeam: UAB };
    const reversedH2h = market("h2h", "734.1", [
      { name: URI, sid: "902", price: -134 },
      { name: UAB, sid: "901", price: 110 },
    ]);
    const r = await send([uriLeg({ homeTeam: UAB, awayTeam: URI })], [reversedEvent], [reversedH2h]);
    check("board UAB-home vs FanDuel Rhode-Island-home: still Rhode Island", [r.legs[0].status, sentSelection(r), r.legs[0].fanDuelOdds], ["matched", "902", -134]);

    // A row whose stored side has no sideTeams and sits on a game listed the other way: the event still matches.
    const r2 = await send([uriLeg({ homeTeam: UAB, awayTeam: URI, sideTeams: null })], [reversedEvent], [reversedH2h]);
    check("...side read on the board's own teams (AWAY = Rhode Island there): Rhode Island", sentSelection(r2), "902");

    // No stored side at all: the text names Rhode Island.
    const r3 = await send([uriLeg({ pickedSide: null, sideTeams: null })], [oddsEvent], [h2h]);
    check("...no stored side, text 'Rhode Island ML': Rhode Island", sentSelection(r3), "902");
  }

  // Spread at the neutral site: Rhode Island -2.5 is Rhode Island's runner at its own -2.5.
  {
    const r = await send([uriLeg({ pickId: "uri-sp", betType: "SPREAD", betDetail: "Rhode Island -2.5", line: -2.5, odds: -110, oddsSource: "STATED" })], [oddsEvent], [spreads]);
    check("neutral site, Rhode Island -2.5: Rhode Island's spread runner", [r.legs[0].status, sentSelection(r)], ["matched", "912"]);
    check("...shown as FanDuel lists it", r.legs[0].fanDuelSelection && fanDuelSelectionText(r.legs[0].fanDuelSelection), "Rhode Island Rams -2.5 — Spread");
  }

  // ---------------------------------------------------------------------
  // 3. Ordinary games: an away ML, a home and an away spread (team and sign).
  // ---------------------------------------------------------------------
  const BILLS = "Buffalo Bills";
  const RAMS = "Los Angeles Rams";
  const nflEvent: FanDuelEvent = { id: "ev-nfl", sportKey: "americanfootball_nfl", homeTeam: RAMS, awayTeam: BILLS, commenceTime: START };
  const nflMarkets = [
    market("h2h", "42.1", [
      { name: RAMS, sid: "101", price: -180 },
      { name: BILLS, sid: "102", price: 154 },
    ]),
    market("spreads", "42.2", [
      { name: BILLS, sid: "111", price: -115, point: 3.5 },
      { name: RAMS, sid: "112", price: -105, point: -3.5 },
    ]),
    market("h2h_h1", "42.3", [
      { name: BILLS, sid: "121", price: 140 },
      { name: RAMS, sid: "122", price: -165 },
    ]),
  ];
  const nflLeg = (over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
    pickId: "nfl",
    sportKey: "americanfootball_nfl",
    leagueName: "NFL",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: "Bills ML",
    pickedSide: null,
    line: null,
    homeTeam: RAMS,
    awayTeam: BILLS,
    gameTime: START,
    odds: 150,
    onBoard: true,
    ...over,
  });
  {
    const r = await send([nflLeg({ pickedSide: "AWAY" })], [nflEvent], nflMarkets);
    check("away-team ML (Bills): the Bills runner", [r.legs[0].status, sentSelection(r), r.legs[0].fanDuelOdds], ["matched", "102", 154]);
    const home = await send([nflLeg({ pickId: "h", betType: "SPREAD", betDetail: "Rams -3.5", line: -3.5, odds: -110 })], [nflEvent], nflMarkets);
    check("home spread Rams -3.5: Rams runner at -3.5", [home.legs[0].status, sentSelection(home), home.legs[0].fanDuelSelection?.line], ["matched", "112", -3.5]);
    const away = await send([nflLeg({ pickId: "a", betType: "SPREAD", betDetail: "Bills +3.5", line: 3.5, odds: -110 })], [nflEvent], nflMarkets);
    check("away spread Bills +3.5: Bills runner at +3.5", [away.legs[0].status, sentSelection(away), away.legs[0].fanDuelSelection?.line], ["matched", "111", 3.5]);
    const wrongSign = await send([nflLeg({ pickId: "w", betType: "SPREAD", betDetail: "Bills -3.5", line: -3.5, odds: -110 })], [nflEvent], [nflMarkets[1]]);
    // NFL spreads go at the nearest line (#439): Bills' own +3.5, flagged as moved - never the Rams' -3.5, whose number matches.
    check("Bills -3.5 when FanDuel has Bills +3.5: the Bills runner, never the Rams' -3.5", [sentSelection(wrongSign), wrongSign.legs[0].sentLine?.fanDuel], ["111", 3.5]);
  }

  // ---------------------------------------------------------------------
  // 4. Period winners: NFL 1st half, NBA 1st quarter.
  // ---------------------------------------------------------------------
  {
    const r = await send([nflLeg({ pickId: "h1", period: "FIRST_HALF", betDetail: "Bills 1H ML", pickedSide: "AWAY" })], [nflEvent], nflMarkets);
    check("NFL 1st-half winner, Bills: the Bills 1H runner", [r.legs[0].status, sentSelection(r)], ["matched", "121"]);
    check("...shown with its period", r.legs[0].fanDuelSelection && fanDuelSelectionText(r.legs[0].fanDuelSelection), "Buffalo Bills — Moneyline (1st half)");

    const LAKERS = "Los Angeles Lakers";
    const CELTICS = "Boston Celtics";
    const nba: FanDuelEvent = { id: "ev-nba", sportKey: "basketball_nba", homeTeam: LAKERS, awayTeam: CELTICS, commenceTime: START };
    const q1 = market("h2h_q1", "60.1", [
      { name: LAKERS, sid: "301", price: -120 },
      { name: CELTICS, sid: "302", price: 100 },
    ]);
    const q = await send(
      [{ ...nflLeg({}), pickId: "q1", sportKey: "basketball_nba", leagueName: "NBA", period: "FIRST_QUARTER", betDetail: "Celtics 1Q ML", homeTeam: LAKERS, awayTeam: CELTICS, odds: 100 }],
      [nba],
      [q1]
    );
    check("NBA 1st-quarter winner, Celtics: the Celtics Q1 runner", [q.legs[0].status, sentSelection(q)], ["matched", "302"]);
  }

  // ---------------------------------------------------------------------
  // 5. NHL and MLB moneylines - each with the row's home/away the reverse of the board's.
  // ---------------------------------------------------------------------
  {
    const WINGS = "Detroit Red Wings";
    const DEVILS = "New Jersey Devils";
    const nhl: FanDuelEvent = { id: "ev-nhl", sportKey: "icehockey_nhl", homeTeam: WINGS, awayTeam: DEVILS, commenceTime: START };
    const nhlH2h = market("h2h", "70.1", [
      { name: DEVILS, sid: "401", price: -125 },
      { name: WINGS, sid: "402", price: 105 },
    ]);
    const r = await send(
      [{ ...nflLeg({}), pickId: "nhl", sportKey: "icehockey_nhl", leagueName: "NHL", betDetail: "Red Wings ML", pickedSide: "AWAY", sideTeams: { homeTeam: DEVILS, awayTeam: WINGS }, homeTeam: WINGS, awayTeam: DEVILS, odds: 105 }],
      [nhl],
      [nhlH2h]
    );
    check("NHL ML Red Wings (row AWAY, board HOME): the Red Wings runner", [r.legs[0].status, sentSelection(r)], ["matched", "402"]);

    const GUARDS = "Cleveland Guardians";
    const RAYS = "Tampa Bay Rays";
    // MLB is out of season on the neutral-site date: this one is in July.
    const JULY_NOW = new Date("2026-07-14T18:00:00Z");
    const JULY_START = "2026-07-14T23:10:00Z";
    const mlb: FanDuelEvent = { id: "ev-mlb", sportKey: "baseball_mlb", homeTeam: RAYS, awayTeam: GUARDS, commenceTime: JULY_START };
    const mlbH2h = market("h2h", "80.1", [
      { name: RAYS, sid: "501", price: -140 },
      { name: GUARDS, sid: "502", price: 120 },
    ]);
    const m = await send(
      [{ ...nflLeg({}), pickId: "mlb", sportKey: "baseball_mlb", leagueName: "MLB", betDetail: "Guardians ML", pickedSide: "HOME", sideTeams: { homeTeam: GUARDS, awayTeam: RAYS }, homeTeam: RAYS, awayTeam: GUARDS, gameTime: JULY_START, odds: 120 }],
      [mlb],
      [mlbH2h],
      JULY_NOW
    );
    check("MLB ML Guardians (row HOME, board AWAY): the Guardians runner", [m.legs[0].status, sentSelection(m)], ["matched", "502"]);
  }

  // ---------------------------------------------------------------------
  // 6. Unresolvable or ambiguous runners: blocked, never another runner.
  // ---------------------------------------------------------------------
  {
    const unnamed = market("h2h", "734.1", [
      { name: "Home Team", sid: "901", price: 110 },
      { name: "Away Team", sid: "902", price: -134 },
    ]);
    const r = await send([uriLeg()], [oddsEvent], [unnamed]);
    check("no runner resolves to Rhode Island: blocked, nothing sent", [r.url, r.legs[0].status, r.legs[0].fanDuelOdds], [null, "side_unconfirmed", null]);
    check("...with the needs-review chip", notSentDisplay(r.legs[0]).label, "Couldn't confirm side on FanDuel");

    const onlyOther = market("h2h", "734.1", [{ name: UAB, sid: "901", price: 110 }]);
    const r2 = await send([uriLeg()], [oddsEvent], [onlyOther]);
    check("only UAB's runner listed: blocked, never UAB", [r2.url, r2.legs[0].status], [null, "side_unconfirmed"]);

    const twoUri = market("h2h", "734.1", [
      { name: URI, sid: "902", price: -134 },
      { name: "RHODE ISLAND RAMS", sid: "903", price: -130 },
      { name: UAB, sid: "901", price: 110 },
    ]);
    const r3 = await send([uriLeg()], [oddsEvent], [twoUri]);
    check("two differently spelled runners both resolve to Rhode Island: blocked", [r3.url, r3.legs[0].status], [null, "side_unconfirmed"]);
    const sameNameTwice = market("h2h", "734.1", [
      { name: URI, sid: "902", price: -134 },
      { name: URI, sid: "903", price: -130 },
      { name: UAB, sid: "901", price: 110 },
    ]);
    const r5 = await send([uriLeg()], [oddsEvent], [sameNameTwice]);
    check("two Rhode Island runners under one name: ambiguous, nothing sent", [r5.url, r5.legs[0].status], [null, "ambiguous"]);

    const r4 = await send([uriLeg({ pickedSide: "AWAY", sideTeams: { homeTeam: UAB, awayTeam: "Providence Friars" } })], [oddsEvent], [h2h]);
    check("the pick's team isn't in the game: blocked before FanDuel is asked", [r4.url, r4.legs[0].status], [null, "side_unconfirmed"]);
  }

  // The resolver alone: never a position, never the first runner.
  check(
    "resolveRunnerTeam: the pick's team by name, not its index",
    [
      resolveRunnerTeam([UAB, URI], { team: URI, opponent: UAB, sportKey: "basketball_ncaab" }),
      resolveRunnerTeam([URI, UAB], { team: URI, opponent: UAB, sportKey: "basketball_ncaab" }),
      resolveRunnerTeam([UAB, "Draw"], { team: URI, opponent: UAB, sportKey: "basketball_ncaab" }),
    ],
    [URI, URI, null]
  );

  // A team total with FanDuel's event listed the other way round: the team beside the outcome is resolved by name.
  {
    const BILLS = "Buffalo Bills";
    const RAMS = "Los Angeles Rams";
    const flipped: FanDuelEvent = { id: "ev-tt", sportKey: "americanfootball_nfl", homeTeam: BILLS, awayTeam: RAMS, commenceTime: START };
    const teamTotals = market("team_totals", "42.9", [
      { name: "Over", description: RAMS, sid: "921", price: -110, point: 24.5 },
      { name: "Over", description: BILLS, sid: "922", price: -110, point: 24.5 },
    ]);
    const r = await send(
      [{ pickId: "tt", sportKey: "americanfootball_nfl", leagueName: "NFL", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Bills Over 24.5", line: 24.5, homeTeam: RAMS, awayTeam: BILLS, gameTime: START, odds: -110, onBoard: true }],
      [flipped],
      [teamTotals]
    );
    check("team total Bills Over 24.5, FanDuel's home/away reversed: the Bills line", [r.legs[0].status, sentSelection(r)], ["matched", "922"]);
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
