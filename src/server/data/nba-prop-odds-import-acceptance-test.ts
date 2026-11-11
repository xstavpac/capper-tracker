// Import-time price for an NBA player prop, through the REAL resolveGameAndOdds (bulk-import-core.ts) - the same
// resolver the import stores from - into the stored price, odds source and posted-odds capture.
//
// The event response is the real historical capture __fixtures__/odds-api-historical-nba-player-points-2026-10-30.json
// (Los Angeles Lakers @ Golden State Warriors, player_points at 2026-10-30T17:25:36Z). The lines below are seven real
// props imported on that game five minutes later, all stored at -110 at the time. Roster rows are HAND-BUILT.
//
// No database and no network: the prisma delegates nba-prop-odds.ts and odds-api-usage.ts touch are in-memory stubs,
// and global fetch serves the capture for the Odds API event URL and an empty feed for everything else. NEVER let a
// request through to the network - a real call would spend real credits. Listed in PURE_DESPITE_PRISMA_IMPORT in
// scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nba-prop-odds-import-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import type { OddsGame } from "@/server/data/odds";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ODDS_API_KEY = "test-key-never-sent-anywhere";
env.NBA_PROP_ODDS_TIMEOUT_MS = "2000";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const hist = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-historical-nba-player-points-2026-10-30.json"), "utf8")).data;
const LAL = "Los Angeles Lakers";
const GSW = "Golden State Warriors";

const base = Date.parse("2026-10-30T17:30:00Z");
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

const h2h = (home: string, away: string): OddsGame["bookmakers"][number] => ({
  key: "draftkings",
  title: "DraftKings",
  markets: [{ key: "h2h", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] }],
});
const warriors: OddsGame = { id: hist.id, sportKey: "basketball_nba", homeTeam: GSW, awayTeam: LAL, commenceTime: hist.commence_time, bookmakers: [h2h(GSW, LAL)] };
// A game that tipped an hour ago: nothing may be bought for it.
const started: OddsGame = {
  id: "nbaStarted",
  sportKey: "basketball_nba",
  homeTeam: "Boston Celtics",
  awayTeam: "Miami Heat",
  commenceTime: new RealDate(base - 3600_000).toISOString(),
  bookmakers: [h2h("Boston Celtics", "Miami Heat")],
};
const getOdds = async (sportKey: string) => (sportKey === "basketball_nba" ? [warriors, started] : []);

// ---- prisma stubs ----
function stub(model: string, methods: Record<string, unknown>) {
  const client = prisma as unknown as Record<string, Record<string, unknown> | undefined>;
  Object.assign((client[model] ??= {}), methods);
}
type FetchRow = { id: string; sportKey: string; eventId: string; marketKey: string; commenceTime: Date; bucket: number; fetchedAt: Date | null; linesStored: number | null; createdAt: Date };
type LineRow = { fetchId: string; bookOrder: number; bookKey: string; playerName: string; side: string; point: number | null; price: number };
const fetchRows: FetchRow[] = [];
const lineRows: LineRow[] = [];
let seq = 0;
stub("oddsPropFetch", {
  findFirst: async ({ where }: { where: { eventId: string; marketKey: string; createdAt: { gte: Date } } }) =>
    fetchRows
      .filter((f) => f.eventId === where.eventId && f.marketKey === where.marketKey && f.createdAt >= where.createdAt.gte && f.fetchedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((f) => ({ id: f.id, fetchedAt: f.fetchedAt }))[0] ?? null,
  create: async ({ data }: { data: Omit<FetchRow, "id" | "fetchedAt" | "linesStored" | "createdAt"> }) => {
    const row = { ...data, id: "fetch" + ++seq, fetchedAt: null, linesStored: null, createdAt: new Date() };
    fetchRows.push(row);
    return { id: row.id };
  },
  findUnique: async () => null,
  update: async ({ where, data }: { where: { id: string }; data: Partial<FetchRow> }) => {
    const row = fetchRows.find((f) => f.id === where.id)!;
    Object.assign(row, data);
    return { id: row.id };
  },
  delete: async ({ where }: { where: { id: string } }) => {
    fetchRows.splice(fetchRows.findIndex((f) => f.id === where.id), 1);
    return { id: where.id };
  },
});
stub("oddsPropLine", {
  createMany: async ({ data }: { data: LineRow[] }) => {
    lineRows.push(...data);
    return { count: data.length };
  },
  findMany: async ({ where }: { where: { fetchId: string; side: string; point: number } }) =>
    lineRows
      .filter((l) => l.fetchId === where.fetchId && l.side === where.side && l.point === where.point)
      .sort((a, b) => a.bookOrder - b.bookOrder)
      .map(({ bookOrder, bookKey, playerName, price }) => ({ bookOrder, bookKey, playerName, price })),
});
const client = prisma as unknown as Record<string, unknown>;
client.$transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
client.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  if (!strings.join("?").includes('SELECT DISTINCT "playerName" FROM "odds_prop_lines"')) throw new Error("unexpected raw query: " + strings.join("?"));
  return [...new Set(lineRows.filter((l) => l.fetchId === values[0]).map((l) => l.playerName))].map((playerName) => ({ playerName }));
};
const usageRows: { caller: string; marketsRequested: string; httpStatus: number | null }[] = [];
stub("oddsApiUsageLog", {
  findFirst: async () => null,
  count: async () => usageRows.length,
  create: async ({ data }: { data: { caller: string; marketsRequested: string; httpStatus: number | null } }) => {
    usageRows.push({ caller: data.caller, marketsRequested: data.marketsRequested, httpStatus: data.httpStatus });
    return data;
  },
});
const R = (fullName: string, team: string, espnPlayerId: string) => {
  const [firstName, ...rest] = fullName.split(" ");
  return { fullName, firstName, lastName: rest.join(" "), team, position: "G", active: true, espnPlayerId };
};
stub("nbaRosterPlayer", {
  findMany: async () => [
    R("Luka Dončić", LAL, "1"),
    R("Austin Reaves", LAL, "2"),
    R("Stephen Curry", GSW, "3"),
    R("Yaxel Lendeborg", GSW, "4"),
    R("Georges Niang", LAL, "5"),
  ],
});

let eventCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("the-odds-api.com")) {
    if (!url.includes("/sports/basketball_nba/events/" + hist.id + "/odds?") || !url.includes("markets=player_points")) throw new Error("unexpected Odds API call: " + url.replace(/apiKey=[^&]+/, "apiKey=***"));
    eventCalls++;
    return new Response(JSON.stringify(hist), { status: 200, headers: { "x-requests-remaining": "15000", "x-requests-used": "5000", "x-requests-last": "1" } });
  }
  return new Response(JSON.stringify({ events: [], dates: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const item = (description: string, nickname = "warriors", stated?: number) => ({
  sportName: "NBA",
  betType: "PLAYER_PROP" as const,
  hasExplicitOdds: stated !== undefined,
  odds: stated ?? -110,
  teamNicknames: [nickname],
  description,
  gameNumber: null,
  period: "FULL_GAME" as const,
});

async function main() {
  const { resolveGameAndOdds } = await import("@/server/data/bulk-import-core");
  const run = (it: ReturnType<typeof item>, buyPropOdds = true) => resolveGameAndOdds(it, getOdds, { retryOnMiss: false, altLines: true, buyPropOdds });
  const stored = (r: Awaited<ReturnType<typeof run>>) => ({
    odds: r.odds,
    oddsSource: r.oddsSource,
    postedLine: r.posted.postedLine,
    oddsBook: r.posted.oddsBook,
    oddsCapturedAt: r.posted.oddsCapturedAt?.toISOString() ?? null,
    oddsNullReason: r.posted.oddsNullReason,
  });
  const at = "2026-10-30T17:30:00.000Z";

  const [luka, niang, lendeborg, reaves, curry, luka245, nobody] = await Promise.all([
    run(item("Luka Doncic over 34.5 points")),
    run(item("Georges Niang over 7.5 points")),
    run(item("Yaxel Lendeborg over 18.5 points")),
    run(item("Austin Reaves over 19.5 points")),
    run(item("Stephen Curry over 19.5 points")),
    run(item("Luka Doncic over 24.5 points")),
    run(item("Nobody Realname over 10.5 points")),
  ]);
  expect("every line matched the Lakers @ Warriors game", [luka, niang, lendeborg, reaves, curry, luka245, nobody].every((r) => r.matched && r.homeTeam === GSW), true);
  expect("Luka over 34.5 -> MARKET -119 at DraftKings, line + fetch time stored", stored(luka), { odds: -119, oddsSource: "MARKET", postedLine: 34.5, oddsBook: "draftkings", oddsCapturedAt: at, oddsNullReason: null });
  expect("Niang over 7.5 -> MARKET -121", stored(niang), { odds: -121, oddsSource: "MARKET", postedLine: 7.5, oddsBook: "draftkings", oddsCapturedAt: at, oddsNullReason: null });
  expect("Lendeborg over 18.5 -> Bovada's ladder", stored(lendeborg), { odds: -135, oddsSource: "MARKET", postedLine: 18.5, oddsBook: "bovada", oddsCapturedAt: at, oddsNullReason: null });
  expect("Reaves over 19.5 -> Bovada's ladder", stored(reaves), { odds: -280, oddsSource: "MARKET", postedLine: 19.5, oddsBook: "bovada", oddsCapturedAt: at, oddsNullReason: null });
  expect("Curry over 19.5 -> DEFAULTED no_exact_line, line still recorded", stored(curry), { odds: -110, oddsSource: "DEFAULTED", postedLine: 19.5, oddsBook: null, oddsCapturedAt: null, oddsNullReason: "no_exact_line" });
  expect("Luka over 24.5 -> DEFAULTED no_exact_line", stored(luka245).oddsNullReason, "no_exact_line");
  expect("player not listed -> DEFAULTED no_market", stored(nobody), { odds: -110, oddsSource: "DEFAULTED", postedLine: 10.5, oddsBook: null, oddsCapturedAt: null, oddsNullReason: "no_market" });
  expect("seven concurrent lines on one game + market -> one Odds API request", eventCalls, 1);
  expect("one usage row, tagged nba-prop-odds", usageRows.map((u) => [u.caller, u.marketsRequested, u.httpStatus]), [["nba-prop-odds", "player_points", 200]]);
  expect("one fetch row, every outcome of the market stored", [fetchRows.length, fetchRows[0]?.linesStored, lineRows.length], [1, 352, 352]);

  // N+ form is read as Over (N - 0.5), as grading reads it.
  expect("'Luka Doncic 35+ points' prices the Over 34.5 line", stored(await run(item("Luka Doncic 35+ points"))).odds, -119);

  // The capper's own price is kept and nothing is looked up.
  const statedRun = await run(item("Luka Doncic over 34.5 points -105", "warriors", -105));
  expect("stated price kept, no request", [statedRun.odds, statedRun.oddsSource, eventCalls], [-105, "STATED", 1]);

  // A started game with nothing bought before tip: no request, game_started.
  const tipped = await run(item("Jayson Tatum over 25.5 points", "celtics"));
  expect("started game -> DEFAULTED game_started, no request", [stored(tipped).oddsSource, stored(tipped).oddsNullReason, eventCalls], ["DEFAULTED", "game_started", 1]);

  // Callers that only want the matched game never buy.
  const noBuy = await run(item("Austin Reaves over 23.5 points"), false);
  expect("buyPropOdds off -> unpriced as before (unsupported_prop), no request", [stored(noBuy).oddsSource, stored(noBuy).oddsNullReason, eventCalls], ["DEFAULTED", "unsupported_prop", 1]);

  // A market with no Odds API key keeps the old reason.
  const dd = await run(item("Luka Doncic double double"));
  expect("double-double -> DEFAULTED unsupported_prop, no request", [stored(dd).oddsSource, stored(dd).oddsNullReason, eventCalls], ["DEFAULTED", "unsupported_prop", 1]);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
