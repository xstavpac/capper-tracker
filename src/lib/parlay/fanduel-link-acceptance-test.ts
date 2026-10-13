// Proof for fanduel-link.ts ("Send to FanDuel"). Pure: no DB, no network -
// the Odds API is the two functions in FanDuelDeps, faked here. The FanDuel
// ids and link shapes are the ones a real response carried on 2026-10-12.
//
// Section 5 runs on real FanDuel-only event responses captured 2026-10-13, one
// per league (__fixtures__/fanduel-event-*.json): every market the call asked
// for, with ids, links and prices as returned. Only the far ends of the
// alternate-line ladders are cut (spreads beyond +/-10.5, totals more than 6
// from the main line, team totals more than 5). NBA is a preseason game with
// the three main markets only - nothing here claims NBA period or alternate
// coverage until a regular-season response can be captured.
// Run with:
//   npx tsx src/lib/parlay/fanduel-link-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import {
  buildFanDuelBetslipUrl,
  buildFanDuelLink,
  fanDuelLegTarget,
  hasStarted,
  matchFanDuelOutcome,
  FANDUEL_BETSLIP_URL,
  type FanDuelDeps,
  type FanDuelEvent,
  type FanDuelLegInput,
  type FanDuelMarket,
} from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const link = (marketId: string, selectionId: string) =>
  `https://sportsbook.fanduel.com/addToBetslip?marketId=${marketId}&selectionId=${selectionId}`;

// Bills @ Rams as FanDuel listed it: market sids null, the marketId only in
// each outcome's link, the same selectionId for a team in h2h and spreads.
const GAME_MARKETS: FanDuelMarket[] = [
  {
    key: "h2h",
    sid: null,
    outcomes: [
      { name: "Buffalo Bills", price: 154, sid: "50203", link: link("42.612291277", "50203") },
      { name: "Los Angeles Rams", price: -184, sid: "10782388", link: link("42.612291277", "10782388") },
    ],
  },
  {
    key: "spreads",
    sid: null,
    outcomes: [
      { name: "Buffalo Bills", price: -115, point: 3.5, sid: "50203", link: link("42.612291278", "50203") },
      { name: "Los Angeles Rams", price: -105, point: -3.5, sid: "10782388", link: link("42.612291278", "10782388") },
    ],
  },
  {
    key: "totals",
    sid: null,
    outcomes: [
      { name: "Over", price: -110, point: 54.5, sid: "7017916", link: link("42.612291280", "7017916") },
      { name: "Under", price: -108, point: 54.5, sid: "7017917", link: link("42.612291280", "7017917") },
    ],
  },
];
const PROP_MARKETS: FanDuelMarket[] = [
  {
    key: "player_pass_yds",
    sid: null,
    outcomes: [
      { name: "Over", description: "Josh Allen", price: -113, point: 244.5, sid: "16503660", link: link("42.613952802", "16503660") },
      { name: "Under", description: "Josh Allen", price: -113, point: 244.5, sid: "16503661", link: link("42.613952802", "16503661") },
      { name: "Over", description: "Matthew Stafford", price: -113, point: 278.5, sid: "11889883", link: link("42.613952801", "11889883") },
      { name: "Under", description: "Matthew Stafford", price: -113, point: 278.5, sid: "11889882", link: link("42.613952801", "11889882") },
    ],
  },
];

// ---------------------------------------------------------------------
// 1. Outcome matcher
// ---------------------------------------------------------------------
check(
  "moneyline: the team's h2h outcome, marketId read from its link",
  matchFanDuelOutcome({ marketKeys: ["h2h"], outcomeName: "Buffalo Bills" }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291277", selectionId: "50203" }, price: 154 }
);
check(
  "spread +3.5: the dog's spread outcome (same selectionId as its moneyline, different marketId)",
  matchFanDuelOutcome({ marketKeys: ["spreads"], outcomeName: "Buffalo Bills", point: 3.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291278", selectionId: "50203" }, price: -115 }
);
check(
  "spread -3.5: the favorite's spread outcome",
  matchFanDuelOutcome({ marketKeys: ["spreads"], outcomeName: "Los Angeles Rams", point: -3.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291278", selectionId: "10782388" }, price: -105 }
);
check(
  "spread with the sign flipped is a different bet: not found",
  matchFanDuelOutcome({ marketKeys: ["spreads"], outcomeName: "Buffalo Bills", point: -3.5 }, GAME_MARKETS).status,
  "not_found"
);
check(
  "total Over 54.5",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Over", point: 54.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291280", selectionId: "7017916" }, price: -110 }
);
check(
  "total Under 54.5",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Under", point: 54.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291280", selectionId: "7017917" }, price: -108 }
);
check(
  "total at another line is never matched to the posted one",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Over", point: 53.5 }, GAME_MARKETS),
  { status: "not_found", reason: "FanDuel isn't offering this exact line right now." }
);
check(
  "player prop Over: that player's own market",
  matchFanDuelOutcome({ marketKeys: ["player_pass_yds"], outcomeName: "Over", description: "Josh Allen", point: 244.5 }, PROP_MARKETS),
  { status: "matched", selection: { marketId: "42.613952802", selectionId: "16503660" }, price: -113 }
);
check(
  "player prop Under, name matched whatever its case or punctuation",
  matchFanDuelOutcome({ marketKeys: ["player_pass_yds"], outcomeName: "Under", description: "matthew stafford", point: 278.5 }, PROP_MARKETS),
  { status: "matched", selection: { marketId: "42.613952801", selectionId: "11889882" }, price: -113 }
);
check(
  "player prop at the other player's line: not found",
  matchFanDuelOutcome({ marketKeys: ["player_pass_yds"], outcomeName: "Over", description: "Josh Allen", point: 278.5 }, PROP_MARKETS).status,
  "not_found"
);
check(
  "a near-miss player name is not a match",
  matchFanDuelOutcome({ marketKeys: ["player_pass_yds"], outcomeName: "Over", description: "Josh Allan", point: 244.5 }, PROP_MARKETS).status,
  "not_found"
);
check(
  "a market FanDuel didn't return: not found",
  matchFanDuelOutcome({ marketKeys: ["player_rush_yds"], outcomeName: "Over", description: "Josh Allen", point: 30.5 }, PROP_MARKETS),
  { status: "not_found", reason: "FanDuel isn't offering this market right now." }
);

const twoCandidates: FanDuelMarket[] = [
  ...GAME_MARKETS,
  { key: "totals", sid: null, outcomes: [{ name: "Over", price: -120, point: 54.5, sid: "999", link: link("42.700000001", "999") }] },
];
check(
  "two different selections fit: ambiguous, neither is picked",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Over", point: 54.5 }, twoCandidates),
  { status: "ambiguous", reason: "More than one FanDuel selection fits this pick." }
);
check(
  "the same selection listed twice is one candidate",
  matchFanDuelOutcome({ marketKeys: ["totals"], outcomeName: "Over", point: 54.5 }, [GAME_MARKETS[2], GAME_MARKETS[2]]).status,
  "matched"
);

const idsOf = (m: FanDuelMarket[]) => matchFanDuelOutcome({ marketKeys: ["h2h"], outcomeName: "Buffalo Bills" }, m);
const h2hWith = (outcome: Partial<FanDuelMarket["outcomes"][number]>, sid: string | null = null): FanDuelMarket[] => [
  { key: "h2h", sid, outcomes: [{ name: "Buffalo Bills", price: 154, ...outcome }] },
];
check(
  "a market sid, when the feed has one, is used with the outcome sid",
  idsOf(h2hWith({ sid: "50203" }, "42.5")),
  { status: "matched", selection: { marketId: "42.5", selectionId: "50203" }, price: 154 }
);
check("no link and no market sid: no marketId, not sent", idsOf(h2hWith({ sid: "50203" })).status, "not_found");
check(
  "a link that isn't FanDuel's is never read for ids",
  idsOf(h2hWith({ sid: "50203", link: "https://fanduel.com.evil.example/addToBetslip?marketId=42.1&selectionId=50203" })).status,
  "not_found"
);
check("sid and link disagreeing on the selection: not sent", idsOf(h2hWith({ sid: "50203", link: link("42.1", "777") })).status, "not_found");
check("an id that isn't a number is not sent", idsOf(h2hWith({ sid: "50203", link: link("42.1%26x%3D1", "50203") })).status, "not_found");

// ---------------------------------------------------------------------
// 2. URL builder
// ---------------------------------------------------------------------
const one = buildFanDuelBetslipUrl([{ marketId: "42.612291277", selectionId: "50203" }])!;
check("1 leg: indexed [0] only", decodeURIComponent(one), FANDUEL_BETSLIP_URL + "?marketId[0]=42.612291277&selectionId[0]=50203");

const three = buildFanDuelBetslipUrl([
  { marketId: "42.612291277", selectionId: "50203" },
  { marketId: "42.614182869", selectionId: "50211" },
  { marketId: "42.613952802", selectionId: "16503660" },
])!;
check(
  "3 legs: marketId[n] and selectionId[n] paired, in leg order",
  Array.from(new URL(three).searchParams.entries()),
  [
    ["marketId[0]", "42.612291277"],
    ["selectionId[0]", "50203"],
    ["marketId[1]", "42.614182869"],
    ["selectionId[1]", "50211"],
    ["marketId[2]", "42.613952802"],
    ["selectionId[2]", "16503660"],
  ]
);
check(
  "host and path are fixed",
  [new URL(one).origin + new URL(one).pathname, new URL(three).origin + new URL(three).pathname],
  ["https://account.sportsbook.fanduel.com/sportsbook/addToBetslip", "https://account.sportsbook.fanduel.com/sportsbook/addToBetslip"]
);
check("no legs: no link", buildFanDuelBetslipUrl([]), null);

// ---------------------------------------------------------------------
// 3. Pick -> market and outcome
// ---------------------------------------------------------------------
const NOW = new Date("2026-10-12T20:00:00Z");
const KICKOFF = "2026-10-13T00:15:00Z";
function leg(over: Partial<FanDuelLegInput>): FanDuelLegInput {
  return {
    pickId: "p1",
    sportKey: "americanfootball_nfl",
    leagueName: "NFL",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: "Bills ML",
    line: null,
    homeTeam: "Los Angeles Rams",
    awayTeam: "Buffalo Bills",
    gameTime: KICKOFF,
    odds: 150,
    onBoard: true,
    ...over,
  };
}
const target = (over: Partial<FanDuelLegInput>) => {
  const t = fanDuelLegTarget(leg(over));
  return t.ok ? t.target : "unsupported";
};
check("moneyline on the away team", target({}), { marketKey: "h2h", outcome: { side: "AWAY" } });
check("spread on the home team: its own signed line, more points is the easier way", target({ betType: "SPREAD", betDetail: "Rams -3.5", line: -3.5 }), {
  marketKey: "spreads",
  altMarketKey: "alternate_spreads",
  outcome: { side: "HOME" },
  point: -3.5,
  easier: "higher",
  maxLineMove: 1.5,
});
check("spread with no stored line reads it from the text", target({ betType: "SPREAD", betDetail: "Bills +3.5" }), {
  marketKey: "spreads",
  altMarketKey: "alternate_spreads",
  outcome: { side: "AWAY" },
  point: 3.5,
  easier: "higher",
  maxLineMove: 1.5,
});
check("total Under: a higher line is the easier way", target({ betType: "TOTAL", betDetail: "Under 54.5", line: 54.5 }), {
  marketKey: "totals",
  altMarketKey: "alternate_totals",
  outcome: { name: "Under" },
  point: 54.5,
  easier: "higher",
  maxLineMove: 1.5,
});
check("total Over: a lower line is the easier way", target({ betType: "TOTAL", betDetail: "Over 54.5", line: 54.5 }), {
  marketKey: "totals",
  altMarketKey: "alternate_totals",
  outcome: { name: "Over" },
  point: 54.5,
  easier: "lower",
  maxLineMove: 1.5,
});
const propTarget = target({ betType: "PLAYER_PROP", betDetail: "Josh Allen Over 244.5 Passing Yards" });
check("passing-yards prop Over: no alternate market, line may move 10%", propTarget === "unsupported" ? propTarget : { ...propTarget, maxLineMove: Math.round(propTarget.maxLineMove! * 100) / 100 }, {
  marketKey: "player_pass_yds",
  outcome: { name: "Over" },
  player: "Josh Allen",
  point: 244.5,
  maxLineMove: 24.45,
  easier: "lower",
});
check("passing touchdowns: exact line only", target({ betType: "PLAYER_PROP", betDetail: "Josh Allen Over 1.5 Passing TDs" }), {
  marketKey: "player_pass_tds",
  outcome: { name: "Over" },
  player: "Josh Allen",
  point: 1.5,
});
check("a first-half bet goes to the first-half market, never the full-game one", target({ period: "FIRST_HALF" }), { marketKey: "h2h_h1", outcome: { side: "AWAY" } });
check("NFL first-half spread has its own alternate market; a quarter has none", [target({ betType: "SPREAD", betDetail: "Bills +0.5", line: 0.5, period: "FIRST_HALF" }), target({ betType: "TOTAL", betDetail: "Over 9.5", line: 9.5, period: "FIRST_QUARTER" })], [
  { marketKey: "spreads_h1", altMarketKey: "alternate_spreads_h1", outcome: { side: "AWAY" }, point: 0.5, easier: "higher", maxLineMove: 1.5 },
  { marketKey: "totals_q1", outcome: { name: "Over" }, point: 9.5, easier: "lower", maxLineMove: 1.5 },
]);
check("team total: the team's own market, the team where a prop has its player", target({ betType: "TEAM_TOTAL", betDetail: "Bills Over 24.5", line: 24.5 }), {
  marketKey: "team_totals",
  altMarketKey: "alternate_team_totals",
  outcome: { name: "Over" },
  team: "AWAY",
  point: 24.5,
  easier: "lower",
  maxLineMove: 1.5,
});
check("a team total naming neither team, and NRFI, are not sent", [target({ betType: "TEAM_TOTAL", betDetail: "Team Total Over 24.5", line: 24.5 }), target({ betType: "NRFI", betDetail: "NRFI" })], ["unsupported", "unsupported"]);
const reason = (over: Partial<FanDuelLegInput>) => {
  const t = fanDuelLegTarget(leg(over));
  return t.ok ? "sendable" : t.reason;
};
const ncaaf = { sportKey: "americanfootball_ncaaf", leagueName: "NCAAF" };
const mlb = { sportKey: "baseball_mlb", leagueName: "MLB", homeTeam: "Tampa Bay Rays", awayTeam: "Cleveland Guardians" };
const nhl = { sportKey: "icehockey_nhl", leagueName: "NHL", homeTeam: "Detroit Red Wings", awayTeam: "New Jersey Devils" };
check(
  "a period FanDuel doesn't sell for the league stays unsupported",
  [
    reason({ ...ncaaf, period: "SECOND_HALF" }),
    reason({ period: "SECOND_HALF" }),
    reason({ ...mlb, betDetail: "Guardians ML", period: "FIRST_QUARTER" }),
    reason({ ...mlb, betType: "TEAM_TOTAL", betDetail: "Guardians Team Total Over 1.5", line: 1.5, period: "FIRST_HALF" }),
    reason({ sportKey: "basketball_wnba", leagueName: "WNBA", period: "FIRST_HALF" }),
    reason({ betType: "PLAYER_PROP", betDetail: "Josh Allen Over 120.5 Passing Yards", period: "FIRST_HALF" }),
  ],
  [
    "FanDuel doesn't offer this period for NCAAF.",
    "sendable",
    "FanDuel doesn't offer this period for MLB.",
    "FanDuel doesn't offer this team total for MLB.",
    "FanDuel doesn't offer this period for WNBA.",
    "Only full-game player props can be sent.",
  ]
);
check(
  "period keys: MLB first five, NHL periods, the hockey 3-way moneyline and its draw",
  [
    target({ ...mlb, betDetail: "Guardians F5 ML", period: "FIRST_HALF" }),
    target({ ...nhl, betType: "TOTAL", betDetail: "Over 1.5 First Period", line: 1.5, period: "FIRST_PERIOD" }),
    target({ ...nhl, betDetail: "Red Wings ML", period: "THIRD_PERIOD" }),
    target({ ...nhl, betDetail: "Red Wings 3-way ML", period: "REGULATION" }),
    target({ ...nhl, betDetail: "Devils Red Wings Draw", period: "REGULATION" }),
    target({ ...mlb, betType: "TEAM_TOTAL", betDetail: "Guardians Team Total Under 4.5", line: 4.5 }),
  ],
  [
    { marketKey: "h2h_1st_5_innings", outcome: { side: "AWAY" } },
    { marketKey: "totals_p1", altMarketKey: "alternate_totals_p1", outcome: { name: "Over" }, point: 1.5, easier: "lower", maxLineMove: 1.5 },
    { marketKey: "h2h_p3", outcome: { side: "HOME" } },
    { marketKey: "h2h_3_way", outcome: { side: "HOME" } },
    { marketKey: "h2h_3_way", outcome: { name: "Draw" } },
    { marketKey: "team_totals", outcome: { name: "Under" }, team: "AWAY", point: 4.5, easier: "higher", maxLineMove: 1.5 },
  ]
);
check("a moneyline naming neither team", target({ betDetail: "ML" }), "unsupported");
check("a total with no Over/Under", target({ betType: "TOTAL", betDetail: "Total 54.5", line: 54.5 }), "unsupported");
check("a league the odds feed doesn't carry", target({ sportKey: null, leagueName: "ATP" }), "unsupported");

// ---------------------------------------------------------------------
// 4. Legs -> link: started games, one call per event, only the needed markets
// ---------------------------------------------------------------------
const EVENTS: Record<string, FanDuelEvent[]> = {
  americanfootball_nfl: [
    { id: "evt-buf-lar", homeTeam: "Los Angeles Rams", awayTeam: "Buffalo Bills", commenceTime: KICKOFF },
    { id: "evt-sea-den", homeTeam: "Denver Broncos", awayTeam: "Seattle Seahawks", commenceTime: "2026-10-16T00:15:00Z" },
  ],
};
const DEN_MARKETS: FanDuelMarket[] = [
  {
    key: "h2h",
    sid: null,
    outcomes: [
      { name: "Denver Broncos", price: 132, sid: "50211", link: link("42.614182869", "50211") },
      { name: "Seattle Seahawks", price: -156, sid: "50213", link: link("42.614182869", "50213") },
    ],
  },
];
function fakeDeps(now: Date) {
  const calls: { events: string[]; odds: { eventId: string; marketKeys: string[] }[] } = { events: [], odds: [] };
  const deps: FanDuelDeps = {
    now,
    async getEvents(sportKey) {
      calls.events.push(sportKey);
      return EVENTS[sportKey] ?? [];
    },
    async getEventMarkets(_sportKey, eventId, marketKeys) {
      calls.odds.push({ eventId, marketKeys });
      const all = eventId === "evt-buf-lar" ? [...GAME_MARKETS, ...PROP_MARKETS] : eventId === "evt-sea-den" ? DEN_MARKETS : [];
      return all.filter((m) => marketKeys.includes(m.key));
    },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------
// 5. Real FanDuel responses (2026-10-13): alternates, team totals, periods
// ---------------------------------------------------------------------
type Capture = { id: string; sport_key: string; commence_time: string; home_team: string; away_team: string; bookmakers: { key: string; markets: FanDuelMarket[] }[] };
const capture = (name: string): Capture => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "fanduel-event-" + name + ".json"), "utf8"));
const CAPTURES = { NFL: capture("nfl"), NCAAF: capture("ncaaf"), NHL: capture("nhl"), MLB: capture("mlb"), NBA: capture("nba-preseason") };
const SPORT_KEYS = { NFL: "americanfootball_nfl", NCAAF: "americanfootball_ncaaf", NHL: "icehockey_nhl", MLB: "baseball_mlb", NBA: "basketball_nba" };
type League = keyof typeof CAPTURES;
const marketsOf = (league: League) => CAPTURES[league].bookmakers[0].markets;

// The feed as it answered: an event's markets filtered to the keys asked for.
function captureDeps() {
  const calls: Record<string, string[][]> = {};
  const deps: FanDuelDeps = {
    now: new Date("2026-10-13T20:00:00Z"),
    async getEvents(sportKey) {
      return (Object.keys(CAPTURES) as League[])
        .filter((l) => SPORT_KEYS[l] === sportKey)
        .map((l) => ({ id: CAPTURES[l].id, homeTeam: CAPTURES[l].home_team, awayTeam: CAPTURES[l].away_team, commenceTime: CAPTURES[l].commence_time }));
    },
    async getEventMarkets(sportKey, eventId, marketKeys) {
      const league = (Object.keys(CAPTURES) as League[]).find((l) => SPORT_KEYS[l] === sportKey && CAPTURES[l].id === eventId)!;
      calls[league] = [...(calls[league] ?? []), marketKeys];
      return marketsOf(league).filter((m) => marketKeys.includes(m.key));
    },
  };
  return { deps, calls };
}
function realLeg(league: League, pickId: string, over: Partial<FanDuelLegInput>): FanDuelLegInput {
  const c = CAPTURES[league];
  return {
    pickId,
    sportKey: SPORT_KEYS[league],
    leagueName: league,
    betType: "TOTAL",
    period: "FULL_GAME",
    betDetail: pickId,
    line: null,
    homeTeam: c.home_team,
    awayTeam: c.away_team,
    gameTime: c.commence_time,
    odds: -110,
    onBoard: true,
    ...over,
  };
}
// [status, FanDuel's price, sentLine, reason] per leg, and the ids in the link.
async function send(legs: FanDuelLegInput[]) {
  const { deps, calls } = captureDeps();
  const built = await buildFanDuelLink(legs, deps);
  return {
    legs: Object.fromEntries(built.legs.map((l) => [l.pickId, [l.status, l.fanDuelOdds, l.sentLine, l.reason]])),
    ids: built.url ? Array.from(new URL(built.url).searchParams.values()) : [],
    calls,
  };
}

async function realResponses() {
  // --- NCAAF: FIU @ Jacksonville State. Main spread FIU +2.5, main total 43.5.
  const fiu = await send([
    realLeg("NCAAF", "FIU +7.5", { betType: "SPREAD", line: 7.5 }),
    realLeg("NCAAF", "Jacksonville State Team Total Under 23.5", { betType: "TEAM_TOTAL", line: 23.5 }),
    realLeg("NCAAF", "Jacksonville State First Half Moneyline", { betType: "MONEYLINE", period: "FIRST_HALF" }),
    realLeg("NCAAF", "FIU 2H ML", { betType: "MONEYLINE", period: "SECOND_HALF" }),
  ]);
  check("FIU +7.5 with the main spread at +2.5: the exact line on the alternate market, at the alternate's own price (-230, not the main +102)", fiu.legs["FIU +7.5"], ["matched", -230, null, null]);
  check("team total Under 23.5: Jacksonville State's own team-total market", fiu.legs["Jacksonville State Team Total Under 23.5"], ["matched", -120, null, null]);
  check("first-half moneyline: the h2h_h1 market", fiu.legs["Jacksonville State First Half Moneyline"], ["matched", -138, null, null]);
  check("NCAAF second half, which FanDuel doesn't sell, never reaches the feed", fiu.legs["FIU 2H ML"], ["unsupported", null, null, "FanDuel doesn't offer this period for NCAAF."]);
  check("the link: alternate-spread, team-total and first-half selections, in leg order", [fiu.ids[0], fiu.ids[1], fiu.ids[2], fiu.ids[3], fiu.ids[5]], ["42.615585290", "61300718", "42.615585266", "7017917", "4943282"]);
  check("credits: one main call for the three markets, one alternate call for the one leg that missed", fiu.calls, {
    NCAAF: [["h2h_h1", "spreads", "team_totals"], ["alternate_spreads"]],
  });

  // --- NHL: Devils @ Red Wings. Main total 6.5; alternates every .5 from 2.5 to 11.5.
  const wings = await send([
    realLeg("NHL", "Red Wings Over 5.5", { line: 5.5 }),
    realLeg("NHL", "Blackhawks Over 6", { betDetail: "Over 6", line: 6 }),
    realLeg("NHL", "Under 6", { line: 6 }),
    realLeg("NHL", "Over 13", { line: 13 }),
    realLeg("NHL", "Over 13.5", { line: 13.5 }),
    realLeg("NHL", "Over 1", { line: 1 }),
    realLeg("NHL", "Devils Red Wings Over 1.5 First Period", { line: 1.5, period: "FIRST_PERIOD" }),
    realLeg("NHL", "Red Wings Team Total Under 2.5", { betType: "TEAM_TOTAL", line: 2.5 }),
    realLeg("NHL", "Red Wings 3-way ML", { betType: "MONEYLINE", period: "REGULATION" }),
  ]);
  check("Over 5.5 with the main total at 6.5: exact on the alternate market", wings.legs["Red Wings Over 5.5"], ["matched", -142, null, null]);
  check("tie-break, Over 6 between 5.5 and 6.5: an Over takes the LOWER line, at that line's price", wings.legs["Blackhawks Over 6"], [
    "adjusted",
    -142,
    { pick: 6, fanDuel: 5.5, side: "Over", worse: false },
    null,
  ]);
  check("tie-break, Under 6: an Under takes the HIGHER line - 6.5, the main market's own selection and price", wings.legs["Under 6"], [
    "adjusted",
    -140,
    { pick: 6, fanDuel: 6.5, side: "Under", worse: false },
    null,
  ]);
  check("cap boundary: exactly 1.5 away (13 -> 11.5) is sent", wings.legs["Over 13"], ["adjusted", 4300, { pick: 13, fanDuel: 11.5, side: "Over", worse: false }, null]);
  check("cap boundary: 2.0 away (13.5 -> 11.5) is a truly absent line - Not found", wings.legs["Over 13.5"], [
    "not_found",
    null,
    null,
    "FanDuel's nearest line is 11.5, too far from your pick.",
  ]);
  check("worse-line flag: Over 1 can only go at Over 2.5, which is harder to win", wings.legs["Over 1"], ["adjusted", -6000, { pick: 1, fanDuel: 2.5, side: "Over", worse: true }, null]);
  check("first-period total: the totals_p1 market", wings.legs["Devils Red Wings Over 1.5 First Period"], ["matched", -122, null, null]);
  check(
    "no opposite side: FanDuel has Red Wings 2.5 only as an Over - the Under goes to the nearest UNDER (3.5 over 1.5, the higher), never to Over 2.5",
    wings.legs["Red Wings Team Total Under 2.5"],
    ["adjusted", -180, { pick: 2.5, fanDuel: 3.5, side: "Under", worse: false }, null]
  );
  check("hockey 3-way moneyline: the h2h_3_way market", wings.legs["Red Wings 3-way ML"], ["matched", 140, null, null]);
  check("the selections sent, in leg order (the cap-busting leg has none)", wings.ids.slice(0, 14), [
    "42.615952772", "8359772", // Over 5.5 (alternate)
    "42.615952772", "8359772", // Over 6 -> Over 5.5
    "42.615070889", "7017912", // Under 6 -> Under 6.5 (main)
    "42.615952772", "8060349", // Over 13 -> Over 11.5
    "42.615952772", "8359788", // Over 1 -> Over 2.5
    "42.615952730", "7017911", // 1P Over 1.5
    "42.615952616", "8359773", // Red Wings TT Under 3.5
  ]);
  check("credits: the first-period total and the 3-way hit on the main call, so only the two alternate keys the missed legs need are bought", wings.calls, {
    NHL: [["h2h_3_way", "team_totals", "totals", "totals_p1"], ["alternate_team_totals", "alternate_totals"]],
  });

  // Matcher level, same response: nothing but the pick's own side is ever a candidate.
  const overOnly = marketsOf("NHL")
    .filter((m) => m.key === "totals" || m.key === "alternate_totals")
    .map((m) => ({ ...m, outcomes: m.outcomes.filter((o) => o.name === "Over") }));
  check(
    "no opposite side: with only Overs on the board an Under is Not found, even at a line the Over has",
    matchFanDuelOutcome({ marketKeys: ["totals", "alternate_totals"], outcomeName: "Under", point: 6.5, maxLineMove: 1.5, easier: "higher" }, overOnly),
    { status: "not_found", reason: "FanDuel isn't offering this exact line right now." }
  );
  check(
    "no opposite side: New Jersey's spread is never a match for Detroit's at the same number",
    matchFanDuelOutcome({ marketKeys: ["spreads"], outcomeName: "Detroit Red Wings", point: 1.5 }, marketsOf("NHL")).status,
    "not_found"
  );
  check(
    "no other market: a team total is never filled from the game total",
    matchFanDuelOutcome(
      { marketKeys: ["team_totals", "alternate_team_totals"], outcomeName: "Over", description: "Detroit Red Wings", point: 6.5, maxLineMove: 1.5, easier: "lower" },
      marketsOf("NHL").filter((m) => m.key.includes("totals") && !m.key.includes("team"))
    ),
    { status: "not_found", reason: "FanDuel isn't offering this market right now." }
  );
  check(
    "a tie with nothing to say which way is easier is ambiguous, not a coin flip",
    matchFanDuelOutcome({ marketKeys: ["totals", "alternate_totals"], outcomeName: "Over", point: 6, maxLineMove: 1.5 }, marketsOf("NHL")).status,
    "ambiguous"
  );
  check(
    "the main line is in the alternate market too, under other ids: the main market's selection is the one used",
    matchFanDuelOutcome({ marketKeys: ["totals", "alternate_totals"], outcomeName: "Over", point: 6.5 }, marketsOf("NHL")),
    { status: "matched", selection: { marketId: "42.615070889", selectionId: "7017911" }, price: 114 }
  );

  // --- MLB: Guardians @ Rays. Team totals 3.5 each; FanDuel has no alternate team totals.
  const guardians = await send([
    realLeg("MLB", "Guardians Team Total Under 4.5", { betType: "TEAM_TOTAL", line: 4.5 }),
    realLeg("MLB", "Guardians Team Total Under 5.5", { betType: "TEAM_TOTAL", line: 5.5 }),
    realLeg("MLB", "Guardians F5 ML", { betType: "MONEYLINE", period: "FIRST_HALF" }),
    realLeg("MLB", "F5 Under 4", { line: 4, period: "FIRST_HALF" }),
  ]);
  check("worse-line flag: Guardians Team Total Under 4.5 goes at Under 3.5 - inside the cap, harder to win, flagged", guardians.legs["Guardians Team Total Under 4.5"], [
    "adjusted",
    -150,
    { pick: 4.5, fanDuel: 3.5, side: "Under", worse: true },
    null,
  ]);
  check("the same team total 2.0 away is Not found", guardians.legs["Guardians Team Total Under 5.5"], ["not_found", null, null, "FanDuel's nearest line is 3.5, too far from your pick."]);
  check("first-five moneyline: the h2h_1st_5_innings market", guardians.legs["Guardians F5 ML"], ["matched", 104, null, null]);
  check("first-five Under 4 between 3.5 and 4.5: the higher line, from the first-five alternates", guardians.legs["F5 Under 4"]?.[2], { pick: 4, fanDuel: 4.5, side: "Under", worse: false });
  check("credits: no alternate call for the team totals (MLB has none) - only the first-five alternate totals", guardians.calls, {
    MLB: [["h2h_1st_5_innings", "team_totals", "totals_1st_5_innings"], ["alternate_totals_1st_5_innings"]],
  });

  // --- NFL: Seahawks @ Broncos. First-half spread Seattle -1.5, with first-half alternates.
  const hawks = await send([
    realLeg("NFL", "Seahawks 1H -3.5", { betType: "SPREAD", line: -3.5, period: "FIRST_HALF" }),
    realLeg("NFL", "2H Over 19.5", { line: 19.5, period: "SECOND_HALF" }),
    realLeg("NFL", "Seahawks -3", { betType: "SPREAD", line: -3 }),
    realLeg("NFL", "Seahawks -4", { betType: "SPREAD", line: -4 }),
  ]);
  check("first-half alternate spread, second-half total", [hawks.legs["Seahawks 1H -3.5"], hawks.legs["2H Over 19.5"]], [
    ["matched", 138, null, null],
    ["matched", -125, null, null],
  ]);
  check("tie-break, spread -3 between -2.5 and -3.5: a spread takes MORE points (-2.5), the main market's selection", hawks.legs["Seahawks -3"], [
    "adjusted",
    -120,
    { pick: -3, fanDuel: -2.5, side: null, worse: false },
    null,
  ]);
  check("tie-break, spread -4 between -3.5 and -4.5: -3.5", hawks.legs["Seahawks -4"]?.[2], { pick: -4, fanDuel: -3.5, side: null, worse: false });

  // --- NBA (preseason capture): the main markets only. Period and alternate
  // coverage is wired but unverified, so nothing is asserted about it here.
  const cavs = await send([
    realLeg("NBA", "Magic +1.5", { betType: "SPREAD", line: 1.5 }),
    realLeg("NBA", "Cavaliers ML", { betType: "MONEYLINE" }),
    realLeg("NBA", "Under 228.5", { line: 228.5 }),
  ]);
  check("NBA main markets match as before, on one call", [cavs.legs, cavs.calls], [
    { "Magic +1.5": ["matched", -110, null, null], "Cavaliers ML": ["matched", -122, null, null], "Under 228.5": ["matched", -105, null, null] },
    { NBA: [["h2h", "spreads", "totals"]] },
  ]);
}

async function main() {
  check("kickoff in the future has not started; at or before now it has", [hasStarted(KICKOFF, NOW), hasStarted(NOW.toISOString(), NOW), hasStarted("2026-10-12T19:00:00Z", NOW)], [false, true, true]);

  const billsMl = leg({ pickId: "bills-ml" });
  const allenProp = leg({ pickId: "allen", betType: "PLAYER_PROP", betDetail: "Josh Allen Over 244.5 Passing Yards", odds: -110 });
  const broncosMl = leg({ pickId: "broncos-ml", betDetail: "Broncos ML", homeTeam: "Denver Broncos", awayTeam: "Seattle Seahawks", gameTime: "2026-10-16T00:15:00Z", odds: 132 });
  const started = leg({ pickId: "started", homeTeam: "Dallas Cowboys", awayTeam: "New York Giants", betDetail: "Cowboys ML", gameTime: "2026-10-12T17:00:00Z" });

  const a = fakeDeps(NOW);
  const built = await buildFanDuelLink([billsMl, started, broncosMl, allenProp], a.deps);
  check(
    "each leg's status, in the order asked",
    built.legs.map((l) => [l.pickId, l.status, l.pickOdds, l.fanDuelOdds]),
    [
      ["bills-ml", "matched", 150, 154],
      ["started", "started", 150, null],
      ["broncos-ml", "matched", 132, 132],
      ["allen", "matched", -110, -113],
    ]
  );
  check("the started leg says why", built.legs[1].reason, "Game has already started.");
  check(
    "the link holds the matched legs only, in leg order",
    Array.from(new URL(built.url!).searchParams.values()),
    ["42.612291277", "50203", "42.614182869", "50211", "42.613952802", "16503660"]
  );
  check("one listing per league", a.calls.events, ["americanfootball_nfl"]);
  check(
    "one odds call per event, for only the markets its legs need - none for the started game",
    a.calls.odds.sort((x, y) => x.eventId.localeCompare(y.eventId)),
    [
      { eventId: "evt-buf-lar", marketKeys: ["h2h", "player_pass_yds"] },
      { eventId: "evt-sea-den", marketKeys: ["h2h"] },
    ]
  );

  const b = fakeDeps(NOW);
  const onlyStarted = await buildFanDuelLink([started, leg({ pickId: "nrfi", betType: "NRFI", betDetail: "NRFI" })], b.deps);
  check("nothing sendable: no link, each leg with a reason, the feed never asked", [onlyStarted.url, onlyStarted.legs.map((l) => l.status), b.calls], [
    null,
    ["started", "unsupported"],
    { events: [], odds: [] },
  ]);

  const c = fakeDeps(new Date("2026-10-13T00:20:00Z"));
  const afterKickoff = await buildFanDuelLink([leg({ pickId: "late", gameTime: "2026-10-13T00:25:00Z" })], c.deps);
  check("a leg whose own time is still ahead but whose game has kicked off is skipped", [afterKickoff.legs[0].status, afterKickoff.url, c.calls.odds], ["started", null, []]);

  const d = fakeDeps(NOW);
  const wrongLine = await buildFanDuelLink([leg({ pickId: "alt", betType: "SPREAD", betDetail: "Bills +4.5", line: 4.5 }), billsMl], d.deps);
  check(
    "a line the main market doesn't have: the alternate market is asked once, for that leg's key only; with none there, FanDuel's own line is sent and flagged worse",
    [wrongLine.legs.map((l) => [l.status, l.fanDuelOdds, l.sentLine]), d.calls.odds],
    [
      [
        ["adjusted", -115, { pick: 4.5, fanDuel: 3.5, side: null, worse: true }],
        ["matched", 154, null],
      ],
      [
        { eventId: "evt-buf-lar", marketKeys: ["h2h", "spreads"] },
        { eventId: "evt-buf-lar", marketKeys: ["alternate_spreads"] },
      ],
    ]
  );
  const d2 = fakeDeps(NOW);
  const farLine = await buildFanDuelLink([leg({ pickId: "far-line", betType: "SPREAD", betDetail: "Bills +6.5", line: 6.5 }), billsMl], d2.deps);
  check("a line too far from anything FanDuel has is left out; the rest still go", [farLine.legs.map((l) => [l.status, l.reason]), Array.from(new URL(farLine.url!).searchParams.keys())], [
    [
      ["not_found", "FanDuel's nearest line is +3.5, too far from your pick."],
      ["matched", null],
    ],
    ["marketId[0]", "selectionId[0]"],
  ]);
  let altCalls = 0;
  const altDown: FanDuelDeps = {
    now: NOW,
    getEvents: async () => EVENTS.americanfootball_nfl,
    getEventMarkets: async (_s, _e, keys) => (keys.includes("alternate_spreads") ? (altCalls++, null) : GAME_MARKETS.filter((m) => keys.includes(m.key))),
  };
  const altFailed = await buildFanDuelLink([leg({ pickId: "alt", betType: "SPREAD", betDetail: "Bills +4.5", line: 4.5 }), billsMl], altDown);
  check("the alternate call failing is an error on that leg only - no line is guessed from half the picture", [altFailed.legs.map((l) => l.status), altCalls], [["error", "matched"], 1]);

  const e = fakeDeps(NOW);
  const noGame = await buildFanDuelLink([leg({ pickId: "far", gameTime: "2026-10-13T03:00:00Z" })], e.deps);
  check("same teams hours from the feed's kickoff is not that game", [noGame.legs[0].status, e.calls.odds], ["not_found", []]);

  const down: FanDuelDeps = { now: NOW, getEvents: async () => EVENTS.americanfootball_nfl, getEventMarkets: async () => null };
  const failed = await buildFanDuelLink([billsMl], down);
  check("the feed failing is an error on the leg, not a match", [failed.url, failed.legs[0].status], [null, "error"]);

  await realResponses();

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main();
