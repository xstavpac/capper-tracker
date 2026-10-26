// FanDuel's alternate-line ladders for Consensus Hybrid, cached and shared.
//
// Consensus Hybrid moves each leg of a box onto a forgiving FanDuel alternate
// line, so it needs the whole ladder (every point and price) for a game's
// alternate spreads / alternate totals, plus the moneyline when a team-side
// position has ML supporters. The Odds API sells those per event
// (/events/{id}/odds) at 1 credit per market, and consensus is per user, so the
// union of games asked about grows with the user count. Hence:
//
//   - odds_alt_ladders holds one row per (event, market), FanDuel only, shared by
//     every user. Nothing here is per user.
//   - Freshness by time to start: more than 24 h -> 6 h; 3-24 h -> 60 min;
//     under 3 h -> 15 min. A row is fresh while its age is UNDER the tier's
//     length, and the tier is read at call time (24 h and 3 h exactly fall in the
//     lower tier, i.e. the shorter life).
//   - Only stale or missing (event, market) pairs are fetched, and an event's
//     markets go out as ONE call (bookmakers=fanduel, includeSids, includeLinks).
//   - Single-flight: a conditional UPDATE claims a pair (stale and unclaimed, or a
//     claim older than HYBRID_LADDER_CLAIM_MS), plus a per-instance inFlight map
//     so concurrent callers on one instance share the request.
//   - A game that has started is never fetched (the feed would return in-play
//     prices); its cached ladder comes back marked stale.
//   - Credit controls: nothing is fetched at >=95% account usage, nor once the
//     day's hybrid budget (HYBRID_DAILY_CREDIT_BUDGET, counted from
//     odds_api_usage_log by caller and Eastern day) is spent. Either way the cached
//     ladders come back with their stale flag.
//   - getAltLadders never throws. A failed, timed-out or skipped fetch returns
//     the cached ladder marked stale, or nothing for that pair. A request that
//     outlives the timeout is not cancelled (it may already be paid for): it
//     finishes in the background and the next caller reads its result.
//
// Every Odds API call is written to odds_api_usage_log as caller
// "hybrid-ladders". Shape: __fixtures__ of the real FanDuel event responses in
// lib/parlay/__fixtures__/fanduel-event-*.json (same call, same fields).
import { prisma } from "@/lib/prisma";
import { easternDateKey, easternDayStart } from "@/lib/dates";
import { ODDS_API_BASE_URL, readOddsApiCredits } from "@/server/data/odds";
import { getLatestCreditUsageLevel, persistOddsApiUsage } from "@/server/data/odds-api-usage";

// Credits the hybrid callers may spend per Eastern day, across every user.
export const HYBRID_DAILY_CREDIT_BUDGET = 150;
// A claim older than this is treated as abandoned.
export const HYBRID_LADDER_CLAIM_MS = 30_000;
// Rows for games that started longer ago than this are deleted.
export const HYBRID_LADDER_RETAIN_MS = 24 * 3600_000;

const HOUR_MS = 3600_000;
const DEFAULT_TIMEOUT_MS = 6000;
// Read per call so it can be tuned (and tested) without a redeploy of this file.
function timeoutMs(): number {
  const n = Number(process.env.HYBRID_LADDER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export const ALT_LADDER_MARKETS = ["alternate_spreads", "alternate_totals", "h2h"] as const;
export type AltLadderMarket = (typeof ALT_LADDER_MARKETS)[number];

// What later stages need from an outcome, and nothing else. `description` only
// exists on player/team-total markets, `point` not on h2h; absent fields are
// left out of the stored JSON rather than stored as null.
export type AltLadderOutcome = { name: string; description?: string; point?: number; price: number; sid?: string; link?: string };

export type AltLadder = {
  outcomes: AltLadderOutcome[];
  fetchedAt: Date;
  // The book's own last_update for the market; null when the response had none.
  marketLastUpdate: Date | null;
  isStale: boolean;
};

export type AltLadderRequest = {
  eventId: string;
  sport: string; // the Odds API sport key the event lists under
  commenceTime: string | Date;
  markets: AltLadderMarket[];
};

export type AltLadderResult = Record<string, Partial<Record<AltLadderMarket, AltLadder>>>;

// Pure. How long a ladder stays fresh for a game this far from its start.
export function altLadderTtlMs(msToStart: number): number {
  if (msToStart > 24 * HOUR_MS) return 6 * HOUR_MS;
  if (msToStart >= 3 * HOUR_MS) return 60 * 60_000;
  return 15 * 60_000;
}

// Pure.
export function isAltLadderFresh(commenceTime: Date, fetchedAt: Date | null, now: Date): boolean {
  if (!fetchedAt) return false;
  return now.getTime() - fetchedAt.getTime() < altLadderTtlMs(commenceTime.getTime() - now.getTime());
}

// Pure. FanDuel's outcomes cut to AltLadderOutcome; anything without a name and
// a numeric price is dropped.
export function trimOutcomes(outcomes: unknown): AltLadderOutcome[] {
  if (!Array.isArray(outcomes)) return [];
  const out: AltLadderOutcome[] = [];
  for (const o of outcomes) {
    if (!o || typeof o.name !== "string" || typeof o.price !== "number") continue;
    const t: AltLadderOutcome = { name: o.name, price: o.price };
    if (typeof o.description === "string") t.description = o.description;
    if (typeof o.point === "number") t.point = o.point;
    if (typeof o.sid === "string") t.sid = o.sid;
    if (typeof o.link === "string") t.link = o.link;
    out.push(t);
  }
  return out;
}

type FetchedMarket = { outcomes: AltLadderOutcome[]; fetchedAt: Date; marketLastUpdate: Date | null };
type Row = { eventId: string; marketKey: string; outcomes: unknown; fetchedAt: Date | null; marketLastUpdate: Date | null };

const pairKey = (eventId: string, market: string) => eventId + "|" + market;

// Fetches under way on this instance, by event|market. A fetch covers every
// market it claimed; each of those keys points at the same promise. Never
// rejects. Resolves to the markets it wrote, or null when it got nothing.
const inFlight = new Map<string, Promise<Map<string, FetchedMarket> | null>>();

function logTag(extra: Record<string, unknown>): string {
  return JSON.stringify(extra);
}

async function releaseClaims(eventId: string, markets: string[], claimedAt: Date): Promise<void> {
  try {
    // Only a claim that is still ours: after 30 s someone else may hold it.
    await prisma.oddsAltLadder.updateMany({ where: { eventId, marketKey: { in: markets }, claimedAt }, data: { claimedAt: null } });
  } catch (err) {
    console.error("[alt-ladders] could not release a claim - it expires on its own", logTag({ eventId, markets, error: err instanceof Error ? err.message : String(err) }));
  }
}

// One atomic statement decides who fetches a pair. A missing row is created
// already claimed (the unique key settles a race); an existing one is claimed by
// an UPDATE whose WHERE is "still stale and unclaimed (or the claim is old)".
async function claimPair(args: { eventId: string; market: string; commenceTime: Date; exists: boolean; freshCutoff: Date; now: Date }): Promise<boolean> {
  const { eventId, market, commenceTime, freshCutoff, now } = args;
  if (!args.exists) {
    const created = await prisma.oddsAltLadder.createMany({ data: [{ eventId, marketKey: market, commenceTime, claimedAt: now }], skipDuplicates: true });
    if (created.count === 1) return true;
  }
  const claimStale = new Date(now.getTime() - HYBRID_LADDER_CLAIM_MS);
  const updated = await prisma.oddsAltLadder.updateMany({
    where: {
      eventId,
      marketKey: market,
      AND: [{ OR: [{ fetchedAt: null }, { fetchedAt: { lt: freshCutoff } }] }, { OR: [{ claimedAt: null }, { claimedAt: { lt: claimStale } }] }],
    },
    data: { claimedAt: now, commenceTime },
  });
  return updated.count === 1;
}

// Credits this ET day's hybrid calls have used, from the usage log. A call that
// failed (non-2xx) bought nothing. One credit per market per call: one
// bookmaker is one region's worth, and the Odds API charges per market x region.
async function creditsSpentToday(now: Date): Promise<number> {
  const rows = await prisma.oddsApiUsageLog.findMany({
    where: { caller: "hybrid-ladders", pollTimestamp: { gte: easternDayStart(easternDateKey(now)) }, httpStatus: { gte: 200, lt: 300 } },
    select: { marketsRequested: true },
  });
  return rows.reduce((sum, r) => sum + r.marketsRequested.split(",").filter(Boolean).length, 0);
}

async function fetchEventLadders(args: { eventId: string; sport: string; markets: AltLadderMarket[]; claimedAt: Date; apiKey: string }): Promise<Map<string, FetchedMarket> | null> {
  const { eventId, sport, markets, claimedAt, apiKey } = args;
  const params = new URLSearchParams({
    apiKey,
    regions: "us",
    bookmakers: "fanduel",
    markets: markets.join(","),
    oddsFormat: "american",
    includeSids: "true",
    includeLinks: "true",
  });
  // The url carries the API key, so it is never logged - only what was asked for.
  const ctx = { eventId, sport, markets };

  let res: Response;
  try {
    res = await fetch(ODDS_API_BASE_URL + "/sports/" + sport + "/events/" + encodeURIComponent(eventId) + "/odds?" + params.toString(), { cache: "no-store" });
  } catch (err) {
    console.error("[alt-ladders] upstream fetch threw", logTag({ ...ctx, error: err instanceof Error ? err.name : "unknown" }));
    await releaseClaims(eventId, markets, claimedAt);
    return null;
  }

  const credits = readOddsApiCredits(res, { sportKey: sport, requestSportKey: sport });
  // One odds_api_usage_log row per call that got a response, failed or not. A
  // failed write there never loses the odds just bought.
  try {
    await persistOddsApiUsage({ sportKey: sport, marketsRequested: markets, eventsRequested: 1, credits, httpStatus: res.status, caller: "hybrid-ladders" });
  } catch (err) {
    console.error("[alt-ladders] failed to persist usage log", logTag({ ...ctx, error: err instanceof Error ? err.message : String(err) }));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error("[alt-ladders] upstream fetch failed", logTag({ ...ctx, status: res.status, body: body.slice(0, 300) }));
    await releaseClaims(eventId, markets, claimedAt);
    return null;
  }

  let raw: { bookmakers?: { key?: string; markets?: { key?: string; last_update?: string; outcomes?: unknown }[] }[] };
  try {
    raw = await res.json();
  } catch (err) {
    console.error("[alt-ladders] unreadable response", logTag({ ...ctx, error: err instanceof Error ? err.message : String(err) }));
    await releaseClaims(eventId, markets, claimedAt);
    return null;
  }

  // From here the call has been charged, so what came back is kept. A market
  // FanDuel does not list is stored as an empty ladder: asking again would only
  // buy the same nothing.
  const fanduel = (Array.isArray(raw.bookmakers) ? raw.bookmakers : []).find((b) => b.key === "fanduel");
  const fetchedAt = new Date();
  const written = new Map<string, FetchedMarket>();
  for (const marketKey of markets) {
    const market = fanduel?.markets?.find((m) => m.key === marketKey);
    const updated = market?.last_update ? new Date(market.last_update) : null;
    written.set(marketKey, {
      outcomes: trimOutcomes(market?.outcomes),
      fetchedAt,
      marketLastUpdate: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    });
  }

  await Promise.all(
    [...written].map(([marketKey, m]) =>
      prisma.oddsAltLadder
        .update({
          where: { eventId_marketKey: { eventId, marketKey } },
          data: { outcomes: m.outcomes as unknown as object, fetchedAt: m.fetchedAt, marketLastUpdate: m.marketLastUpdate, claimedAt: null },
        })
        .catch((err) => {
          console.error("[alt-ladders] could not store a ladder", logTag({ eventId, marketKey, error: err instanceof Error ? err.message : String(err) }));
        })
    )
  );

  console.log("[alt-ladders] fetched", logTag({ ...ctx, cost: credits.lastCost, outcomes: [...written].map(([k, m]) => [k, m.outcomes.length]) }));
  return written;
}

// Rows for games that started more than a day ago. Run after a fetch, so it
// costs one statement per batch that bought something and nothing otherwise.
async function deleteOldLadders(now: Date): Promise<void> {
  try {
    await prisma.oddsAltLadder.deleteMany({ where: { commenceTime: { lt: new Date(now.getTime() - HYBRID_LADDER_RETAIN_MS) } } });
  } catch (err) {
    console.error("[alt-ladders] cleanup failed", logTag({ error: err instanceof Error ? err.message : String(err) }));
  }
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The ladders asked for: from the cache when fresh, bought first when not.
// A pair with nothing to show is absent from the result.
export async function getAltLadders(requests: AltLadderRequest[]): Promise<AltLadderResult> {
  try {
    return await load(requests);
  } catch (err) {
    console.error("[alt-ladders] lookup failed", logTag({ error: err instanceof Error ? err.message : String(err) }));
    return {};
  }
}

type Event = { eventId: string; sport: string; commenceTime: Date; markets: AltLadderMarket[] };
// An event this call registered in inFlight; settle() resolves what its waiters see.
type Owned = Event & { promise: Promise<Map<string, FetchedMarket> | null>; settle: (v: Map<string, FetchedMarket> | null) => void };

async function load(requests: AltLadderRequest[]): Promise<AltLadderResult> {
  const now = new Date();

  // One entry per event; a repeated event asks for the union of its markets.
  const events = new Map<string, Event>();
  for (const r of requests) {
    const commenceTime = new Date(r.commenceTime);
    if (!r.eventId || Number.isNaN(commenceTime.getTime())) continue;
    const e = events.get(r.eventId) ?? { eventId: r.eventId, sport: r.sport, commenceTime, markets: [] };
    for (const m of r.markets) if (!e.markets.includes(m)) e.markets.push(m);
    events.set(r.eventId, e);
  }
  if (events.size === 0) return {};

  const rows: Row[] = await prisma.oddsAltLadder.findMany({
    where: { eventId: { in: [...events.keys()] }, marketKey: { in: [...new Set([...events.values()].flatMap((e) => e.markets))] } },
    select: { eventId: true, marketKey: true, outcomes: true, fetchedAt: true, marketLastUpdate: true },
  });
  const cached = new Map(rows.map((r) => [pairKey(r.eventId, r.marketKey), r]));

  // What each pair needs. `waiting` are pairs another call on this instance is
  // already buying; their promise is awaited, never claimed again. Everything
  // from the inFlight check to the inFlight.set below is synchronous on purpose:
  // a concurrent caller either sees our entry or ran its check before us, in
  // which case the claim below tells us apart.
  const toFetch: Owned[] = [];
  const waiting = new Map<string, Promise<Map<string, FetchedMarket> | null>>();
  events.forEach((e) => {
    const stale = e.markets.filter((m) => !isAltLadderFresh(e.commenceTime, cached.get(pairKey(e.eventId, m))?.fetchedAt ?? null, now));
    // Started: the feed would answer with in-play prices.
    if (stale.length === 0 || e.commenceTime.getTime() <= now.getTime()) return;
    const mine = stale.filter((m) => {
      const flying = inFlight.get(pairKey(e.eventId, m));
      if (flying) waiting.set(pairKey(e.eventId, m), flying);
      return !flying;
    });
    if (mine.length === 0) return;
    let settle!: (v: Map<string, FetchedMarket> | null) => void;
    const promise = new Promise<Map<string, FetchedMarket> | null>((resolve) => (settle = resolve));
    mine.forEach((m) => inFlight.set(pairKey(e.eventId, m), promise));
    toFetch.push({ ...e, markets: mine, promise, settle });
  });

  const apiKey = process.env.ODDS_API_KEY;
  const fetched = new Map<string, FetchedMarket>();
  const pending: Promise<void>[] = [];
  const collect = (eventId: string, p: Promise<Map<string, FetchedMarket> | null>, only?: string[]) =>
    raceTimeout(p, timeoutMs()).then((got) => {
      if (!got) return;
      got.forEach((m, market) => {
        if (!only || only.includes(market)) fetched.set(pairKey(eventId, market), m);
      });
    });

  let bought = false;
  const started = new Set<string>();
  try {
    const admitted = apiKey && toFetch.length > 0 ? await admit(toFetch, now) : [];
    for (const e of admitted) {
      const claimed: AltLadderMarket[] = [];
      for (const m of e.markets) {
        const row = cached.get(pairKey(e.eventId, m));
        const freshCutoff = new Date(now.getTime() - altLadderTtlMs(e.commenceTime.getTime() - now.getTime()));
        if (await claimPair({ eventId: e.eventId, market: m, commenceTime: e.commenceTime, exists: !!row, freshCutoff, now })) claimed.push(m);
      }
      // Another instance holds them all; its result is what the cache will show.
      if (claimed.length === 0) continue;
      started.add(e.eventId);
      bought = true;
      fetchEventLadders({ eventId: e.eventId, sport: e.sport, markets: claimed, claimedAt: now, apiKey: apiKey! })
        .catch((err): null => {
          console.error("[alt-ladders] fetch failed", logTag({ eventId: e.eventId, markets: claimed, error: err instanceof Error ? err.message : String(err) }));
          return null;
        })
        .then((got) => {
          e.markets.forEach((m) => inFlight.delete(pairKey(e.eventId, m)));
          e.settle(got);
        });
      pending.push(collect(e.eventId, e.promise));
    }
  } finally {
    // Anything not handed to a fetch (gate, budget, lost claim, an error above)
    // frees its entry so waiters fall back to the cache.
    toFetch.forEach((e) => {
      if (started.has(e.eventId)) return;
      e.markets.forEach((m) => inFlight.delete(pairKey(e.eventId, m)));
      e.settle(null);
    });
  }
  waiting.forEach((p, key) => {
    const [eventId, market] = key.split("|");
    pending.push(collect(eventId, p, [market]));
  });
  await Promise.all(pending);
  if (bought) await deleteOldLadders(now);

  const out: AltLadderResult = {};
  events.forEach((e) => {
    for (const market of e.markets) {
      const key = pairKey(e.eventId, market);
      const got = fetched.get(key);
      const row = cached.get(key);
      let ladder: AltLadder | undefined;
      if (got) {
        ladder = { outcomes: got.outcomes, fetchedAt: got.fetchedAt, marketLastUpdate: got.marketLastUpdate, isStale: false };
      } else if (row && row.fetchedAt && Array.isArray(row.outcomes)) {
        ladder = {
          outcomes: row.outcomes as AltLadderOutcome[],
          fetchedAt: row.fetchedAt,
          marketLastUpdate: row.marketLastUpdate,
          isStale: !isAltLadderFresh(e.commenceTime, row.fetchedAt, now),
        };
      }
      if (ladder) (out[e.eventId] ??= {})[market] = ladder;
    }
  });
  return out;
}

// The events this call may buy, after the two credit controls. Both checks are
// reads of odds_api_usage_log, made only when something is actually stale.
async function admit(toFetch: Owned[], now: Date): Promise<Owned[]> {
  if ((await getLatestCreditUsageLevel()) === "stop_lower_priority") {
    console.error("[alt-ladders] skipped - credit usage >=95%, lower-priority markets paused", logTag({ events: toFetch.length }));
    return [];
  }
  let remaining = HYBRID_DAILY_CREDIT_BUDGET - (await creditsSpentToday(now));
  const admitted: Owned[] = [];
  for (const e of toFetch) {
    if (e.markets.length > remaining) {
      console.error("[alt-ladders] skipped - daily hybrid credit budget spent", logTag({ eventId: e.eventId, budget: HYBRID_DAILY_CREDIT_BUDGET, remaining }));
      continue;
    }
    remaining -= e.markets.length;
    admitted.push(e);
  }
  return admitted;
}

/** Test-only: forget every fetch this instance has in flight. */
export function __clearAltLadderInFlight(): void {
  inFlight.clear();
}
