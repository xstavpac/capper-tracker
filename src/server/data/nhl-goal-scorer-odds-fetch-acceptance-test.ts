// Proof for nhl-goal-scorer-odds.ts: which NHL games the two event-level
// markets (anytime goal scorer, 3-way moneyline) are bought for, what the
// request looks like, what it logs to odds_api_usage_log, and that the NFL
// request built by the same shared loop is unchanged.
//
// prisma.oddsSnapshot / prisma.oddsApiUsageLog and global fetch are stubbed
// throughout - no real network call, no real DB. NEVER remove the "unexpected
// fetch" throw in stubEventOddsFetch below: an accidental real call here would
// spend real credits silently.
//
// Listed in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nhl-goal-scorer-odds-fetch-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  NHL_GOAL_SCORER_LOOKAHEAD_MS,
  nhlGamesNeedingGoalScorerOdds,
  resolveAnytimeGoalOddsFromGame,
  missingNhlEventMarkets as missingMarkets,
  resolveThreeWayOddsFromGame,
  seedNhlGoalScorerOddsForToday,
} from "@/server/data/nhl-goal-scorer-odds";
import { fetchAndMergeNflPropOdds } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const prismaOriginals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  prismaOriginals[path] ??= target[method];
  target[method] = fn;
}
function restorePrisma() {
  for (const path of Object.keys(prismaOriginals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = prismaOriginals[path];
  }
}

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
// routes: eventId -> response. Any URL not matching a routed eventId throws.
function stubEventOddsFetch(routes: Record<string, { ok: boolean; body?: unknown; headers?: Record<string, string> }>) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const redacted = url.replace(/apiKey=[^&]+/, "apiKey=REDACTED");
    fetchCalls.push(redacted);
    const match = Object.keys(routes).find((id) => url.includes("/events/" + id + "/odds"));
    if (!match) throw new Error("unexpected fetch (would have spent real credits): " + redacted);
    const r = routes[match];
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      statusText: r.ok ? "OK" : "ERR",
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

// Frozen clock: "today" is an Eastern calendar day, so the run times below are
// real ones - the midnight run (05:05 UTC = 01:05 EDT) and the afternoon run
// (16:30 UTC = 12:30 PM EDT) of 2026-10-13.
const HOUR = 3600000;
const MIDNIGHT_RUN = Date.parse("2026-10-13T05:05:00Z");
const AFTERNOON_RUN = Date.parse("2026-10-13T16:30:00Z");
let clock = MIDNIGHT_RUN;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [string]));
  }
  static now() {
    return clock;
  }
}
(globalThis as { Date: unknown }).Date = FakeDate;
const now = new Date();
const inHours = (h: number) => new Date(MIDNIGHT_RUN + h * HOUR).toISOString();

function nhlGame(id: string, commenceTime: string, sportKey = "icehockey_nhl"): OddsGame {
  return {
    id,
    sportKey,
    homeTeam: "Edmonton Oilers",
    awayTeam: "Calgary Flames",
    commenceTime,
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: "Edmonton Oilers", price: -150 }] }] }],
  };
}

const sample = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-nhl-goal-scorer-sample.json"), "utf8"));
// The sample's bookmakers with a 3-way market added to each: a game that
// carries both event-level markets, and what a request for both returns.
const both: OddsGame["bookmakers"] = (sample.bookmakers as OddsGame["bookmakers"]).map((b) => ({
  ...b,
  markets: [
    ...b.markets,
    { key: "h2h_3_way", outcomes: [{ name: "Edmonton Oilers", price: 115 }, { name: "Calgary Flames", price: 210 }, { name: "Draw", price: 310 }] },
  ],
}));
const hasGoalMarket = (g: OddsGame | undefined) => !!g?.bookmakers.some((b) => b.markets.some((m) => m.key === "player_goal_scorer_anytime"));

async function main() {
  // =====================================================================
  // 1. resolveAnytimeGoalOddsFromGame - pure, against the sample response
  // =====================================================================
  const sampleGame: OddsGame = {
    id: sample.id,
    sportKey: sample.sport_key,
    homeTeam: sample.home_team,
    awayTeam: sample.away_team,
    commenceTime: sample.commence_time,
    bookmakers: sample.bookmakers,
  };
  expect("resolve: McDavid -> first bookmaker's Yes price", resolveAnytimeGoalOddsFromGame(sampleGame, "Connor McDavid"), 105);
  expect("resolve: a player only the second bookmaker lists", resolveAnytimeGoalOddsFromGame(sampleGame, "Ryan Nugent-Hopkins"), 240);
  expect("resolve: player not offered -> null", resolveAnytimeGoalOddsFromGame(sampleGame, "Nobody Realname"), null);
  expect("resolve: a No-only listing is never read as the Yes price", resolveAnytimeGoalOddsFromGame(sampleGame, "Evan Bouchard"), null);
  expect("resolve: a game with no goal-scorer market -> null", resolveAnytimeGoalOddsFromGame(nhlGame("x", inHours(5)), "Connor McDavid"), null);

  // The same matcher against the REAL response captured 2026-10-12 (Ottawa
  // Senators @ New Jersey Devils, trimmed to two bookmakers x eight outcomes).
  const live = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-nhl-goal-scorer-response.json"), "utf8"));
  const liveGame: OddsGame = {
    id: live.id,
    sportKey: live.sport_key,
    homeTeam: live.home_team,
    awayTeam: live.away_team,
    commenceTime: live.commence_time,
    bookmakers: live.bookmakers,
  };
  const liveOutcomes = (live.bookmakers as OddsGame["bookmakers"]).flatMap((b) => b.markets.flatMap((m) => m.outcomes));
  expect(
    "live capture: every outcome is { name: 'Yes', description, price } with no point",
    liveOutcomes.every((o) => o.name === "Yes" && !!o.description && typeof o.price === "number" && o.point === undefined),
    true
  );
  expect("live capture: Jack Hughes -> draftkings +145", resolveAnytimeGoalOddsFromGame(liveGame, "Jack Hughes"), 145);
  expect("live capture: 'Tim Stutzle' typed without the umlaut matches 'Tim Stützle'", resolveAnytimeGoalOddsFromGame(liveGame, "Tim Stutzle"), 225);
  expect("live capture: Luke Hughes is not in the trimmed capture and is not priced as Jack Hughes", resolveAnytimeGoalOddsFromGame(liveGame, "Luke Hughes"), null);

  // The 3-way moneyline against the REAL h2h_3_way response captured
  // 2026-10-12 (Vegas Golden Knights @ Minnesota Wild, three bookmakers kept).
  const live3 = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-nhl-3way-response.json"), "utf8"));
  const twoWay = { key: "h2h", outcomes: [{ name: live3.home_team, price: -125 }, { name: live3.away_team, price: 105 }] };
  const live3Game: OddsGame = {
    id: live3.id,
    sportKey: live3.sport_key,
    homeTeam: live3.home_team,
    awayTeam: live3.away_team,
    commenceTime: live3.commence_time,
    bookmakers: (live3.bookmakers as OddsGame["bookmakers"]).map((b) => ({ ...b, markets: [twoWay, ...b.markets] })),
  };
  expect(
    "3-way live capture: every market is exactly home / away / Draw",
    (live3.bookmakers as OddsGame["bookmakers"]).every((b) =>
      b.markets.every((m) => m.key === "h2h_3_way" && JSON.stringify(m.outcomes.map((o) => o.name)) === JSON.stringify([live3.home_team, live3.away_team, "Draw"]))
    ),
    true
  );
  expect(
    "3-way: home / away / draw prices from the first bookmaker",
    [resolveThreeWayOddsFromGame(live3Game, "HOME"), resolveThreeWayOddsFromGame(live3Game, "AWAY"), resolveThreeWayOddsFromGame(live3Game, "DRAW")],
    [140, 140, 300]
  );
  const twoWayOnly: OddsGame = { ...live3Game, bookmakers: live3Game.bookmakers.map((b) => ({ ...b, markets: [twoWay] })) };
  expect(
    "3-way: a game with only the 2-way h2h market has no 3-way price - never the 2-way one",
    [resolveThreeWayOddsFromGame(twoWayOnly, "HOME"), resolveThreeWayOddsFromGame(twoWayOnly, "AWAY"), resolveThreeWayOddsFromGame(twoWayOnly, "DRAW")],
    [null, null, null]
  );
  const noDrawFirst: OddsGame = {
    ...live3Game,
    bookmakers: [
      { key: "odd", title: "Odd", markets: [{ key: "h2h_3_way", outcomes: [{ name: live3.home_team, price: -999 }, { name: live3.away_team, price: 999 }] }] },
      ...live3Game.bookmakers,
    ],
  };
  expect("3-way: a market with no Draw outcome is not a 3-way market and is skipped", resolveThreeWayOddsFromGame(noDrawFirst, "HOME"), 140);

  // =====================================================================
  // 2. nhlGamesNeedingGoalScorerOdds - the 24-hour window
  // =====================================================================
  expect("window: the lookahead is 24 hours", NHL_GOAL_SCORER_LOOKAHEAD_MS, 24 * HOUR);
  const alreadyHas = { ...nhlGame("hasIt", inHours(6)), bookmakers: both };
  const slate = [
    nhlGame("started", inHours(-1)),
    nhlGame("tonight", inHours(19)),
    nhlGame("lateTonight", inHours(22.5)),
    nhlGame("tomorrow", inHours(43)),
    nhlGame("nextWeek", inHours(150)),
    alreadyHas,
  ];
  expect(
    "window: only not-started games inside 24h that lack the market qualify",
    nhlGamesNeedingGoalScorerOdds(slate, now).map((g) => g.id),
    ["tonight", "lateTonight"]
  );
  // The afternoon run: 24 hours from 12:30 PM ET reaches tomorrow's matinee,
  // which must wait for tomorrow's own row.
  const tomorrowMatinee = nhlGame("tomorrowMatinee", "2026-10-14T16:00:00Z");
  const boughtAtMidnight = { ...nhlGame("tonight", inHours(19)), bookmakers: both };
  // The usual midnight result: the 3-way moneyline is up, the goal scorers are not.
  const threeWayOnly = {
    ...nhlGame("lateTonight", inHours(22.5)),
    bookmakers: both.map((b) => ({ ...b, markets: b.markets.filter((m) => m.key === "h2h_3_way") })),
  };
  expect(
    "window (afternoon run): only today's games still lacking the market - not one bought at midnight, not tomorrow's matinee",
    nhlGamesNeedingGoalScorerOdds([boughtAtMidnight, threeWayOnly, tomorrowMatinee], new Date(AFTERNOON_RUN)).map((g) => g.id),
    ["lateTonight"]
  );

  // =====================================================================
  // 3. seedNhlGoalScorerOddsForToday
  // =====================================================================
  const realApiKey = process.env.ODDS_API_KEY;

  // 3a. No API key -> no DB read, no fetch.
  delete process.env.ODDS_API_KEY;
  stubEventOddsFetch({});
  patch("oddsSnapshot.findUnique", async () => {
    throw new Error("should not read the snapshot when there's no API key");
  });
  expect("seed: no ODDS_API_KEY -> no_api_key", (await seedNhlGoalScorerOddsForToday()).status, "no_api_key");
  restorePrisma();
  restoreFetch();

  process.env.ODDS_API_KEY = "test-key";

  // 3b. No snapshot row today.
  patch("oddsSnapshot.findUnique", async () => null);
  stubEventOddsFetch({});
  expect("seed: no snapshot row today -> no_snapshot", (await seedNhlGoalScorerOddsForToday()).status, "no_snapshot");
  restorePrisma();
  restoreFetch();

  // 3c. Nothing inside the window -> no fetch, no write.
  let writes = 0;
  patch("oddsSnapshot.findUnique", async () => ({ data: [nhlGame("started", inHours(-1)), nhlGame("tomorrow", inHours(43)), alreadyHas] }));
  patch("oddsSnapshot.update", async () => {
    writes++;
    return {};
  });
  stubEventOddsFetch({});
  const idle = await seedNhlGoalScorerOddsForToday();
  expect("seed: started / beyond 24h / already-bought games -> no_games_to_fetch", idle.status, "no_games_to_fetch");
  expect("seed: ... with zero fetch calls and no snapshot write", [fetchCalls.length, writes], [0, 0]);
  restorePrisma();
  restoreFetch();

  // 3d. Happy path: the two games inside the window are bought, nothing else.
  let usageWrites: Record<string, unknown>[] = [];
  let updated: OddsGame[] | null = null;
  const requestedSnapshotKeys: string[] = [];
  patch("oddsSnapshot.findUnique", async (args: { where: { sportKey_fetchDate: { sportKey: string } } }) => {
    requestedSnapshotKeys.push(args.where.sportKey_fetchDate.sportKey);
    return { data: slate };
  });
  patch("oddsSnapshot.update", async ({ data }: { data: { data: OddsGame[] } }) => {
    updated = data.data;
    return {};
  });
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 }));
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async ({ data }: { data: Record<string, unknown> }) => {
    usageWrites.push(data);
    return { id: "row", ...data };
  });
  stubEventOddsFetch({
    tonight: { ok: true, headers: { "x-requests-remaining": "18999", "x-requests-used": "1001" }, body: { ...sample, id: "tonight", bookmakers: both } },
    lateTonight: { ok: true, headers: { "x-requests-remaining": "18998", "x-requests-used": "1002" }, body: { ...sample, id: "lateTonight", bookmakers: both } },
    // No route for started / tomorrow / nextWeek / hasIt - a request for any of them throws.
  });
  const happy = await seedNhlGoalScorerOddsForToday();
  expect("seed: reads the NHL snapshot row", requestedSnapshotKeys, ["icehockey_nhl"]);
  expect("seed: happy path status and counts", [happy.status, happy.eventsFetched, happy.eventsFailed], ["seeded", 2, 0]);
  expect("seed: one request per game inside the window, none for the rest", fetchCalls.length, 2);
  expect(
    "seed: ONE request per game asks the NHL event endpoint for both markets and nothing else",
    fetchCalls[0],
    "https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/tonight/odds?apiKey=REDACTED&regions=us&markets=player_goal_scorer_anytime,h2h_3_way&oddsFormat=american"
  );
  expect(
    "seed: one odds_api_usage_log row per call, filed under NHL with the markets asked for",
    usageWrites.map((w) => [w.sportKey, w.marketsRequested, w.eventsRequested, w.creditsUsed, w.creditsRemaining]),
    [
      ["icehockey_nhl", "player_goal_scorer_anytime,h2h_3_way", 1, 1001, 18999],
      ["icehockey_nhl", "player_goal_scorer_anytime,h2h_3_way", 1, 1002, 18998],
    ]
  );
  const persisted = (updated ?? []) as OddsGame[];
  expect("seed: the re-persisted row still holds every game, in order", persisted.map((g) => g.id), slate.map((g) => g.id));
  expect(
    "seed: only the two fetched games gained the market",
    persisted.filter((g) => g.id !== "hasIt" && hasGoalMarket(g)).map((g) => g.id),
    ["tonight", "lateTonight"]
  );
  expect(
    "seed: every other game is byte-for-byte untouched",
    persisted.filter((g) => g.id !== "tonight" && g.id !== "lateTonight"),
    slate.filter((g) => g.id !== "tonight" && g.id !== "lateTonight")
  );
  expect("seed: a fetched game keeps its game-lines market", persisted.find((g) => g.id === "tonight")?.bookmakers[0].markets.map((m) => m.key), ["h2h", "player_goal_scorer_anytime", "h2h_3_way"]);
  expect("seed: and is now priced", resolveAnytimeGoalOddsFromGame(persisted.find((g) => g.id === "tonight") as OddsGame, "Connor McDavid"), 105);

  // 3e. A second run the same day over the enriched row buys nothing.
  patch("oddsSnapshot.findUnique", async () => ({ data: persisted }));
  stubEventOddsFetch({});
  const second = await seedNhlGoalScorerOddsForToday();
  expect("seed: re-running over the enriched row makes zero calls", [second.status, fetchCalls.length], ["no_games_to_fetch", 0]);
  restoreFetch();

  // 3e2. The afternoon run: one game got both markets at midnight, one got
  //      only the 3-way moneyline (goal scorers weren't posted yet). Only the
  //      incomplete game is asked for again, and only for the market it still
  //      lacks - the 3-way moneyline it already has is not bought twice.
  //      Tomorrow's matinee is left for tomorrow.
  clock = AFTERNOON_RUN;
  usageWrites = [];
  updated = null;
  patch("oddsSnapshot.findUnique", async () => ({ data: [boughtAtMidnight, threeWayOnly, tomorrowMatinee] }));
  stubEventOddsFetch({
    lateTonight: { ok: true, headers: { "x-requests-remaining": "18997", "x-requests-used": "1003" }, body: { ...sample, id: "lateTonight" } },
  });
  const afternoon = await seedNhlGoalScorerOddsForToday();
  expect("afternoon run: one call, for the game still missing the market", [afternoon.status, afternoon.eventsFetched, fetchCalls.length], ["seeded", 1, 1]);
  expect("afternoon run: asks only for the market the game still lacks", fetchCalls[0].includes("&markets=player_goal_scorer_anytime&"), true);
  expect("afternoon run: logged to odds_api_usage_log like the midnight run", usageWrites.map((w) => [w.sportKey, w.marketsRequested, w.eventsRequested]), [["icehockey_nhl", "player_goal_scorer_anytime", 1]]);
  expect(
    "afternoon run: the game now carries both markets, its 3-way price untouched",
    [missingMarkets(((updated ?? []) as OddsGame[])[1]), resolveThreeWayOddsFromGame({ ...((updated ?? []) as OddsGame[])[1] }, "DRAW")],
    [[], 310]
  );
  expect(
    "afternoon run: the late game is now priced, the others are untouched",
    [hasGoalMarket(((updated ?? []) as OddsGame[])[1]), ((updated ?? []) as OddsGame[])[0], ((updated ?? []) as OddsGame[])[2]],
    [true, boughtAtMidnight, tomorrowMatinee]
  );
  restoreFetch();

  // An empty response (books haven't posted): the call succeeded and the game
  // simply still lacks the market, so the next run asks again.
  patch("oddsSnapshot.findUnique", async () => ({ data: [nhlGame("lateTonight", inHours(22.5))] }));
  stubEventOddsFetch({ lateTonight: { ok: true, headers: { "x-requests-remaining": "18997", "x-requests-used": "1003" }, body: { id: "lateTonight", bookmakers: [] } } });
  await seedNhlGoalScorerOddsForToday();
  expect("empty response: the game still qualifies for the next run", nhlGamesNeedingGoalScorerOdds((updated ?? []) as OddsGame[], new Date(AFTERNOON_RUN)).map((g) => g.id), ["lateTonight"]);
  restoreFetch();
  clock = MIDNIGHT_RUN;

  // 3f. Credit gate at >=95%: nothing fetched, nothing written.
  writes = 0;
  patch("oddsSnapshot.findUnique", async () => ({ data: slate }));
  patch("oddsSnapshot.update", async () => {
    writes++;
    return {};
  });
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 19500, creditsRemaining: 500 }));
  stubEventOddsFetch({});
  const gated = await seedNhlGoalScorerOddsForToday();
  expect("seed: credit gate skips both games", [gated.status, gated.eventsSkippedCreditGate, fetchCalls.length, writes], ["nothing_fetched", 2, 0, 0]);
  restoreFetch();

  // 3g. A preseason-listed game is requested under its own Odds API key.
  patch("oddsSnapshot.findUnique", async () => ({ data: [nhlGame("pre", inHours(10), "icehockey_nhl_preseason")] }));
  patch("oddsSnapshot.update", async () => ({}));
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 }));
  usageWrites = [];
  stubEventOddsFetch({ pre: { ok: true, headers: { "x-requests-remaining": "18997", "x-requests-used": "1003" }, body: { ...sample, id: "pre" } } });
  await seedNhlGoalScorerOddsForToday();
  expect("seed: preseason game uses the preseason key in the URL", fetchCalls[0].includes("/sports/icehockey_nhl_preseason/events/pre/odds"), true);
  expect("seed: ... and is still logged under the app's NHL key", usageWrites.map((w) => w.sportKey), ["icehockey_nhl"]);
  restoreFetch();

  // =====================================================================
  // 4. NFL request through the shared loop is unchanged
  // =====================================================================
  usageWrites = [];
  stubEventOddsFetch({ nflEvt: { ok: true, headers: { "x-requests-remaining": "18990", "x-requests-used": "1010" }, body: { id: "nflEvt", bookmakers: [] } } });
  const nflGame: OddsGame = { ...nhlGame("nflEvt", inHours(150)), sportKey: "americanfootball_nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Denver Broncos" };
  const nfl = await fetchAndMergeNflPropOdds([nflGame], "test-key");
  expect("NFL: still fetched a week out (no 24h window on the NFL path)", nfl.eventsFetched, 1);
  expect(
    "NFL: request URL is exactly what it was",
    fetchCalls[0],
    "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/nflEvt/odds?apiKey=REDACTED&regions=us&markets=player_pass_tds,player_pass_yds,player_pass_attempts,player_pass_completions,player_anytime_td,player_rush_yds,player_reception_yds,player_receptions,player_rush_reception_yds,player_pass_rush_yds&oddsFormat=american"
  );
  expect(
    "NFL: usage row is exactly what it was",
    usageWrites.map((w) => [w.sportKey, w.marketsRequested, w.eventsRequested]),
    [["americanfootball_nfl", "player_pass_tds,player_pass_yds,player_pass_attempts,player_pass_completions,player_anytime_td,player_rush_yds,player_reception_yds,player_receptions,player_rush_reception_yds,player_pass_rush_yds", 1]]
  );

  restorePrisma();
  restoreFetch();
  if (realApiKey === undefined) delete process.env.ODDS_API_KEY;
  else process.env.ODDS_API_KEY = realApiKey;

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
