// FanDuel alternate ladders for Consensus Hybrid (alt-ladders.ts).
//
// Drives the REAL getAltLadders over in-memory fakes of the prisma delegates it
// touches and a stubbed global fetch. The responses are the real FanDuel event
// capture lib/parlay/__fixtures__/fanduel-event-nfl.json (Denver Broncos @
// Seattle Seahawks): its alternate_spreads (40 outcomes), alternate_totals (26)
// and h2h, each with sid and betslip link, filtered to the markets a request
// names, as the real endpoint does. Two things are added to the capture because
// the committed copy was trimmed of them: a market-level last_update, and a second
// bookmaker (the endpoint is asked for fanduel only, so a real response would
// not carry one; it is here to prove the trim ignores it).
//
// No database and no network. NEVER remove the "unexpected fetch" throw below: an
// accidental real call here would spend real credits. Listed in
// PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. No test waits a fixed
// time: concurrency is driven by promises the test settles itself, and the one
// timeout case waits on the code's own timeout (HYBRID_LADDER_TIMEOUT_MS).
// Run with:
//   npx tsx src/server/data/alt-ladders-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ODDS_API_KEY = "test-key-never-sent-anywhere";
env.HYBRID_LADDER_TIMEOUT_MS = "40";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const capture = JSON.parse(readFileSync(join(__dirname, "..", "..", "lib", "parlay", "__fixtures__", "fanduel-event-nfl.json"), "utf8"));
const EVENT = capture.id as string;
const SPORT = capture.sport_key as string;
const HOUR = 3600_000;

// ---- the clock: frozen, moved by the tests ----
const RealDate = Date;
let nowMs = Date.parse("2026-10-15T14:00:00Z");
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static now() {
    return nowMs;
  }
}
(globalThis as { Date: unknown }).Date = FakeDate;
const iso = (ms: number) => new RealDate(ms).toISOString();
// An event that starts `hours` from the frozen now.
const startsIn = (hours: number) => iso(nowMs + hours * HOUR);

// ---- prisma fakes ----
function stub(model: string, methods: Record<string, unknown>) {
  const client = prisma as unknown as Record<string, Record<string, unknown> | undefined>;
  Object.assign((client[model] ??= {}), methods);
}

// A where clause as these two tables are queried: equality, null, Date, {in}, {lt}, {gte}, {lt,gte}, AND, OR.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as unknown[]).every((w) => matches(row, w));
    if (k === "OR") return (v as unknown[]).some((w) => matches(row, w));
    const cell = row[k];
    if (v === null) return cell === null || cell === undefined;
    if (v instanceof RealDate) return cell instanceof RealDate && cell.getTime() === v.getTime();
    if (v && typeof v === "object") {
      const c = v as { in?: unknown[]; lt?: Date | number; gte?: Date | number; lte?: Date | number };
      const n = (x: unknown) => (x instanceof RealDate ? x.getTime() : (x as number));
      if (c.in && !c.in.includes(cell)) return false;
      if (c.lt !== undefined && !(cell != null && n(cell) < n(c.lt))) return false;
      if (c.gte !== undefined && !(cell != null && n(cell) >= n(c.gte))) return false;
      if (c.lte !== undefined && !(cell != null && n(cell) <= n(c.lte))) return false;
      return true;
    }
    return cell === v;
  });
}

type Ladder = { eventId: string; marketKey: string; commenceTime: Date; outcomes: unknown; fetchedAt: Date | null; marketLastUpdate: Date | null; claimedAt: Date | null };
let ladders: Ladder[] = [];
let ladderFailsRead = false;
const ladderStatements: string[] = [];
stub("oddsAltLadder", {
  findMany: async (args: { where: object }) => {
    ladderStatements.push("findMany");
    if (ladderFailsRead) throw new Error("db down");
    return ladders.filter((r) => matches(r, args.where)).map((r) => ({ ...r }));
  },
  createMany: async (args: { data: Partial<Ladder>[]; skipDuplicates: boolean }) => {
    ladderStatements.push("createMany");
    let count = 0;
    for (const d of args.data) {
      if (ladders.some((r) => r.eventId === d.eventId && r.marketKey === d.marketKey)) continue;
      ladders.push({ outcomes: null, fetchedAt: null, marketLastUpdate: null, claimedAt: null, ...d } as Ladder);
      count++;
    }
    return { count };
  },
  updateMany: async (args: { where: object; data: Partial<Ladder> }) => {
    ladderStatements.push("updateMany");
    const hit = ladders.filter((r) => matches(r, args.where));
    hit.forEach((r) => Object.assign(r, args.data));
    return { count: hit.length };
  },
  update: async (args: { where: { eventId_marketKey: { eventId: string; marketKey: string } }; data: Partial<Ladder> }) => {
    ladderStatements.push("update");
    const { eventId, marketKey } = args.where.eventId_marketKey;
    const row = ladders.find((r) => r.eventId === eventId && r.marketKey === marketKey);
    if (!row) throw new Error("update of a row that does not exist");
    Object.assign(row, args.data);
    return row;
  },
  deleteMany: async (args: { where: object }) => {
    ladderStatements.push("deleteMany");
    const before = ladders.length;
    ladders = ladders.filter((r) => !matches(r, args.where));
    return { count: before - ladders.length };
  },
});
const row = (market: string, eventId = EVENT) => ladders.find((r) => r.eventId === eventId && r.marketKey === market);

type UsageRow = {
  sportKey: string;
  pollTimestamp: Date;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  marketsRequested: string;
  eventsRequested: number;
  httpStatus: number | null;
  caller: string | null;
};
let usageRows: UsageRow[] = [];
let gateRow: { creditsUsed: number; creditsRemaining: number } | null = null;
let usageReads = 0;
stub("oddsApiUsageLog", {
  findFirst: async () => {
    usageReads++;
    return gateRow ?? usageRows[usageRows.length - 1] ?? null;
  },
  findMany: async (args: { where: object }) => {
    usageReads++;
    return usageRows.filter((r) => matches(r, args.where)).map((r) => ({ marketsRequested: r.marketsRequested }));
  },
  count: async () => usageRows.length,
  create: async (args: { data: UsageRow }) => {
    usageRows.push({ ...args.data, pollTimestamp: args.data.pollTimestamp ?? new RealDate(nowMs) });
    return args.data;
  },
});
const hybridRows = () => usageRows.filter((r) => r.caller === "hybrid-ladders");

// ---- the Odds API ----
const OK_HEADERS = { "content-type": "application/json", "x-requests-remaining": "17385", "x-requests-used": "2615", "x-requests-last": "2" };
type Book = { key: string; markets: { key: string; last_update?: string; outcomes: unknown[] }[] };
// What the event endpoint returns for the markets asked: the capture's FanDuel
// markets, cut to those, plus a draftkings copy that must never be stored.
function responseFor(markets: string[], eventId = EVENT) {
  const fd = (capture.bookmakers as Book[]).find((b) => b.key === "fanduel")!;
  const cut = fd.markets.filter((m) => markets.includes(m.key)).map((m) => ({ ...m, last_update: "2026-10-15T13:58:00Z" }));
  const dk = cut.map((m) => ({ ...m, outcomes: m.outcomes.map((o) => ({ ...(o as object), price: 9999, sid: "dk", link: "https://dk.example/" })) }));
  return { ...capture, id: eventId, bookmakers: [{ key: "draftkings", markets: dk }, { key: "fanduel", markets: cut }] };
}
type Call = { eventId: string; url: string; params: URLSearchParams };
let oddsApiCalls: Call[] = [];
// How the next Odds API request is answered. Default: the capture for the markets asked.
let answer: (call: Call) => Promise<Response> | Response = (call) => new Response(JSON.stringify(responseFor(call.params.get("markets")!.split(","), call.eventId)), { status: 200, headers: OK_HEADERS });
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("the-odds-api.com")) throw new Error("unexpected fetch: " + url);
  const u = new URL(url);
  const eventId = /\/events\/([^/]+)\/odds/.exec(u.pathname)?.[1];
  if (!eventId) throw new Error("unexpected Odds API fetch (would have spent real credits): " + u.pathname);
  u.searchParams.set("apiKey", "REDACTED");
  const call = { eventId, url: u.toString(), params: u.searchParams };
  oddsApiCalls.push(call);
  return answer(call);
}) as typeof fetch;

function reset() {
  ladders = [];
  usageRows = [];
  gateRow = null;
  usageReads = 0;
  oddsApiCalls = [];
  ladderStatements.length = 0;
  ladderFailsRead = false;
  nowMs = Date.parse("2026-10-15T14:00:00Z");
  answer = (call) => new Response(JSON.stringify(responseFor(call.params.get("markets")!.split(","), call.eventId)), { status: 200, headers: OK_HEADERS });
}
function seed(market: string, args: { fetchedAgoMs: number | null; commence: string; claimedAgoMs?: number; eventId?: string; outcomes?: unknown }) {
  ladders.push({
    eventId: args.eventId ?? EVENT,
    marketKey: market,
    commenceTime: new RealDate(args.commence),
    outcomes: args.outcomes === undefined ? [{ name: "Over", price: -110, point: 40.5, sid: "s", link: "l" }] : args.outcomes,
    fetchedAt: args.fetchedAgoMs === null ? null : new RealDate(nowMs - args.fetchedAgoMs),
    marketLastUpdate: null,
    claimedAt: args.claimedAgoMs === undefined ? null : new RealDate(nowMs - args.claimedAgoMs),
  });
}

async function main() {
  const { altLadderTtlMs, isAltLadderFresh, trimOutcomes, getAltLadders, HYBRID_DAILY_CREDIT_BUDGET, HYBRID_LADDER_CLAIM_MS } = await import("./alt-ladders");
  const SP = "alternate_spreads" as const;
  const TO = "alternate_totals" as const;
  const ML = "h2h" as const;
  const req = (markets: ("alternate_spreads" | "alternate_totals" | "h2h")[], hoursOut = 5, eventId = EVENT) => [{ eventId, sport: SPORT, commenceTime: startsIn(hoursOut), markets }];

  // ---- 1. freshness tiers, and the boundary at each ----
  {
    const m = 60_000;
    expect("tier: 24h and a millisecond out -> 6h", altLadderTtlMs(24 * HOUR + 1), 6 * HOUR);
    expect("tier: exactly 24h out -> 60 min", altLadderTtlMs(24 * HOUR), 60 * m);
    expect("tier: 3h exactly -> 60 min", altLadderTtlMs(3 * HOUR), 60 * m);
    expect("tier: a millisecond under 3h -> 15 min", altLadderTtlMs(3 * HOUR - 1), 15 * m);
    expect("tier: 30 min out -> 15 min", altLadderTtlMs(30 * m), 15 * m);
    const now = new RealDate("2026-10-15T14:00:00Z");
    const fresh = (hoursOut: number, ageMs: number) => isAltLadderFresh(new RealDate(now.getTime() + hoursOut * HOUR), new RealDate(now.getTime() - ageMs), now);
    expect("fresh: 30h out, 5h59m old", fresh(30, 6 * HOUR - m), true);
    expect("stale: 30h out, exactly 6h old", fresh(30, 6 * HOUR), false);
    expect("fresh: 10h out, 59m old", fresh(10, 59 * m), true);
    expect("stale: 10h out, exactly 60m old", fresh(10, 60 * m), false);
    expect("fresh: 2h out, 14m old", fresh(2, 14 * m), true);
    expect("stale: 2h out, exactly 15m old", fresh(2, 15 * m), false);
    expect("stale: never fetched", isAltLadderFresh(now, null, now), false);
    // The tier is read when asked: a ladder fetched 20 min ago is fresh at 5h out and stale once the game is 2h out.
    expect("same ladder, 5h out: fresh; 2h out: stale", [fresh(5, 20 * m), fresh(2, 20 * m)], [true, false]);
  }

  // ---- 2. trimming: only the fields later stages need ----
  {
    const trimmed = trimOutcomes([
      { name: "Over", description: "Denver Broncos", price: -295, point: 14.5, sid: "15290707", link: "https://x/y", bet_limit: 500, last_update: "2026-10-15T13:58:00Z" },
      { name: "Seattle Seahawks", price: 130, sid: "50211", link: "https://x/z" },
      { name: "no price" },
      { price: 100 },
      null,
    ]);
    expect("trim: keeps name/description/point/price/sid/link, drops the rest and the unusable", trimmed, [
      { name: "Over", price: -295, description: "Denver Broncos", point: 14.5, sid: "15290707", link: "https://x/y" },
      { name: "Seattle Seahawks", price: 130, sid: "50211", link: "https://x/z" },
    ]);
    expect("trim: not an array -> empty", trimOutcomes(undefined), []);
  }

  // ---- 3. a miss buys ONE per-event call carrying every market; FanDuel only; sid + link kept ----
  {
    reset();
    const got = await getAltLadders(req([SP, TO]));
    expect("miss: one Odds API call for two markets", oddsApiCalls.length, 1);
    const p = oddsApiCalls[0]?.params;
    expect("call: bookmakers=fanduel, includeSids, includeLinks, both markets, american", [p?.get("bookmakers"), p?.get("includeSids"), p?.get("includeLinks"), p?.get("markets"), p?.get("oddsFormat")], ["fanduel", "true", "true", "alternate_spreads,alternate_totals", "american"]);
    expect("call: h2h is not requested unless asked", p?.get("markets")?.includes("h2h"), false);
    expect("call: path is the event's odds endpoint under the caller's sport", new URL(oddsApiCalls[0].url).pathname, `/v4/sports/${SPORT}/events/${EVENT}/odds`);
    expect("result: both ladders, fresh", [got[EVENT]?.[SP]?.isStale, got[EVENT]?.[TO]?.isStale], [false, false]);
    expect("result: outcome counts are the capture's (40 spread, 26 total)", [got[EVENT]?.[SP]?.outcomes.length, got[EVENT]?.[TO]?.outcomes.length], [40, 26]);
    const first = got[EVENT]?.[SP]?.outcomes[0];
    expect("result: first spread outcome keeps sid and link", first, { name: "Denver Broncos", price: 560, point: -10.5, sid: "12291361", link: "https://sportsbook.fanduel.com/addToBetslip?marketId=42.615641993&selectionId=12291361" });
    const all = [...(got[EVENT]?.[SP]?.outcomes ?? []), ...(got[EVENT]?.[TO]?.outcomes ?? [])];
    expect("trim: FanDuel outcomes only (the draftkings copy was ignored)", all.some((o) => o.price === 9999 || o.sid === "dk"), false);
    expect("trim: every stored outcome has a sid and a link", all.every((o) => o.sid && o.link), true);
    expect("trim: only the six allowed fields are ever stored", [...new Set(all.flatMap((o) => Object.keys(o)))].sort(), ["link", "name", "point", "price", "sid"]);
    expect("stored: the row carries the same outcomes, fetchedAt and the book's last_update, and is unclaimed", [JSON.stringify(row(SP)?.outcomes) === JSON.stringify(got[EVENT]?.[SP]?.outcomes), row(SP)?.fetchedAt?.toISOString(), row(SP)?.marketLastUpdate?.toISOString(), row(SP)?.claimedAt], [true, iso(nowMs), "2026-10-15T13:58:00.000Z", null]);

    // The same ask a moment later is served from the table.
    oddsApiCalls = [];
    const again = await getAltLadders(req([SP, TO]));
    expect("hit: no second call", oddsApiCalls.length, 0);
    expect("hit: same ladders, still fresh", [again[EVENT]?.[SP]?.isStale, again[EVENT]?.[SP]?.outcomes.length], [false, 40]);
  }

  // ---- 4. h2h only when the caller asks ----
  {
    reset();
    const got = await getAltLadders(req([SP, TO, ML]));
    expect("h2h asked: still ONE call, three markets", [oddsApiCalls.length, oddsApiCalls[0]?.params.get("markets")], [1, "alternate_spreads,alternate_totals,h2h"]);
    expect("h2h: the moneyline ladder (2 outcomes with sid + link)", [got[EVENT]?.[ML]?.outcomes.length, got[EVENT]?.[ML]?.outcomes.every((o) => o.sid && o.link && o.point === undefined)], [2, true]);
    // Only the missing market is bought: spreads and totals are fresh, h2h is new.
    reset();
    seed(SP, { fetchedAgoMs: 60_000, commence: startsIn(5) });
    seed(TO, { fetchedAgoMs: 60_000, commence: startsIn(5) });
    await getAltLadders(req([SP, TO, ML]));
    expect("only the missing market is requested", oddsApiCalls.map((c) => c.params.get("markets")), ["h2h"]);
  }

  // ---- 5. two concurrent callers, one fetch ----
  {
    reset();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    answer = async (call) => {
      started();
      await gate;
      return new Response(JSON.stringify(responseFor(call.params.get("markets")!.split(","), call.eventId)), { status: 200, headers: OK_HEADERS });
    };
    const a = getAltLadders(req([SP, TO]));
    const b = getAltLadders(req([SP, TO]));
    await fetchStarted;
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect("concurrent, same event + markets: ONE Odds API call", oddsApiCalls.length, 1);
    expect("concurrent: both callers got the fresh ladders", [ra[EVENT]?.[SP]?.isStale, rb[EVENT]?.[SP]?.isStale, rb[EVENT]?.[TO]?.outcomes.length], [false, false, 26]);
    expect("concurrent: one usage row", hybridRows().length, 1);

    // A caller wanting a subset of what is already in flight joins it; a caller wanting more buys only the difference.
    reset();
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    let started2!: () => void;
    const fetchStarted2 = new Promise<void>((r) => (started2 = r));
    answer = async (call) => {
      started2();
      await gate2;
      return new Response(JSON.stringify(responseFor(call.params.get("markets")!.split(","), call.eventId)), { status: 200, headers: OK_HEADERS });
    };
    const c = getAltLadders(req([SP]));
    const d = getAltLadders(req([SP, TO]));
    await fetchStarted2;
    release2();
    const [rc, rd] = await Promise.all([c, d]);
    expect("overlap: two calls, [spreads] and [totals] - spreads bought once", oddsApiCalls.map((x) => x.params.get("markets")).sort(), ["alternate_spreads", "alternate_totals"]);
    expect("overlap: both callers have everything they asked for", [rc[EVENT]?.[SP]?.outcomes.length, rd[EVENT]?.[SP]?.outcomes.length, rd[EVENT]?.[TO]?.outcomes.length], [40, 40, 26]);
  }

  // ---- 6. the claim: another instance holding a pair ----
  {
    reset();
    seed(SP, { fetchedAgoMs: 7 * HOUR, commence: startsIn(30), claimedAgoMs: 5_000 });
    const held = await getAltLadders(req([SP], 30));
    expect("claimed 5s ago by another instance: no fetch", oddsApiCalls.length, 0);
    expect("claimed elsewhere: the cached ladder comes back, stale", [held[EVENT]?.[SP]?.isStale, held[EVENT]?.[SP]?.outcomes.length], [true, 1]);

    reset();
    seed(SP, { fetchedAgoMs: 7 * HOUR, commence: startsIn(30), claimedAgoMs: HYBRID_LADDER_CLAIM_MS + 1 });
    const abandoned = await getAltLadders(req([SP], 30));
    expect("a claim older than 30s is abandoned: fetched", oddsApiCalls.length, 1);
    expect("abandoned claim: fresh ladder, claim cleared", [abandoned[EVENT]?.[SP]?.isStale, row(SP)?.claimedAt], [false, null]);

    reset();
    seed(SP, { fetchedAgoMs: 60_000, commence: startsIn(5), claimedAgoMs: HYBRID_LADDER_CLAIM_MS + 1 });
    await getAltLadders(req([SP], 5));
    expect("a fresh row is never claimed, whatever its claim says", oddsApiCalls.length, 0);
  }

  // ---- 7. stale labeling when a fetch fails or times out ----
  {
    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    answer = () => new Response("upstream down", { status: 500, headers: OK_HEADERS });
    const failed = await getAltLadders(req([SP]));
    expect("HTTP 500: the cached ladder, marked stale", [failed[EVENT]?.[SP]?.isStale, failed[EVENT]?.[SP]?.outcomes.length], [true, 1]);
    expect("HTTP 500: claim released so a later call may retry", row(SP)?.claimedAt, null);
    expect("HTTP 500: logged under hybrid-ladders with its status", hybridRows().map((r) => r.httpStatus), [500]);
    expect("HTTP 500: stored row untouched", [row(SP)?.fetchedAt?.toISOString(), (row(SP)?.outcomes as unknown[]).length], [iso(nowMs - 2 * HOUR), 1]);

    reset();
    answer = () => {
      throw new Error("network down");
    };
    const threw = await getAltLadders(req([SP]));
    expect("network error, nothing cached: no ladder, no throw", threw, {});
    expect("network error: claim released", row(SP)?.claimedAt, null);

    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answer = async (call) => {
      await gate;
      return new Response(JSON.stringify(responseFor(call.params.get("markets")!.split(","), call.eventId)), { status: 200, headers: OK_HEADERS });
    };
    const timedOut = await getAltLadders(req([SP]));
    expect("timeout: the cached ladder, marked stale", [timedOut[EVENT]?.[SP]?.isStale, timedOut[EVENT]?.[SP]?.outcomes.length], [true, 1]);
    // The request was not cancelled. A caller arriving now joins it instead of buying again.
    const joiner = getAltLadders(req([SP]));
    release();
    const joined = await joiner;
    expect("timed-out request finishes in the background; a later caller gets its result without a second call", [oddsApiCalls.length, joined[EVENT]?.[SP]?.isStale, joined[EVENT]?.[SP]?.outcomes.length], [1, false, 40]);

    reset();
    ladderFailsRead = true;
    expect("the cache read failing never throws", await getAltLadders(req([SP])), {});
    expect("  ... and nothing was bought", oddsApiCalls.length, 0);
  }

  // ---- 8. the 95% gate and the daily budget: no fetch, cache back with its stale flag ----
  {
    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    gateRow = { creditsUsed: 19_000, creditsRemaining: 1_000 };
    const gated = await getAltLadders(req([SP]));
    expect("95% used: no fetch", oddsApiCalls.length, 0);
    expect("95% used: cached ladder, stale", [gated[EVENT]?.[SP]?.isStale, gated[EVENT]?.[SP]?.outcomes.length], [true, 1]);
    gateRow = { creditsUsed: 18_900, creditsRemaining: 1_100 };
    await getAltLadders(req([SP]));
    expect("94.5% used: fetches", oddsApiCalls.length, 1);

    const spent = (credits: number, over: Partial<UsageRow> = {}) => {
      // `credits` one-market rows, so the sum is exact.
      for (let i = 0; i < credits; i++) {
        usageRows.push({ sportKey: SPORT, pollTimestamp: new RealDate(nowMs - HOUR), creditsUsed: 100, creditsRemaining: 19_900, marketsRequested: "alternate_spreads", eventsRequested: 1, httpStatus: 200, caller: "hybrid-ladders", ...over });
      }
    };
    expect("budget constant", HYBRID_DAILY_CREDIT_BUDGET, 150);

    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    seed(TO, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    spent(150);
    const out = await getAltLadders(req([SP, TO]));
    expect("budget spent (150/150): no fetch", oddsApiCalls.length, 0);
    expect("budget spent: cached ladders, stale", [out[EVENT]?.[SP]?.isStale, out[EVENT]?.[TO]?.isStale], [true, true]);

    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    seed(TO, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    spent(149);
    await getAltLadders(req([SP, TO]));
    expect("149 spent, a 2-market call would reach 151: blocked", oddsApiCalls.length, 0);
    spent(0);
    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    seed(TO, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    spent(148);
    await getAltLadders(req([SP, TO]));
    expect("148 spent, a 2-market call reaches exactly 150: allowed", oddsApiCalls.length, 1);

    reset();
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    spent(150, { caller: "alt-lines" });
    spent(150, { pollTimestamp: new RealDate(nowMs - 20 * HOUR) }); // the previous Eastern day (ET 2026-10-14 18:00)
    spent(150, { httpStatus: 500 });
    await getAltLadders(req([SP]));
    expect("other callers, yesterday's rows and failed calls do not count against the budget", oddsApiCalls.length, 1);

    // The budget's day is the EASTERN day (creditsSpentToday: easternDayStart(easternDateKey(now))), never UTC.
    const etBudget = (nowAt: string, rowAt: string, label: string, expectedCalls: number) => {
      reset();
      nowMs = Date.parse(nowAt);
      seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
      spent(150, { pollTimestamp: new RealDate(rowAt) });
      return getAltLadders(req([SP])).then(() => expect(label, oddsApiCalls.length, expectedCalls));
    };
    // EDT: ET midnight 2026-10-15 is 04:00Z.
    await etBudget("2026-10-15T04:01:00Z", "2026-10-15T03:59:00Z", "ET midnight: 150 spent at 23:59 ET the day before do not count at 00:01 ET (a UTC day would count them)", 1);
    await etBudget("2026-10-15T04:01:00Z", "2026-10-15T04:00:00Z", "ET midnight: a row stamped exactly at 00:00 ET counts toward the new day", 0);
    await etBudget("2026-10-15T03:30:00Z", "2026-10-14T23:30:00Z", "23:30 ET: a row from 19:30 ET the same ET day counts even though UTC has already rolled over", 0);
    // EST after the fall-back: ET midnight 2026-11-02 is 05:00Z.
    await etBudget("2026-11-02T05:30:00Z", "2026-11-02T04:30:00Z", "after the DST change: 04:30Z is 23:30 EST the day before, not counted at 00:30 EST", 1);
    await etBudget("2026-11-02T05:30:00Z", "2026-11-02T05:10:00Z", "after the DST change: 05:10Z is 00:10 EST, counted", 0);

    // Budget is shared across events: with 1 credit left, only the first event is bought.
    reset();
    spent(149);
    const two = [
      { eventId: "ev-a", sport: SPORT, commenceTime: startsIn(5), markets: [SP] as ("alternate_spreads")[] },
      { eventId: "ev-b", sport: SPORT, commenceTime: startsIn(5), markets: [SP] as ("alternate_spreads")[] },
    ];
    await getAltLadders(two);
    expect("one credit left, two single-market events: only the first is bought", oddsApiCalls.map((c) => c.eventId), ["ev-a"]);

    // Fresh hits cost no usage-log reads at all.
    reset();
    seed(SP, { fetchedAgoMs: 60_000, commence: startsIn(5) });
    await getAltLadders(req([SP]));
    expect("all fresh: no usage-log read (gate and budget are checked only when buying)", usageReads, 0);
  }

  // ---- 9. usage logging ----
  {
    reset();
    await getAltLadders(req([SP, TO, ML]));
    const logged = hybridRows()[0];
    expect("usage row: caller, markets, events, status", [hybridRows().length, logged?.caller, logged?.marketsRequested, logged?.eventsRequested, logged?.httpStatus], [1, "hybrid-ladders", "alternate_spreads,alternate_totals,h2h", 1, 200]);
    expect("usage row: the credit counters from the response headers", [logged?.creditsUsed, logged?.creditsRemaining], [2615, 17385]);
    expect("usage row: sport key", logged?.sportKey, SPORT);
  }

  // ---- 10. a game that has started is never fetched ----
  {
    reset();
    seed(SP, { fetchedAgoMs: 3 * HOUR, commence: iso(nowMs - 10 * 60_000) });
    const live = await getAltLadders([{ eventId: EVENT, sport: SPORT, commenceTime: iso(nowMs - 10 * 60_000), markets: [SP, TO] }]);
    expect("started: no fetch and no gate read", [oddsApiCalls.length, usageReads], [0, 0]);
    expect("started: cached ladder stale, the missing one absent", [live[EVENT]?.[SP]?.isStale, live[EVENT]?.[TO]], [true, undefined]);
  }

  // ---- 11. cleanup: rows for games that started over 24h ago ----
  {
    reset();
    seed(SP, { fetchedAgoMs: 40 * HOUR, commence: iso(nowMs - 25 * HOUR), eventId: "old-game" });
    seed(SP, { fetchedAgoMs: 5 * HOUR, commence: iso(nowMs - 23 * HOUR), eventId: "yesterday-game" });
    await getAltLadders(req([SP]));
    expect("cleanup after a buy: the 25h-old game's row is gone, the 23h-old one stays", ladders.map((r) => r.eventId).sort(), [EVENT, "yesterday-game"]);
    ladderStatements.length = 0;
    await getAltLadders(req([SP]));
    expect("no buy, no cleanup statement", ladderStatements.includes("deleteMany"), false);
  }

  // ---- 12. request shaping ----
  {
    reset();
    await getAltLadders([...req([SP]), ...req([TO]), { eventId: "", sport: SPORT, commenceTime: startsIn(5), markets: [SP] }, { eventId: "bad-time", sport: SPORT, commenceTime: "not a date", markets: [SP] }]);
    expect("a repeated event's markets are merged into one call; unusable requests are skipped", oddsApiCalls.map((c) => [c.eventId, c.params.get("markets")]), [[EVENT, "alternate_spreads,alternate_totals"]]);
    reset();
    env.ODDS_API_KEY = "";
    seed(SP, { fetchedAgoMs: 2 * HOUR, commence: startsIn(5) });
    const noKey = await getAltLadders(req([SP]));
    env.ODDS_API_KEY = "test-key-never-sent-anywhere";
    expect("no API key: no fetch, cached ladder stale", [oddsApiCalls.length, noKey[EVENT]?.[SP]?.isStale], [0, true]);
    expect("empty request", await getAltLadders([]), {});
    // A market FanDuel does not list is remembered as empty, not re-bought.
    reset();
    answer = (call) => new Response(JSON.stringify({ ...responseFor([SP], call.eventId) }), { status: 200, headers: OK_HEADERS });
    const thin = await getAltLadders(req([SP, TO]));
    expect("a market the book lacks: stored empty and fresh", [thin[EVENT]?.[TO]?.outcomes, thin[EVENT]?.[TO]?.isStale, row(TO)?.fetchedAt !== null], [[], false, true]);
  }

  // ---- 13. wiring (source-level) ----
  {
    const src = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");
    const code = src("src/server/data/alt-ladders.ts").replace(/\/\/[^\n]*/g, "");
    expect("every usage-log write records httpStatus and the hybrid-ladders caller", (code.split("persistOddsApiUsage(").length - 1 === 1) && /httpStatus: res\.status, caller: "hybrid-ladders"/.test(code), true);
    expect("the only Odds API URL is the per-event odds endpoint", (code.match(/ODDS_API_BASE_URL/g) ?? []).length, 2);
    expect("no team-total or prop market is ever named", /alternate_team_totals|player_|team_totals/.test(code), false);
    expect("OddsApiCaller names hybrid-ladders", /"hybrid-ladders"/.test(src("src/server/data/odds-api-usage.ts")), true);
    expect("OddsSnapshot / OddsAltLineFetch are untouched by this module", /oddsSnapshot|oddsAltLineFetch/.test(code), false);
    const sql = src("prisma/migrations/20261027090000_add_odds_alt_ladders/migration.sql");
    expect("migration enables RLS on odds_alt_ladders and creates no policy", [/ALTER TABLE "odds_alt_ladders" ENABLE ROW LEVEL SECURITY;/.test(sql), /CREATE POLICY/i.test(sql)], [true, false]);
    expect("migration is additive: one table, its two indexes, nothing dropped or altered but RLS", [(sql.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).length, /CREATE UNIQUE INDEX "odds_alt_ladders_eventId_marketKey_key"/.test(sql), /DROP|ALTER COLUMN|DELETE FROM|UPDATE /.test(sql)], [1, true, false]);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
