// Alternate lines bought on demand at import (alt-line-odds.ts).
//
// Drives the REAL preview action (previewBulkImportMatches - the same
// resolveGameAndOdds the import stores from) over a snapshot that carries only
// main lines, with the Odds API's per-event endpoint stubbed. Before this
// existed every off-main line below came out at the -110 placeholder and no
// request was ever made; this file imports nothing that didn't exist then, so
// it runs (and fails) against that code too.
//
// The alternate-market data is __fixtures__/odds-api-event-alt-lines-response.json:
// a REAL response captured 2026-10-12 (Buffalo Bills @ Los Angeles Rams),
// trimmed to three bookmakers and a few points each. The snapshot's main lines
// are made up.
//
// No database and no network: the prisma delegates this path touches are
// swapped for in-memory fakes and global fetch is a stub. NEVER remove the
// "unexpected fetch" throw below: an accidental real call here would spend
// real credits. Listed in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs.
// Run with:
//   npx tsx src/server/data/alt-line-odds-on-demand-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolvePickPrice } from "@/lib/odds-source";
import type { OddsGame } from "./odds";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.DEV_AUTH_BYPASS = "true";
env.ODDS_API_KEY = "test-key-never-sent-anywhere";
// The import's wait for a slow request. Short here so the timeout case is quick.
env.ALT_LINE_ODDS_TIMEOUT_MS = "300";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// Frozen a few minutes after the capture, well before any game below starts.
const base = Date.parse("2026-10-12T17:30:00Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(base);
    else super(...(args as [string]));
  }
  static now() {
    return base;
  }
}
(globalThis as { Date: unknown }).Date = FakeDate;
const at = (hours: number) => new RealDate(base + hours * 3600000).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the snapshot: main lines only ----
const NFL = "americanfootball_nfl";
const capture = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-alt-lines-response.json"), "utf8"));

function game(id: string, home: string, away: string, commenceTime: string, total: number, homeSpread: number): OddsGame {
  const book = (key: string, juice: number) => ({
    key,
    title: key,
    markets: [
      { key: "h2h", outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
      { key: "spreads", outcomes: [{ name: home, price: juice, point: homeSpread }, { name: away, price: juice, point: -homeSpread }] },
      { key: "totals", outcomes: [{ name: "Over", price: juice, point: total }, { name: "Under", price: juice, point: total }] },
    ],
  });
  return { id, sportKey: NFL, homeTeam: home, awayTeam: away, commenceTime, bookmakers: [book("draftkings", -108), book("fanduel", -112)] };
}
const RAMS = capture.id as string;
const SNAPSHOT: OddsGame[] = [
  game(RAMS, capture.home_team, capture.away_team, capture.commence_time, 47.5, 2.5),
  game("nfl-den-kc", "Kansas City Chiefs", "Denver Broncos", at(9), 44.5, -3.5),
  game("nfl-tb-dal", "Dallas Cowboys", "Tampa Bay Buccaneers", at(10), 46.5, -1.5),
  game("nfl-sf-sea", "Seattle Seahawks", "San Francisco 49ers", at(11), 45.5, 1.5),
  game("nfl-gb-chi", "Chicago Bears", "Green Bay Packers", at(12), 42.5, 2.5),
];

// ---- prisma fakes ----
function stub(model: string, methods: Record<string, unknown>) {
  const client = prisma as unknown as Record<string, Record<string, unknown> | undefined>;
  Object.assign((client[model] ??= {}), methods);
}

stub("oddsSnapshot", {
  findUnique: async (args: { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }) => {
    const { sportKey, fetchDate } = args.where.sportKey_fetchDate;
    return sportKey === NFL ? { id: "snap-nfl", sportKey, fetchDate, data: SNAPSHOT, createdAt: new Date(base) } : null;
  },
});
stub("user", {
  findUnique: async () => ({ id: "user-alt-line-test", supabaseId: "dev-local-bypass", email: "dev-local@bettingview.test", name: "Local Dev Test User" }),
});

// odds_alt_line_fetches, with its unique (eventId, marketKey, fetchDate) key.
type AltRow = { eventId: string; marketKey: string; fetchDate: string; sportKey: string; bookmakers: unknown };
const altRows = new Map<string, AltRow>();
let altTableCalls = 0;
const rowKey = (k: { eventId: string; marketKey: string; fetchDate: string }) => [k.eventId, k.marketKey, k.fetchDate].join("|");
stub("oddsAltLineFetch", {
  findUnique: async (args: { where: { eventId_marketKey_fetchDate: AltRow } }) => {
    altTableCalls++;
    return altRows.get(rowKey(args.where.eventId_marketKey_fetchDate)) ?? null;
  },
  create: async (args: { data: AltRow }) => {
    altTableCalls++;
    if (altRows.has(rowKey(args.data))) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }
    altRows.set(rowKey(args.data), { ...args.data, bookmakers: null });
    return args.data;
  },
  update: async (args: { where: { eventId_marketKey_fetchDate: AltRow }; data: { bookmakers: unknown } }) => {
    altTableCalls++;
    const row = altRows.get(rowKey(args.where.eventId_marketKey_fetchDate));
    if (!row) throw new Error("update of a row that does not exist");
    row.bookmakers = args.data.bookmakers;
    return row;
  },
  deleteMany: async (args: { where: AltRow }) => {
    altTableCalls++;
    return { count: altRows.delete(rowKey(args.where)) ? 1 : 0 };
  },
});
const rowsFor = (eventId: string) => [...altRows.values()].filter((r) => r.eventId === eventId).map((r) => r.marketKey);

// odds_api_usage_log. `gateRow` stands in for the latest row when set.
type UsageRow = { sportKey: string; marketsRequested: string; eventsRequested: number; creditsUsed: number | null; creditsRemaining: number | null };
const usageRows: UsageRow[] = [];
let gateRow: { creditsUsed: number; creditsRemaining: number } | null = null;
stub("oddsApiUsageLog", {
  findFirst: async () => gateRow ?? usageRows[usageRows.length - 1] ?? null,
  count: async () => usageRows.length,
  create: async (args: { data: UsageRow }) => {
    usageRows.push(args.data);
    return args.data;
  },
});

// ---- the Odds API ----
const OK_HEADERS = { "content-type": "application/json", "x-requests-remaining": "17385", "x-requests-used": "2615", "x-requests-last": "1" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: OK_HEADERS });
// The capture, cut to the market asked for - what a one-market request returns.
function captured(market: string) {
  type Book = OddsGame["bookmakers"][number];
  const bookmakers = (capture.bookmakers as Book[])
    .map((b) => ({ ...b, markets: b.markets.filter((m) => m.key === market) }))
    .filter((b) => b.markets.length > 0);
  return ok({ ...capture, bookmakers });
}

// eventId -> how that event's request is answered. Any other Odds API URL throws.
const routes: Record<string, (market: string) => Promise<Response> | Response> = {};
const oddsApiCalls: { eventId: string; market: string; url: string }[] = [];
const callsFor = (eventId: string) => oddsApiCalls.filter((c) => c.eventId === eventId).map((c) => c.market);
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("the-odds-api.com")) {
    // Empty ESPN scoreboard ({ events }) and empty MLB schedule ({ dates }).
    return new Response(JSON.stringify({ events: [], dates: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const redacted = url.replace(/apiKey=[^&]+/, "apiKey=REDACTED");
  const eventId = /\/events\/([^/]+)\/odds/.exec(url)?.[1] ?? "";
  const market = /[?&]markets=([^&]+)/.exec(url)?.[1] ?? "";
  if (!routes[eventId]) throw new Error("unexpected fetch (would have spent real credits): " + redacted);
  oddsApiCalls.push({ eventId, market, url: redacted });
  return routes[eventId](market);
}) as typeof fetch;

// ---- lines ----
type Item = {
  sportName: string;
  betType: "SPREAD" | "TOTAL";
  hasExplicitOdds: boolean;
  odds: number;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  description: string;
  gameNumber: null;
  period: string;
};
const total = (teams: [string, string], side: "over" | "under", line: number, extra: Partial<Item> = {}): Item => ({
  sportName: "NFL",
  betType: "TOTAL",
  hasExplicitOdds: false,
  odds: -110,
  totalSide: side,
  teamNicknames: teams,
  description: `${teams[0]} ${teams[1]} ${side === "over" ? "Over" : "Under"} ${line}`,
  gameNumber: null,
  period: "FULL_GAME",
  ...extra,
});
const spread = (team: string, line: string): Item => ({
  sportName: "NFL",
  betType: "SPREAD",
  hasExplicitOdds: false,
  odds: -110,
  teamNicknames: [team],
  description: `${team} ${line}`,
  gameNumber: null,
  period: "FULL_GAME",
});
const DEFAULTED = { odds: -110, oddsSource: "DEFAULTED" };
const market = (odds: number) => ({ odds, oddsSource: "MARKET" });

async function main() {
  // The action module pulls in server/auth.ts, which wraps getCurrentUser in
  // React's server-only cache(); plain Node's React has none, so shim it (identity).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = require("react") as { cache?: unknown };
  react.cache ??= <T,>(fn: T) => fn;
  const { previewBulkImportMatches } = await import("@/server/actions/bulk-picks");

  // What the import stores for each line of one paste.
  async function importAs(items: Item[]) {
    const preview = await previewBulkImportMatches(items as never);
    // (The preview never resolves a line that states its own price.)
    const unmatched = items.filter((item, i) => !item.hasExplicitOdds && !preview.games[i]);
    expect(`  every line matched its game (${items.map((i) => i.description).join(" / ")})`, unmatched.length, 0);
    return items.map((item, i) => resolvePickPrice(item, preview.odds[i] ?? null));
  }

  // ---- 1. Over 35.5 against a 47.5 main total: the real alternate price ----
  routes[RAMS] = captured;
  expect("Over 35.5 gets the capture's alternate price", await importAs([total(["bills", "rams"], "over", 35.5)]), [market(-2600)]);
  expect("one request, for alternate_totals only", callsFor(RAMS), ["alternate_totals"]);
  expect(
    "it is the per-event endpoint, one region",
    oddsApiCalls[0]?.url,
    `https://api.the-odds-api.com/v4/sports/${NFL}/events/${RAMS}/odds?apiKey=REDACTED&regions=us&markets=alternate_totals&oddsFormat=american`
  );
  expect("the call is logged to odds_api_usage_log", usageRows, [
    { sportKey: NFL, pollTimestamp: new Date(base).toISOString(), creditsUsed: 2615, creditsRemaining: 17385, requestsToday: 1, requestsMonth: 1, marketsRequested: "alternate_totals", eventsRequested: 1 },
  ]);

  // ---- 2. a second pick on the same game does not fetch again ----
  expect(
    "later picks on that game are priced from the stored response",
    await importAs([total(["bills", "rams"], "under", 41.5), total(["bills", "rams"], "over", 27.5)]),
    // 27.5 is hung by the second book only - every bookmaker is checked.
    [market(401), market(-20000)]
  );
  expect("still one request for the game's totals", callsFor(RAMS), ["alternate_totals"]);

  // Two spread picks in ONE paste resolve concurrently: one request between them.
  expect(
    "two alternate spreads in one paste",
    await importAs([spread("bills", "+10.5"), spread("rams", "-14.5"), spread("rams", "-15")]),
    // -15 is hung by the third book only.
    [market(-292), market(296), market(450)]
  );
  expect("alternate_spreads was bought once, and only when a spread needed it", callsFor(RAMS), ["alternate_totals", "alternate_spreads"]);
  expect("one usage row per call", usageRows.map((r) => r.marketsRequested), ["alternate_totals", "alternate_spreads"]);

  // ---- 3. a line the alternate market doesn't carry stays DEFAULTED ----
  expect(
    "missing point, and a point offered on the other side only",
    await importAs([total(["bills", "rams"], "over", 38.5), spread("bills", "-15")]),
    [DEFAULTED, DEFAULTED]
  );
  expect("and asking for them fetched nothing", oddsApiCalls.length, 2);

  // ---- 4. picks that never go to the alternate market ----
  expect(
    "main line, stated price, first half",
    await importAs([
      total(["bills", "rams"], "over", 47.5),
      total(["broncos", "chiefs"], "over", 30.5, { hasExplicitOdds: true, odds: 250 }),
      total(["broncos", "chiefs"], "over", 20.5, { period: "FIRST_HALF" }),
    ]),
    [market(-108), { odds: 250, oddsSource: "STATED" }, DEFAULTED]
  );
  expect("none of them made a request", oddsApiCalls.length, 2);

  // ---- 5. a slow call: the import does not wait for it ----
  let releaseSlow!: () => void;
  const slowDone = new Promise<void>((resolve) => (releaseSlow = resolve));
  routes["nfl-den-kc"] = async (m) => {
    await sleep(1200);
    setTimeout(releaseSlow, 50);
    return captured(m);
  };
  const started = performance.now();
  const slow = await importAs([total(["broncos", "chiefs"], "over", 35.5), total(["bills", "rams"], "over", 47.5)]);
  const waited = performance.now() - started;
  expect("timeout: the pick falls back to DEFAULTED, the rest of the paste is priced", slow, [DEFAULTED, market(-108)]);
  expect("timeout: the import returned without waiting for the response", waited < 1000, true);
  expect("while it is still in flight, another pick does not fetch again", await importAs([total(["broncos", "chiefs"], "under", 41.5)]), [DEFAULTED]);
  await slowDone;
  expect("once the late response lands it prices the next pick", await importAs([total(["broncos", "chiefs"], "over", 35.5)]), [market(-2600)]);
  expect("all on one request", callsFor("nfl-den-kc"), ["alternate_totals"]);

  // ---- 6. a failed call: DEFAULTED now, and nothing was bought so it may retry ----
  routes["nfl-tb-dal"] = () => {
    throw new Error("socket hang up");
  };
  expect("network error -> DEFAULTED", await importAs([total(["buccaneers", "cowboys"], "over", 35.5)]), [DEFAULTED]);
  routes["nfl-tb-dal"] = () => new Response("upstream down", { status: 500, headers: OK_HEADERS });
  expect("HTTP 500 -> DEFAULTED", await importAs([total(["buccaneers", "cowboys"], "over", 35.5)]), [DEFAULTED]);
  expect("a failed request leaves no row behind", rowsFor("nfl-tb-dal"), []);
  routes["nfl-tb-dal"] = captured;
  expect("the next import tries again and is priced", await importAs([total(["buccaneers", "cowboys"], "over", 35.5)]), [market(-2600)]);
  expect("three attempts, then no more", [callsFor("nfl-tb-dal").length, (await importAs([total(["buccaneers", "cowboys"], "under", 35.5)]))[0], callsFor("nfl-tb-dal").length], [3, market(830), 3]);

  // ---- 7. an empty response is free, and is still only asked for once ----
  routes["nfl-sf-sea"] = () => ok({ id: "nfl-sf-sea", bookmakers: [] });
  expect("no bookmaker offers it -> DEFAULTED", await importAs([total(["49ers", "seahawks"], "over", 30.5)]), [DEFAULTED]);
  expect("asked again -> DEFAULTED", await importAs([total(["49ers", "seahawks"], "under", 60.5)]), [DEFAULTED]);
  expect("one request", callsFor("nfl-sf-sea"), ["alternate_totals"]);

  // ---- 8. the 95% credit gate ----
  routes["nfl-gb-chi"] = captured;
  gateRow = { creditsUsed: 19100, creditsRemaining: 900 };
  expect("at 95.5% used the pick stays DEFAULTED", await importAs([total(["packers", "bears"], "over", 35.5)]), [DEFAULTED]);
  expect("and no request or row was made", [callsFor("nfl-gb-chi"), rowsFor("nfl-gb-chi")], [[], []]);
  gateRow = { creditsUsed: 18900, creditsRemaining: 1100 };
  expect("at 94.5% it is bought", await importAs([total(["packers", "bears"], "over", 35.5)]), [market(-2600)]);
  gateRow = null;

  // ---- 9. no API key: nothing is read or requested ----
  delete env.ODDS_API_KEY;
  const before = [oddsApiCalls.length, altTableCalls];
  expect("no key -> DEFAULTED", await importAs([total(["bills", "rams"], "over", 55.5)]), [DEFAULTED]);
  expect("no key -> no request and no table read", [oddsApiCalls.length, altTableCalls], before);

  // ---- 10. the import itself uses the same switch as the preview ----
  const source = readFileSync(join(__dirname, "..", "actions", "bulk-picks.ts"), "utf8");
  expect("wiring: the import resolves with altLines on", /resolveGameAndOdds\(item, loader, \{ retryOnMiss: false, altLines: true \}\)/.test(source), true);
  expect("wiring: only the import and the preview turn it on", (source.match(/altLines: true/g) ?? []).length, 2);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
