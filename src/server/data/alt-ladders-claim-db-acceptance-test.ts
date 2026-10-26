// The odds_alt_ladders claim, against REAL Postgres (local bettingview_dev only).
//
// alt-ladders-acceptance-test.ts proves the logic over in-memory fakes; this one
// proves the two statements that decide who fetches - the createMany
// (skipDuplicates) for a missing row and the conditional updateMany for a stale
// one - actually behave atomically in Postgres.
//
// "Two instances" are two separate loads of alt-ladders.ts (own inFlight map)
// over the one shared prisma client and table, started together, so the DB claim
// - not the per-instance map - is the only thing that can stop the second buyer.
// The Odds API is a stub that never answers until the test releases it; any other
// URL throws. Only odds_alt_ladders is real: the usage log is an in-memory fake so
// this leaves nothing in odds_api_usage_log. Rows are created under a unique event
// id prefix and deleted by id at the end. No fixed-delay waits: the loser of each
// race is whichever call settles while the winner's fetch is still gated.
//
// Refuses to run unless DATABASE_URL and DIRECT_URL point at localhost.
// Run with:
//   npx tsx src/server/data/alt-ladders-claim-db-acceptance-test.ts
import { prisma } from "@/lib/prisma";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.ODDS_API_KEY = "test-key-never-sent-anywhere";
env.HYBRID_LADDER_TIMEOUT_MS = "600000"; // never the thing that ends a wait here

for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  const raw = env[name];
  if (!raw) continue;
  const host = new URL(raw).hostname;
  console.log(`${name} host: ${host}`);
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(`REFUSING to run: ${name} is not localhost`);
    process.exit(2);
  }
}

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// ---- usage log: in-memory (the ladder table is the only real one) ----
type UsageRow = { marketsRequested: string; httpStatus: number | null; caller: string | null };
const usageRows: UsageRow[] = [];
const client = prisma as unknown as Record<string, Record<string, unknown>>;
Object.assign((client.oddsApiUsageLog ??= {}), {
  findFirst: async () => null,
  findMany: async () => usageRows.map((r) => ({ marketsRequested: r.marketsRequested })),
  count: async () => usageRows.length,
  create: async (args: { data: UsageRow }) => {
    usageRows.push(args.data);
    return args.data;
  },
});

// ---- the Odds API: gated ----
const OK_HEADERS = { "content-type": "application/json", "x-requests-remaining": "17385", "x-requests-used": "2615", "x-requests-last": "2" };
let fetchCalls: string[] = [];
let gate: Promise<void> = Promise.resolve();
let onFetch: () => void = () => {};
globalThis.fetch = (async (input: unknown) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const eventId = /\/events\/([^/]+)\/odds/.exec(url.pathname)?.[1];
  if (!url.hostname.endsWith("the-odds-api.com") || !eventId) throw new Error("unexpected fetch (would have spent real credits): " + url.pathname);
  fetchCalls.push(eventId);
  onFetch();
  await gate;
  const outcomes = [{ name: "Over", price: -110, point: 40.5, sid: "s1", link: "https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=1" }];
  return new Response(JSON.stringify({ id: eventId, bookmakers: [{ key: "fanduel", markets: [{ key: "alternate_totals", last_update: new Date().toISOString(), outcomes }] }] }), { status: 200, headers: OK_HEADERS });
}) as typeof fetch;

type Api = typeof import("./alt-ladders");
// A fresh load of the module = a fresh "instance" (own inFlight map).
function loadInstance(): Api {
  const path = require.resolve("./alt-ladders");
  delete require.cache[path];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./alt-ladders") as Api;
}

const RUN = `claim-test-${process.pid}-${Date.now()}`;
const HOUR = 3600_000;
const req = (eventId: string) => [{ eventId, sport: "americanfootball_nfl", commenceTime: new Date(Date.now() + 5 * HOUR), markets: ["alternate_totals" as const] }];
const touched: string[] = [];

async function withGate<T>(body: (release: () => void, started: Promise<void>) => Promise<T>): Promise<T> {
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (onFetch = r));
  fetchCalls = [];
  try {
    return await body(release, started);
  } finally {
    release();
  }
}

async function race(label: string, eventId: string) {
  const a = loadInstance();
  const b = loadInstance();
  await withGate(async (release, started) => {
    const callA = a.getAltLadders(req(eventId));
    const callB = b.getAltLadders(req(eventId));
    await started; // the winner's request is out and held at the gate
    // Exactly one call can still be running; the other has lost the claim and returned.
    const loser = await Promise.race([callA.then(() => "A"), callB.then(() => "B")]);
    expect(`${label}: the loser returned while the winner's fetch was still gated, having made no request`, fetchCalls.length, 1);
    const row = await prisma.oddsAltLadder.findUnique({ where: { eventId_marketKey: { eventId, marketKey: "alternate_totals" } } });
    expect(`${label}: the row is claimed (claimedAt set) while the fetch is out`, row?.claimedAt !== null && row?.claimedAt !== undefined, true);
    release();
    const [ra, rb] = await Promise.all([callA, callB]);
    const winner = loser === "A" ? rb : ra;
    const lost = loser === "A" ? ra : rb;
    expect(`${label}: still exactly one request in total`, fetchCalls.length, 1);
    expect(`${label}: the winner got the fresh ladder`, [winner[eventId]?.alternate_totals?.isStale, winner[eventId]?.alternate_totals?.outcomes.length], [false, 1]);
    expect(`${label}: the loser shows only what was cached (${label.startsWith("missing") ? "nothing" : "the old ladder, stale"})`, label.startsWith("missing") ? lost[eventId]?.alternate_totals : [lost[eventId]?.alternate_totals?.isStale, lost[eventId]?.alternate_totals?.outcomes.length], label.startsWith("missing") ? undefined : [true, 1]);
    const after = await prisma.oddsAltLadder.findUnique({ where: { eventId_marketKey: { eventId, marketKey: "alternate_totals" } } });
    expect(`${label}: claim released, ladder stored fresh`, [after?.claimedAt, after?.fetchedAt !== null, (after?.outcomes as unknown[] | null)?.length], [null, true, 1]);
  });
}

async function main() {
  // ---- 1. two instances, missing row: createMany(skipDuplicates) decides ----
  const e1 = `${RUN}-missing`;
  touched.push(e1);
  await race("missing row, two instances", e1);

  // ---- 2. two instances, stale row: the conditional updateMany decides ----
  const e2 = `${RUN}-stale`;
  touched.push(e2);
  await prisma.oddsAltLadder.create({
    data: { eventId: e2, marketKey: "alternate_totals", commenceTime: new Date(Date.now() + 5 * HOUR), outcomes: [{ name: "Over", price: -105, point: 39.5 }], fetchedAt: new Date(Date.now() - 3 * HOUR) },
  });
  await race("stale row, two instances", e2);

  // ---- 3. stale-claim takeover ----
  const takeover = async (label: string, claimAgoMs: number, expectedFetches: number) => {
    const eventId = `${RUN}-${label}`;
    touched.push(eventId);
    await prisma.oddsAltLadder.create({
      data: { eventId, marketKey: "alternate_totals", commenceTime: new Date(Date.now() + 5 * HOUR), outcomes: [{ name: "Over", price: -105, point: 39.5 }], fetchedAt: new Date(Date.now() - 3 * HOUR), claimedAt: new Date(Date.now() - claimAgoMs) },
    });
    const api = loadInstance();
    await withGate(async (release) => {
      release(); // answers immediately; the gate is only for the races above
      const got = await api.getAltLadders(req(eventId));
      expect(`${label}: requests made`, fetchCalls.length, expectedFetches);
      expect(`${label}: ladder returned is ${expectedFetches ? "fresh" : "the cached one, stale"}`, [got[eventId]?.alternate_totals?.isStale, got[eventId]?.alternate_totals?.outcomes.length], expectedFetches ? [false, 1] : [true, 1]);
    });
    const row = await prisma.oddsAltLadder.findUnique({ where: { eventId_marketKey: { eventId, marketKey: "alternate_totals" } } });
    if (expectedFetches) expect(`${label}: the takeover's claim is released after its write`, row?.claimedAt, null);
    else expect(`${label}: someone else's claim is left exactly as it was`, row?.claimedAt?.getTime() !== undefined && Date.now() - (row?.claimedAt?.getTime() ?? 0) >= claimAgoMs, true);
  };
  const { HYBRID_LADDER_CLAIM_MS } = loadInstance();
  await takeover("claim-31s-old", HYBRID_LADDER_CLAIM_MS + 1_000, 1);
  await takeover("claim-5s-old", 5_000, 0);
  await takeover("claim-just-under-30s", HYBRID_LADDER_CLAIM_MS - 3_000, 0);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    // By id, only the rows this run made.
    const rows = await prisma.oddsAltLadder.findMany({ where: { eventId: { in: touched } }, select: { id: true } }).catch(() => []);
    for (const r of rows) await prisma.oddsAltLadder.delete({ where: { id: r.id } }).catch(() => {});
    await prisma.$disconnect();
    if (failures > 0) {
      console.log(`\n${failures} FAILED`);
      process.exit(1);
    }
    console.log("\nAll passed");
  });
