// Proof for fanduel-link.ts ("Send to FanDuel"). Pure: no DB, no network -
// the Odds API is the two functions in FanDuelDeps, faked here. The FanDuel
// ids and link shapes are the ones a real response carried on 2026-10-12.
// Run with:
//   npx tsx src/lib/parlay/fanduel-link-acceptance-test.ts
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
  matchFanDuelOutcome({ marketKey: "h2h", outcomeName: "Buffalo Bills" }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291277", selectionId: "50203" }, price: 154 }
);
check(
  "spread +3.5: the dog's spread outcome (same selectionId as its moneyline, different marketId)",
  matchFanDuelOutcome({ marketKey: "spreads", outcomeName: "Buffalo Bills", point: 3.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291278", selectionId: "50203" }, price: -115 }
);
check(
  "spread -3.5: the favorite's spread outcome",
  matchFanDuelOutcome({ marketKey: "spreads", outcomeName: "Los Angeles Rams", point: -3.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291278", selectionId: "10782388" }, price: -105 }
);
check(
  "spread with the sign flipped is a different bet: not found",
  matchFanDuelOutcome({ marketKey: "spreads", outcomeName: "Buffalo Bills", point: -3.5 }, GAME_MARKETS).status,
  "not_found"
);
check(
  "total Over 54.5",
  matchFanDuelOutcome({ marketKey: "totals", outcomeName: "Over", point: 54.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291280", selectionId: "7017916" }, price: -110 }
);
check(
  "total Under 54.5",
  matchFanDuelOutcome({ marketKey: "totals", outcomeName: "Under", point: 54.5 }, GAME_MARKETS),
  { status: "matched", selection: { marketId: "42.612291280", selectionId: "7017917" }, price: -108 }
);
check(
  "total at another line is never matched to the posted one",
  matchFanDuelOutcome({ marketKey: "totals", outcomeName: "Over", point: 53.5 }, GAME_MARKETS),
  { status: "not_found", reason: "FanDuel isn't offering this exact line right now." }
);
check(
  "player prop Over: that player's own market",
  matchFanDuelOutcome({ marketKey: "player_pass_yds", outcomeName: "Over", player: "Josh Allen", point: 244.5 }, PROP_MARKETS),
  { status: "matched", selection: { marketId: "42.613952802", selectionId: "16503660" }, price: -113 }
);
check(
  "player prop Under, name matched whatever its case or punctuation",
  matchFanDuelOutcome({ marketKey: "player_pass_yds", outcomeName: "Under", player: "matthew stafford", point: 278.5 }, PROP_MARKETS),
  { status: "matched", selection: { marketId: "42.613952801", selectionId: "11889882" }, price: -113 }
);
check(
  "player prop at the other player's line: not found",
  matchFanDuelOutcome({ marketKey: "player_pass_yds", outcomeName: "Over", player: "Josh Allen", point: 278.5 }, PROP_MARKETS).status,
  "not_found"
);
check(
  "a near-miss player name is not a match",
  matchFanDuelOutcome({ marketKey: "player_pass_yds", outcomeName: "Over", player: "Josh Allan", point: 244.5 }, PROP_MARKETS).status,
  "not_found"
);
check(
  "a market FanDuel didn't return: not found",
  matchFanDuelOutcome({ marketKey: "player_rush_yds", outcomeName: "Over", player: "Josh Allen", point: 30.5 }, PROP_MARKETS),
  { status: "not_found", reason: "FanDuel isn't offering this market right now." }
);

const twoCandidates: FanDuelMarket[] = [
  ...GAME_MARKETS,
  { key: "totals", sid: null, outcomes: [{ name: "Over", price: -120, point: 54.5, sid: "999", link: link("42.700000001", "999") }] },
];
check(
  "two different selections fit: ambiguous, neither is picked",
  matchFanDuelOutcome({ marketKey: "totals", outcomeName: "Over", point: 54.5 }, twoCandidates),
  { status: "ambiguous", reason: "More than one FanDuel selection fits this pick." }
);
check(
  "the same selection listed twice is one candidate",
  matchFanDuelOutcome({ marketKey: "totals", outcomeName: "Over", point: 54.5 }, [GAME_MARKETS[2], GAME_MARKETS[2]]).status,
  "matched"
);

const idsOf = (m: FanDuelMarket[]) => matchFanDuelOutcome({ marketKey: "h2h", outcomeName: "Buffalo Bills" }, m);
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
check("spread on the home team, its own signed line", target({ betType: "SPREAD", betDetail: "Rams -3.5", line: -3.5 }), {
  marketKey: "spreads",
  outcome: { side: "HOME" },
  point: -3.5,
});
check("spread with no stored line reads it from the text", target({ betType: "SPREAD", betDetail: "Bills +3.5" }), {
  marketKey: "spreads",
  outcome: { side: "AWAY" },
  point: 3.5,
});
check("total Under", target({ betType: "TOTAL", betDetail: "Under 54.5", line: 54.5 }), { marketKey: "totals", outcome: { name: "Under" }, point: 54.5 });
check("passing-yards prop Over", target({ betType: "PLAYER_PROP", betDetail: "Josh Allen Over 244.5 Passing Yards" }), {
  marketKey: "player_pass_yds",
  outcome: { name: "Over" },
  player: "Josh Allen",
  point: 244.5,
});
check("a first-half bet is not sent as the full-game one", target({ period: "FIRST_HALF" }), "unsupported");
check("team total / NRFI have no market here", [target({ betType: "TEAM_TOTAL", betDetail: "Bills Over 24.5", line: 24.5 }), target({ betType: "NRFI", betDetail: "NRFI" })], ["unsupported", "unsupported"]);
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
  const onlyStarted = await buildFanDuelLink([started, leg({ pickId: "half", period: "FIRST_HALF" })], b.deps);
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
  check("a leg at a line FanDuel isn't hanging is left out; the rest still go", [wrongLine.legs.map((l) => l.status), Array.from(new URL(wrongLine.url!).searchParams.keys())], [
    ["not_found", "matched"],
    ["marketId[0]", "selectionId[0]"],
  ]);

  const e = fakeDeps(NOW);
  const noGame = await buildFanDuelLink([leg({ pickId: "far", gameTime: "2026-10-13T03:00:00Z" })], e.deps);
  check("same teams hours from the feed's kickoff is not that game", [noGame.legs[0].status, e.calls.odds], ["not_found", []]);

  const down: FanDuelDeps = { now: NOW, getEvents: async () => EVENTS.americanfootball_nfl, getEventMarkets: async () => null };
  const failed = await buildFanDuelLink([billsMl], down);
  check("the feed failing is an error on the leg, not a match", [failed.url, failed.legs[0].status], [null, "error"]);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main();
