// Proof for nhl-goal-scorer-odds.ts: which NHL games the goal-scorer market is
// bought for, what the request looks like, what it logs to odds_api_usage_log,
// and that the NFL request built by the same shared loop is unchanged.
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

const HOUR = 3600000;
const now = new Date();
const inHours = (h: number) => new Date(now.getTime() + h * HOUR).toISOString();

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

  // =====================================================================
  // 2. nhlGamesNeedingGoalScorerOdds - the 24-hour window
  // =====================================================================
  expect("window: the lookahead is 24 hours", NHL_GOAL_SCORER_LOOKAHEAD_MS, 24 * HOUR);
  const alreadyHas = { ...nhlGame("hasIt", inHours(6)), bookmakers: sample.bookmakers };
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
    tonight: { ok: true, headers: { "x-requests-remaining": "18999", "x-requests-used": "1001" }, body: { ...sample, id: "tonight" } },
    lateTonight: { ok: true, headers: { "x-requests-remaining": "18998", "x-requests-used": "1002" }, body: { ...sample, id: "lateTonight" } },
    // No route for started / tomorrow / nextWeek / hasIt - a request for any of them throws.
  });
  const happy = await seedNhlGoalScorerOddsForToday();
  expect("seed: reads the NHL snapshot row", requestedSnapshotKeys, ["icehockey_nhl"]);
  expect("seed: happy path status and counts", [happy.status, happy.eventsFetched, happy.eventsFailed], ["seeded", 2, 0]);
  expect("seed: one request per game inside the window, none for the rest", fetchCalls.length, 2);
  expect(
    "seed: the request asks the NHL event endpoint for player_goal_scorer_anytime and nothing else",
    fetchCalls[0],
    "https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/tonight/odds?apiKey=REDACTED&regions=us&markets=player_goal_scorer_anytime&oddsFormat=american"
  );
  expect(
    "seed: one odds_api_usage_log row per call, filed under NHL with the one market",
    usageWrites.map((w) => [w.sportKey, w.marketsRequested, w.eventsRequested, w.creditsUsed, w.creditsRemaining]),
    [
      ["icehockey_nhl", "player_goal_scorer_anytime", 1, 1001, 18999],
      ["icehockey_nhl", "player_goal_scorer_anytime", 1, 1002, 18998],
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
  expect("seed: a fetched game keeps its game-lines market", persisted.find((g) => g.id === "tonight")?.bookmakers[0].markets.map((m) => m.key), ["h2h", "player_goal_scorer_anytime"]);
  expect("seed: and is now priced", resolveAnytimeGoalOddsFromGame(persisted.find((g) => g.id === "tonight") as OddsGame, "Connor McDavid"), 105);

  // 3e. A second run the same day over the enriched row buys nothing.
  patch("oddsSnapshot.findUnique", async () => ({ data: persisted }));
  stubEventOddsFetch({});
  const second = await seedNhlGoalScorerOddsForToday();
  expect("seed: re-running over the enriched row makes zero calls", [second.status, fetchCalls.length], ["no_games_to_fetch", 0]);
  restoreFetch();

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
