// Prices for the catalog import that are no staler than FRESH_WINDOW_MS.
//
// The daily snapshot (odds.ts) is written once at ~05:05 UTC and only ever APPENDS games afterwards, so by an evening
// import the price it holds can be ~12 hours old. The posted-odds capture (lib/odds-source.ts) would then log a
// morning price as the price the pick was posted at. This is the one place that fixes that: when the sport's snapshot
// is older than the window, the import prices from ONE fresh bulk h2h/spreads/totals listing instead.
//
//   - Shared: at most one purchase per sport per window. The claim is a row created BEFORE the request
//     (odds_fresh_fetches, unique on sport + window bucket), so two imports racing for it cannot both buy; the loser
//     prices from the snapshot. A later import inside the window reads the stored row - no API call.
//   - Never touches the daily snapshot: the result goes to its own append-only table with its own timestamp; the
//     snapshot row and every game in it stay byte-for-byte what they were, so nothing else that reads it changes.
//   - Bounded: skipped at >= 95% credit usage (the existing ladder), and capped at FRESH_DAILY_CREDIT_CAP credits
//     a day (FRESH_DAILY_CREDIT_CAP / FRESH_CALL_CREDITS calls). Any shortfall - gate, cap, lost claim, API
//     failure - falls back to the snapshot, exactly what the import did before; it is never an error.
//   - A started game is never in a fresh result (the feed would hand back an in-play price for it, as the seed's
//     own filter notes), so it keeps pricing from the snapshot and is stamped with the snapshot's time.
//
// Pure decisions (shouldFetchFresh, mergeFreshOverSnapshot) are separate from the I/O so they are provable without a
// database; the loader takes its I/O as `deps`.
import { Prisma } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import { prisma } from "@/lib/prisma";
import { easternDateKey, easternDayStart } from "@/lib/dates";
import { isSportInSeason, oddsApiRequestKeys } from "@/lib/sport-seasons";
import { fetchMergedOddsListing, type OddsGame, type OddsLoader } from "@/server/data/odds";
import { classifyCreditUsage, getLatestCreditUsageLevel, persistOddsApiUsage } from "@/server/data/odds-api-usage";

export const FRESH_WINDOW_MS = 2 * 3600_000;
// One bulk listing = h2h + spreads + totals x 1 region.
export const FRESH_CALL_CREDITS = 3;
export const FRESH_DAILY_CREDIT_CAP = 60;
export const FRESH_RETAIN_MS = 24 * 3600_000;
const CLEANUP_BATCH = 20;
// A stored listing is read from the database once per this long, fleet-wide (Next Data Cache); the purchase revalidates it.
const FRESH_READ_TTL_SECONDS = 600;

export type FreshListing = { games: OddsGame[]; fetchedAt: Date };

// Whether this sport's snapshot is too old to price from, and a purchase is worth trying. A snapshot with no
// cached game, or whose every game has already started, gains nothing from a pre-game listing.
export function shouldFetchFresh(args: { snapshotAt: Date | null; snapshotGames: OddsGame[]; now: Date; windowMs?: number }): boolean {
  const { snapshotAt, snapshotGames, now } = args;
  const windowMs = args.windowMs ?? FRESH_WINDOW_MS;
  if (!snapshotAt) return false;
  if (now.getTime() - snapshotAt.getTime() < windowMs) return false;
  return snapshotGames.some((g) => new Date(g.commenceTime).getTime() > now.getTime());
}

export type PricingOdds = { games: OddsGame[]; capturedAt: Map<string, Date> };

// The fresh listing over the snapshot, by event id. A game in the fresh listing is priced from it (stamped with its
// fetchedAt); a game only the snapshot has (a started game, or one the listing dropped) keeps the snapshot price and
// the snapshot's time. Neither input is changed.
export function mergeFreshOverSnapshot(snapshotGames: OddsGame[], snapshotAt: Date | null, fresh: FreshListing | null): PricingOdds {
  const capturedAt = new Map<string, Date>();
  if (!fresh) {
    if (snapshotAt) for (const g of snapshotGames) capturedAt.set(g.id, snapshotAt);
    return { games: snapshotGames, capturedAt };
  }
  const freshIds = new Set(fresh.games.map((g) => g.id));
  const games: OddsGame[] = [];
  for (const g of snapshotGames) {
    if (freshIds.has(g.id)) continue;
    games.push(g);
    if (snapshotAt) capturedAt.set(g.id, snapshotAt);
  }
  for (const g of fresh.games) {
    games.push(g);
    capturedAt.set(g.id, fresh.fetchedAt);
  }
  return { games, capturedAt };
}

export type FreshOddsDeps = {
  now: () => Date;
  // The day's snapshot row's createdAt - one 8-byte column, no blob. pastFetchDate: that past ET day's row instead
  // of today's (a game that started on an earlier ET day is priced from its own day's row - pastSnapshotDateFor).
  readSnapshotAt: (sportKey: string, pastFetchDate?: string) => Promise<Date | null>;
  // The newest stored listing fetched at or after `since`.
  readFresh: (sportKey: string, since: Date) => Promise<FreshListing | null>;
  // Buys a listing if the gate, the cap and the claim allow; null otherwise.
  buyFresh: (sportKey: string, now: Date) => Promise<FreshListing | null>;
};

export type PricingOddsLoader = {
  // Same shape as every other resolver's loader: the games to price a pick against.
  load: OddsLoader;
  // When the data that priced this event was read; null if unknown.
  capturedAt: (sportKey: string, eventId: string) => Date | null;
  // The snapshot's own time, for prices read from caches this loader does not see (alt lines, props): the data is at
  // least that new. One column, no blob, and never buys anything. pastFetchDate as on load: the past day's row.
  snapshotAt: (sportKey: string, pastFetchDate?: string) => Promise<Date | null>;
};

// One pricing read per sport for the life of the loader (a paste resolves every line at once). `snapshotLoader` is
// the request's own odds loader, so the snapshot is still read once.
//
// A past ET day (pastFetchDate, set by resolveOddsGame for a game that started on an earlier ET day): that day's row,
// stamped with that row's own time, and never a fresh listing - a fresh listing holds only games that have not
// started, so it could never price this game, and nothing is bought for it. Held per (sport, day).
export function createPricingOddsLoader(snapshotLoader: OddsLoader, deps: FreshOddsDeps = defaultFreshOddsDeps): PricingOddsLoader {
  const held = new Map<string, Promise<PricingOdds>>();
  // (sport, day) key -> event id -> when the data that priced it was read.
  const byEvent = new Map<string, Map<string, Date>>();
  const snapAts = new Map<string, Promise<Date | null>>();
  const dayKey = (sportKey: string, pastFetchDate?: string) => (pastFetchDate === undefined ? sportKey : `${sportKey}|${pastFetchDate}`);
  const snapAt = (sportKey: string, pastFetchDate?: string): Promise<Date | null> => {
    const key = dayKey(sportKey, pastFetchDate);
    let p = snapAts.get(key);
    if (!p) {
      p = (pastFetchDate === undefined ? deps.readSnapshotAt(sportKey) : deps.readSnapshotAt(sportKey, pastFetchDate)).catch(() => null);
      snapAts.set(key, p);
    }
    return p;
  };

  const buildPastDay = async (sportKey: string, pastFetchDate: string): Promise<PricingOdds> => {
    const games = await snapshotLoader(sportKey, pastFetchDate);
    const merged = mergeFreshOverSnapshot(games, await snapAt(sportKey, pastFetchDate), null);
    byEvent.set(dayKey(sportKey, pastFetchDate), merged.capturedAt);
    return merged;
  };

  const build = async (sportKey: string): Promise<PricingOdds> => {
    const snapshotGames = await snapshotLoader(sportKey);
    const snapshotAt = await snapAt(sportKey);
    let fresh: FreshListing | null = null;
    try {
      const now = deps.now();
      if (shouldFetchFresh({ snapshotAt, snapshotGames, now })) {
        fresh = (await deps.readFresh(sportKey, new Date(now.getTime() - FRESH_WINDOW_MS))) ?? (await deps.buyFresh(sportKey, now));
      }
    } catch (err) {
      // Pricing must never fail the import: the snapshot alone is what it used before.
      console.error("[fresh-odds] fell back to the snapshot", JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) }));
      fresh = null;
    }
    const merged = mergeFreshOverSnapshot(snapshotGames, snapshotAt, fresh);
    byEvent.set(sportKey, merged.capturedAt);
    return merged;
  };

  return {
    load: async (sportKey, pastFetchDate) => {
      const key = dayKey(sportKey, pastFetchDate);
      let p = held.get(key);
      if (!p) {
        p = pastFetchDate === undefined ? build(sportKey) : buildPastDay(sportKey, pastFetchDate);
        held.set(key, p);
        p.catch(() => {
          if (held.get(key) === p) held.delete(key);
        });
      }
      return (await p).games;
    },
    // Event ids are unique across days, so an event is found in whichever (sport, day) read priced it.
    capturedAt: (sportKey, eventId) => {
      const today = byEvent.get(sportKey)?.get(eventId);
      if (today) return today;
      for (const [key, events] of byEvent) {
        if (key.startsWith(`${sportKey}|`)) {
          const at = events.get(eventId);
          if (at) return at;
        }
      }
      return null;
    },
    snapshotAt: snapAt,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------
export const freshBucket = (now: Date, windowMs = FRESH_WINDOW_MS): number => Math.floor(now.getTime() / windowMs);

// May another purchase be made: the account is below the 95% line and today's import-fresh spend is under the cap.
export function freshPurchaseAllowed(args: { level: ReturnType<typeof classifyCreditUsage>; callsToday: number }): boolean {
  if (args.level === "stop_lower_priority") return false;
  return (args.callsToday + 1) * FRESH_CALL_CREDITS <= FRESH_DAILY_CREDIT_CAP;
}

async function readSnapshotAt(sportKey: string, pastFetchDate?: string): Promise<Date | null> {
  const row = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate: pastFetchDate ?? easternDateKey(new Date()) } },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

// Thrown inside the cached read when there is nothing to cache, so "no listing yet" is never stored (the purchase that
// creates one would otherwise sit behind a cached miss).
class NoFreshListing extends Error {}

async function readFresh(sportKey: string, since: Date): Promise<FreshListing | null> {
  let stored: { games: OddsGame[]; fetchedAt: string };
  try {
    stored = await cachedByTag(cacheKeys.oddsFresh(sportKey), FRESH_READ_TTL_SECONDS, async () => {
      const row = await prisma.oddsFreshFetch.findFirst({
        where: { sportKey, fetchedAt: { not: null } },
        orderBy: { fetchedAt: "desc" },
        select: { data: true, fetchedAt: true },
      });
      if (!row?.fetchedAt || !Array.isArray(row.data)) throw new NoFreshListing();
      return { games: row.data as unknown as OddsGame[], fetchedAt: row.fetchedAt.toISOString() };
    });
  } catch (err) {
    if (err instanceof NoFreshListing) return null;
    throw err;
  }
  const fetchedAt = new Date(stored.fetchedAt);
  // The cached row is the newest listing, which may be older than the window: then it is no listing at all.
  return fetchedAt.getTime() >= since.getTime() ? { games: stored.games, fetchedAt } : null;
}

// A claim that has not completed within this long is dead (the request that made it timed out or the instance went
// away): the next import may take it over and fetch. Age is measured from the claim's createdAt, which a takeover
// re-stamps, so a live takeover is itself protected for another 5 minutes.
export const FRESH_CLAIM_EXPIRY_MS = 5 * 60_000;

export function claimExpired(claim: { createdAt: Date; fetchedAt: Date | null }, now: Date, expiryMs = FRESH_CLAIM_EXPIRY_MS): boolean {
  if (claim.fetchedAt) return false; // completed: not a stuck claim, whatever its age
  return now.getTime() - claim.createdAt.getTime() >= expiryMs;
}

export type BuyFreshDeps = {
  apiKey: string | undefined;
  inSeason: (sportKey: string) => boolean;
  creditLevel: () => Promise<ReturnType<typeof classifyCreditUsage>>;
  callsToday: (now: Date) => Promise<number>;
  // Creates the claim row; null when the (sport, bucket) claim already exists.
  createClaim: (sportKey: string, bucket: number) => Promise<string | null>;
  readClaim: (sportKey: string, bucket: number) => Promise<{ id: string; createdAt: Date; fetchedAt: Date | null } | null>;
  // Takes over an expired claim by id: true only if the row is still incomplete and still older than `expiredBefore`
  // (a conditional UPDATE, so two instances cannot both take it). Re-stamps createdAt to `now`.
  retakeClaim: (id: string, expiredBefore: Date, now: Date) => Promise<boolean>;
  releaseClaim: (id: string) => Promise<void>;
  // The bulk request itself, usage log included. null when the API failed.
  fetchListing: (sportKey: string, now: Date) => Promise<FreshListing | null>;
  // Fills the claim row, prunes old rows, revalidates the read cache.
  store: (id: string, sportKey: string, listing: FreshListing, now: Date) => Promise<void>;
};

// The purchase: gate and cap first (a dead claim buys nothing it was not already allowed to), then the claim, then the
// request. Every "no" is null, which the caller prices from the snapshot.
export async function buyFreshWith(deps: BuyFreshDeps, sportKey: string, now: Date): Promise<FreshListing | null> {
  if (!deps.apiKey || !deps.inSeason(sportKey)) return null;

  const [level, callsToday] = await Promise.all([deps.creditLevel(), deps.callsToday(now)]);
  if (!freshPurchaseAllowed({ level, callsToday })) return null;

  const bucket = freshBucket(now);
  let claimId = await deps.createClaim(sportKey, bucket);
  if (claimId === null) {
    const existing = await deps.readClaim(sportKey, bucket);
    if (!existing || !claimExpired(existing, now)) return null; // a live (or finished) claim: someone else has it
    if (!(await deps.retakeClaim(existing.id, new Date(now.getTime() - FRESH_CLAIM_EXPIRY_MS), now))) return null;
    claimId = existing.id;
  }

  try {
    const listing = await deps.fetchListing(sportKey, now);
    if (!listing) {
      await deps.releaseClaim(claimId);
      return null;
    }
    await deps.store(claimId, sportKey, listing, now);
    return listing;
  } catch (err) {
    await deps.releaseClaim(claimId);
    throw err;
  }
}

const prismaBuyDeps: BuyFreshDeps = {
  apiKey: undefined, // read per call below
  inSeason: isSportInSeason,
  creditLevel: getLatestCreditUsageLevel,
  callsToday: (now) =>
    prisma.oddsApiUsageLog.count({
      where: { caller: "import-fresh", pollTimestamp: { gte: easternDayStart(easternDateKey(now)) }, httpStatus: { gte: 200, lt: 300 } },
    }),
  createClaim: async (sportKey, bucket) => {
    try {
      return (await prisma.oddsFreshFetch.create({ data: { sportKey, bucket }, select: { id: true } })).id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  },
  readClaim: (sportKey, bucket) =>
    prisma.oddsFreshFetch.findUnique({ where: { sportKey_bucket: { sportKey, bucket } }, select: { id: true, createdAt: true, fetchedAt: true } }),
  retakeClaim: async (id, expiredBefore, now) =>
    (await prisma.oddsFreshFetch.updateMany({ where: { id, fetchedAt: null, createdAt: { lt: expiredBefore } }, data: { createdAt: now } })).count === 1,
  releaseClaim: async (id) => {
    await prisma.oddsFreshFetch.deleteMany({ where: { id } }).catch(() => undefined);
  },
  fetchListing: async (sportKey, now) => {
    const apiKey = process.env.ODDS_API_KEY as string;
    const fetchDate = easternDateKey(now);
    const { games: raw, primaryFailed, credits, httpStatus } = await fetchMergedOddsListing(sportKey, oddsApiRequestKeys(sportKey), apiKey, { fetchDate });
    if (credits) {
      await persistOddsApiUsage({ sportKey, marketsRequested: ["h2h", "spreads", "totals"], eventsRequested: raw.length, credits, httpStatus, caller: "import-fresh" }).catch(
        (err) => console.error("[fresh-odds] failed to persist usage log", JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) }))
      );
    }
    if (primaryFailed) return null;
    const fetchedAt = new Date();
    // Same rule as the seed: an in-play price is not a pregame price.
    return { games: raw.filter((g) => new Date(g.commenceTime) > fetchedAt), fetchedAt };
  },
  store: async (id, sportKey, listing, now) => {
    await prisma.oddsFreshFetch.update({ where: { id }, data: { data: listing.games as unknown as Prisma.InputJsonValue, fetchedAt: listing.fetchedAt } });
    await pruneFresh(now);
    try {
      revalidateTag(cacheKeys.oddsFresh(sportKey));
    } catch (err) {
      // The write succeeded; the read cache catches up within FRESH_READ_TTL_SECONDS.
      console.error("[fresh-odds] revalidateTag failed - listing stored, cache catches up on its TTL", JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) }));
    }
  },
};

const buyFresh = (sportKey: string, now: Date) => buyFreshWith({ ...prismaBuyDeps, apiKey: process.env.ODDS_API_KEY }, sportKey, now);

// Rows past FRESH_RETAIN_MS, read as ids then deleted by id.
async function pruneFresh(now: Date): Promise<void> {
  const due = await prisma.oddsFreshFetch.findMany({
    where: { createdAt: { lt: new Date(now.getTime() - FRESH_RETAIN_MS) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: CLEANUP_BATCH,
  });
  if (due.length > 0) await prisma.oddsFreshFetch.deleteMany({ where: { id: { in: due.map((r) => r.id) } } });
}

export const defaultFreshOddsDeps: FreshOddsDeps = { now: () => new Date(), readSnapshotAt, readFresh, buyFresh };
