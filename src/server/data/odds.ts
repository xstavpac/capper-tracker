import { unstable_cache, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sameEasternDay, easternDateKey, closestByTime, withinDateDriftDays, APP_TIME_ZONE } from "@/lib/dates";
import { isSportInSeason, oddsApiRequestKeys } from "@/lib/sport-seasons";
import type { OddsFetchStatus, BackfillStatus } from "@/lib/odds-cron-status";
import { teamNamesMatch } from "@/lib/team-name-match";
import { cacheKeys } from "@/lib/cache-keys";
import { memoizeWithTtl, resolveTtlSeconds } from "@/server/data/ttl-memo";
import { cachedByTag } from "@/server/data/cached";
import { persistOddsApiUsage } from "@/server/data/odds-api-usage";

// Live scores are current-ish data polled every 25s per open /live tab -
// keep the window tight. Odds change at most every 4h (the backfill cron)
// and usually once a day, so a longer window is invisible and still
// collapses the /live polling burst. Both env-overridable, clamped 1-300s.
const LIVE_SCORES_TTL_SECONDS = resolveTtlSeconds(process.env.LIVE_SCORES_TTL_SECONDS, 15);
const ODDS_CACHE_TTL_SECONDS = resolveTtlSeconds(process.env.ODDS_CACHE_TTL_SECONDS, 60);

// The Odds API returns x-requests-remaining / -used / -last on every response.
// Once `remaining` drops below this, the per-call credits log escalates from
// info to warning, so an imminent monthly-cap exhaustion is visible in the
// logs BEFORE fetches start failing - the failure mode that silently blanked
// the Live/odds board for stretches of late 2026 on the free tier. Default is
// deliberately generous (roughly a day's worth of fetch budget) so the
// warning leads the actual outage by days, not minutes. Env-overridable.
const ODDS_API_CREDITS_LOW_WATERMARK = Number(process.env.ODDS_API_CREDITS_LOW_WATERMARK) || 1000;

export type OddsGame = {
  id: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: {
    key: string;
    title: string;
    markets: {
      key: string;
      // Present on every market the Odds API returns (confirmed on real
      // player_anytime_td data, see nfl-prop-odds.ts) - was never typed
      // here before because nothing read it; kept optional since old
      // cached OddsSnapshot rows (written before this field was read)
      // won't have it.
      last_update?: string;
      outcomes: {
        name: string;
        price: number;
        point?: number;
        // Player-prop-only: the Odds API puts the subject's name here, not
        // in `name` (which stays "Over"/"Under"/"Yes" for props - see
        // nfl-prop-odds.ts). Absent for h2h/spreads/totals outcomes, where
        // `name` alone (a team name) already identifies the outcome.
        description?: string;
      }[];
    }[];
  }[];
};

// One entry per inning that has started. `runs` is null (not 0) for a half
// that hasn't been played yet - the schedule endpoint's linescore just omits
// the "runs" key on an in-progress/upcoming half, and collapsing that to 0
// would make "hasn't batted yet" indistinguishable from "batted and scored
// nothing," which situational reads like "scored first" depend on.
export type ScoreGameInning = {
  num: number;
  home: { runs: number } | null;
  away: { runs: number } | null;
};

export type ScoreGame = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  status: "preview" | "live" | "final";
  scores: { name: string; score: string }[] | null;
  commenceTime: string;
  // MLB-only (from the schedule endpoint's `hydrate=linescore`) - "Top"/
  // "Bottom"/"Middle"/"End" + an ordinal like "9th". Null for preview/final
  // games and for every ESPN-backed sport (innings are baseball-specific).
  inningHalf: string | null;
  inningOrdinal: string | null;
  // MLB-only, same `hydrate=linescore` payload as inningHalf/inningOrdinal -
  // populated for live and final games, null for preview and for every
  // ESPN-backed sport.
  innings: ScoreGameInning[] | null;
  // ESPN-backed sports only (NBA/WNBA/NFL/NCAAF/NHL, via getEspnScores'
  // shared mapping) - the scoreboard's own `status.period` (quarter/period
  // number, 1-based, >4/>3 in OT) and `status.displayClock` ("12:34" mm:ss
  // remaining in that period). Populated for live games only; null for
  // preview/final and for every non-ESPN sport (MLB, CFL). Optional (not
  // just nullable) so the many existing ScoreGame literals elsewhere
  // (tests, live-ticker.ts, oddsGameToScheduleGame) don't all need updating
  // just to add "period: null, clock: null" - undefined and null both mean
  // "no live-progress data" to every reader.
  period?: number | null;
  clock?: string | null;
  // MLB only - the MLB Stats API schedule's own doubleheader metadata
  // (already present in the `hydrate=linescore` response getMlbLiveScores
  // fetches, previously read but not captured here). gameNumber is 1 or 2
  // for a leg of a doubleheader, null for a single game. doubleHeaderStatus
  // is the raw API flag: "Y" (traditional doubleheader, two full 9-inning
  // games), "S" (split doubleheader, separate admissions/times), or "N" (not
  // a doubleheader). Both null/undefined for every non-MLB sport. This is
  // the authoritative signal pickBestScheduleCandidate trusts over its own
  // start-time-order fallback - see that function's own comment.
  gameNumber?: number | null;
  doubleHeaderStatus?: "Y" | "S" | "N" | null;
};

export const LIVE_SPORTS = [
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "icehockey_nhl", label: "NHL" },
  { key: "basketball_wnba", label: "WNBA" },
  { key: "americanfootball_ncaaf", label: "NCAAF" },
];

// Exported for nfl-prop-odds.ts's event-level fetch, which is otherwise the
// same "hit the Odds API, read the usage headers" pattern as everything
// else in this file.
export const ODDS_API_BASE_URL = "https://api.the-odds-api.com/v4";
const BASE_URL = ODDS_API_BASE_URL;

// Shared, cross-instance layer over getOddsForSportUncached (cachedByTag ->
// unstable_cache / Next's Data Cache), keyed by cacheKeys.odds(sportKey,
// fetchDate). Previously this was a process-local memo (memoizeWithTtl) -
// fine for collapsing a burst of hits on ONE warm serverless instance, but
// Vercel scales instances up/down often enough under this app's real,
// sporadic traffic that most requests land on a different instance and miss
// the process-local cache entirely, each miss re-paying a full DB round-trip
// for a JSON blob that can be 100KB-1MB for a full week of games across all
// bookmakers. unstable_cache's Data Cache is shared platform-level storage,
// not per-instance memory, so it actually survives that churn.
//
// Freshness contract: every OddsSnapshot write path (seedOddsSnapshot,
// backfillOddsForSport, seedNflPropOddsForToday) calls revalidateTag for its
// (sportKey, fetchDate) key immediately after a successful write. The next
// read for that exact key after a successful invalidation gets a fresh
// fetch, not a stale value. ODDS_CACHE_TTL_SECONDS (below) is a best-effort
// backstop, not a freshness SLA: it only matters if a write's revalidateTag
// call itself fails (each write path logs and continues rather than failing
// the write - see each one's own comment), and in that case this cache
// offers no hard bound on how stale a read can be, only "eventually, once
// something reads this key again." Every current consumer of this data
// (grading's ledger fields, prop-odds resolution, pick recovery) is
// independently designed to degrade to "missing" rather than "wrong" when
// that backstop path is the one that fires, so relying on it in the rare
// case a tag invalidation fails is safe, not silently incorrect.
//
// getOddsForSport computes its own fetchDate here (needed to build the cache
// key before the cached function even runs) rather than reading it back from
// getOddsForSportUncached's result - a second new Date() call, independent
// of the one inside getOddsForSportUncached, milliseconds apart in practice.
// This is NOT the same risk as a write path recomputing its own key: a write
// path's revalidateTag must match the exact fetchDate it just wrote under,
// which is why those paths thread the value through instead of recomputing
// it (see seedOddsSnapshot/backfillOddsForSport/seedNflPropOddsForToday).
// Here there's no write to match - worst case an extremely rare request
// exactly at the Eastern midnight boundary builds a key for the wrong day,
// which self-corrects on the very next request either way.
export async function getOddsForSport(sportKey: string): Promise<OddsGame[]> {
  const fetchDate = easternDateKey(new Date());
  const result = await cachedByTag(cacheKeys.odds(sportKey, fetchDate), ODDS_CACHE_TTL_SECONDS, () =>
    getOddsForSportUncached(sportKey)
  );
  return result.games;
}

// True only for a status that means a fresh OddsSnapshot row was actually
// written - "cached"/"off_season"/"no_api_key"/"fetch_failed" all leave the
// cache's current contents (or absence) accurate, so invalidating for those
// would just force an identical re-fetch on the next read. Pure and
// exported so this decision is provable without a Next.js request context -
// revalidateTag itself needs one, this doesn't. Mirrored by
// backfillWriteInvalidatesCache below and nflPropWriteInvalidatesCache
// (nfl-prop-odds.ts) for the other two OddsSnapshot write paths - every
// write path gets the identical treatment, no tier of write is exempt.
export function oddsWriteInvalidatesCache(status: OddsFetchStatus): boolean {
  return status === "seeded";
}

// Seed/refresh today's OddsSnapshot for one sport and report what actually
// happened - the /api/cron/refresh-odds route uses this instead of
// getOddsForSport so it can return a real failure status (and surface Odds
// API credits remaining) rather than a blanket { ok: true } that hid the
// free-tier exhaustion outages. Calls the uncached path directly: the cron
// is the authoritative daily attempt, not a cache consumer.
//
// revalidateTag is safe to call here in the real cron Route Handler (unlike
// inside getOddsForSport's own cache-miss fallback above, which can run
// during render) - but this function is ALSO exercised directly by
// odds-usage-log-failure-acceptance-test.ts, a bare tsx process with no
// Next.js request context at all, where revalidateTag throws
// unconditionally ("Invariant: static generation store missing"). The
// upsert has already succeeded by this point regardless, so a failed
// invalidation must never fail the write it's reporting on - same "log
// loudly, swallow, move on" rule recordBulkUsage above already applies to a
// failed usage-log write on this exact path. Worst case on a real miss here
// is the ODDS_CACHE_TTL_SECONDS backstop, not a wrong result.
export async function seedOddsSnapshot(
  sportKey: string
): Promise<{ sportKey: string; status: OddsFetchStatus; games: number; creditsRemaining: number | null }> {
  const { games, status, credits, fetchDate } = await getOddsForSportUncached(sportKey);
  if (oddsWriteInvalidatesCache(status)) {
    try {
      revalidateTag(cacheKeys.odds(sportKey, fetchDate));
    } catch (err) {
      console.error(
        "[seedOddsSnapshot] revalidateTag failed - odds write succeeded, cache invalidation did not; TTL backstop will catch up",
        JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) })
      );
    }
  }
  return { sportKey, status, games: games.length, creditsRemaining: credits?.remaining ?? null };
}

const BULK_MARKET_KEYS = ["h2h", "spreads", "totals"];
const ODDS_MARKET_PARAMS = "&regions=us&markets=" + BULK_MARKET_KEYS.join(",") + "&oddsFormat=american";

// persistOddsApiUsage writes to a DB table this file doesn't otherwise touch
// on this path - a write failure there (a transient DB blip, a migration not
// yet applied) must never take down the actual odds fetch/cache-write for
// the sport it's logging usage for. This runs inside the cron's
// Promise.all(LIVE_SPORTS.map(...)) (see /api/cron/refresh-odds), so an
// unguarded throw here for one sport would reject that whole Promise.all and
// 500 the entire cron run, even though every other sport's fetch already
// succeeded moments earlier. Best-effort: log loudly, swallow, move on.
async function recordBulkUsage(sportKey: string, eventsRequested: number, credits: OddsApiCredits): Promise<void> {
  try {
    await persistOddsApiUsage({ sportKey, marketsRequested: BULK_MARKET_KEYS, eventsRequested, credits });
  } catch (err) {
    console.error(
      "[odds-api-usage] failed to persist usage log - odds fetch continues unaffected",
      JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) })
    );
  }
}

export type OddsApiCredits = { remaining: number | null; used: number | null; lastCost: number | null };

// Reads the Odds API usage headers off a response (they're present on error
// responses too, e.g. a 401 OUT_OF_USAGE_CREDITS carries `remaining: 0`) and
// logs them - one `[odds-api] credits` line per real HTTP call, escalated to
// `[odds-api] credits LOW` (warning level) once `remaining` is under
// ODDS_API_CREDITS_LOW_WATERMARK. Returns the parsed values so the
// refresh-odds cron can echo `remaining` in its own response body.
export function readOddsApiCredits(res: Response, ctx: { sportKey: string; requestSportKey: string }): OddsApiCredits {
  const num = (header: string) => {
    const raw = res.headers.get(header);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const credits: OddsApiCredits = {
    remaining: num("x-requests-remaining"),
    used: num("x-requests-used"),
    lastCost: num("x-requests-last"),
  };
  const line = JSON.stringify({ ...ctx, ...credits, watermark: ODDS_API_CREDITS_LOW_WATERMARK });
  if (credits.remaining !== null && credits.remaining < ODDS_API_CREDITS_LOW_WATERMARK) {
    console.warn("[odds-api] credits LOW", line);
  } else {
    console.log("[odds-api] credits", line);
  }
  return credits;
}

// Fetches the raw Odds API odds listing for one or more sport keys (see
// oddsApiRequestKeys) and merges them into one deduped OddsGame[] by event
// id, BEFORE any date/started-game filtering the caller applies on top.
//
// `requestKeys[0]` is the authoritative key (the app's real sportKey): if it
// fails, `primaryFailed` is true and the caller must NOT cache the result
// ("missing beats wrong" - a real outage must stay distinguishable from an
// empty slate). Any additional key is the NFL preseason key, queried only
// during the ~5-week pre-regular-season window; its failure is logged and
// skipped (best-effort supplement, not a reason to blow away a good primary
// result). For the ~11 months requestKeys is a single element this is a plain
// one-key fetch, byte-for-byte the same request as before.
export async function fetchMergedOddsListing(
  sportKey: string,
  requestKeys: string[],
  apiKey: string,
  context: { fetchDate: string }
): Promise<{ games: OddsGame[]; primaryFailed: boolean; credits: OddsApiCredits | null }> {
  const byId = new Map<string, OddsGame>();
  let primaryFailed = false;
  // Freshest usage headers seen this call - the keys are fetched sequentially
  // against the one account, so the last response's `remaining` is the most
  // current.
  let credits: OddsApiCredits | null = null;
  const multiKey = requestKeys.length > 1;

  for (let i = 0; i < requestKeys.length; i++) {
    const requestSportKey = requestKeys[i];
    const isPrimary = i === 0;
    const url = BASE_URL + "/sports/" + requestSportKey + "/odds/?apiKey=" + apiKey + ODDS_MARKET_PARAMS;

    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (err) {
      console.error(
        "[getOddsForSport] upstream fetch threw",
        // URL is never logged as-is - it carries apiKey as a query param.
        JSON.stringify({
          sportKey,
          requestSportKey,
          primary: isPrimary,
          fetchDate: context.fetchDate,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      if (isPrimary) primaryFailed = true;
      continue;
    }

    // Usage headers are on the error response too - a 401/429 for an
    // exhausted plan reports `x-requests-remaining: 0`, which is exactly what
    // we want surfaced when fetches start failing.
    credits = readOddsApiCredits(res, { sportKey, requestSportKey });

    if (!res.ok) {
      // Body is truncated (the-odds-api.com error responses are small JSON,
      // but this guards against ever logging something unexpectedly large).
      const bodyText = await res.text().catch(() => "<unreadable body>");
      console.error(
        "[getOddsForSport] upstream fetch failed",
        JSON.stringify({
          sportKey,
          requestSportKey,
          primary: isPrimary,
          fetchDate: context.fetchDate,
          status: res.status,
          statusText: res.statusText,
          body: bodyText.slice(0, 500),
        })
      );
      if (isPrimary) primaryFailed = true;
      continue;
    }

    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [];
    for (const g of list) {
      if (byId.has(g.id)) continue;
      byId.set(g.id, {
        id: g.id,
        sportKey: g.sport_key,
        homeTeam: g.home_team,
        awayTeam: g.away_team,
        commenceTime: g.commence_time,
        bookmakers: g.bookmakers ?? [],
      });
    }

    if (multiKey) {
      // Only during the preseason->regular-season merge window, so it's rare
      // and its whole point is showing which key carried the slate across the
      // handoff.
      console.log(
        "[getOddsForSport] key listing",
        JSON.stringify({ sportKey, requestSportKey, primary: isPrimary, count: list.length })
      );
    }
  }

  return { games: [...byId.values()], primaryFailed, credits };
}

// OddsFetchStatus / BackfillStatus live in @/lib/odds-cron-status (pure, so
// the cron-verdict classification is tsx-testable) and are imported above.
// fetchDate is the Eastern-day key this call actually used - every return
// path carries it (not just the write ones) so every caller, including a
// cache-hit/off-season/no-key read, can build the SAME cacheKeys.odds(...)
// key its own write (if any) would have used, without a second, potentially
// racing new Date() call.
type OddsFetchResult = { games: OddsGame[]; status: OddsFetchStatus; credits: OddsApiCredits | null; fetchDate: string };

async function getOddsForSportUncached(sportKey: string): Promise<OddsFetchResult> {
  // Computed first, before the season check - it's a pure local date
  // computation (no DB/network), so moving it ahead of the "out-of-season
  // never touches the cache table or the network at all" guarantee below
  // doesn't weaken that guarantee at all, and every return path needs it.
  const fetchDate = easternDateKey(new Date());

  // Every sport in LIVE_SPORTS used to hit the Odds API bulk endpoint every
  // day year-round, including months of pure off-season - the API charges
  // per markets x regions requested regardless of how many (or how few)
  // games come back, so this was pure waste. Checked first, before any DB
  // read/write, so an out-of-season sport never touches the cache table or
  // the network at all.
  if (!isSportInSeason(sportKey)) return { games: [], status: "off_season", credits: null, fetchDate };

  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (existing) {
    const cachedGames = existing.data as unknown as OddsGame[];
    // Temporary diagnostic for the 2026-08-21 live-page-empty incident -
    // distinguishes "cache hit but the day's snapshot was empty" (e.g. the
    // 4am seed fetch itself failed and got written as [] - it shouldn't per
    // the empty-fetch-doesn't-write logic below, but this catches it if that
    // assumption is ever wrong) from "cache hit, genuinely has games."
    console.log(
      "[getOddsForSport] cache hit",
      JSON.stringify({ sportKey, fetchDate, gameCount: cachedGames.length })
    );
    return { games: cachedGames, status: "cached", credits: null, fetchDate };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("[getOddsForSport] no ODDS_API_KEY configured", JSON.stringify({ sportKey, fetchDate }));
    return { games: [], status: "no_api_key", credits: null, fetchDate };
  }

  // Almost always just [sportKey] - a second entry (the NFL preseason key)
  // appears only during the ~5-week pre-regular-season window, where both are
  // fetched and merged so the last preseason games and the first Week 1 lines
  // are both captured across the handoff (see oddsApiRequestKeys). The cache
  // above and everything below stays keyed on the app's own sportKey.
  const requestKeys = oddsApiRequestKeys(sportKey);
  const { games: mergedRaw, primaryFailed, credits } = await fetchMergedOddsListing(sportKey, requestKeys, apiKey, {
    fetchDate,
  });
  if (credits) {
    await recordBulkUsage(sportKey, mergedRaw.length, credits);
  }
  // Primary (regular-season) key failed -> a real outage, not an empty slate.
  // Return [] WITHOUT writing a row, exactly as the single-key failure path
  // did before, so a later request (or the backfill cron) retries and a real
  // API error stays distinguishable in the logs from a legitimately empty
  // day. A supplementary preseason-key failure alone does not land here -
  // fetchMergedOddsListing logged it and carried on with the primary result.
  if (primaryFailed) return { games: [], status: "fetch_failed", credits, fetchDate };

  const fetchedAt = new Date();
  const games: OddsGame[] = mergedRaw
    // The whole point of caching once/day is to lock in pregame lines - but
    // that only holds if this is the day's first fetch AND it happens before
    // any of that day's games start. Neither is guaranteed: the scheduled
    // cron (see /api/cron/refresh-odds) is meant to win that race, but if
    // anything else (a dev session, a stray request) hits this first, mid-
    // game, the API returns *current* (in-play) prices for already-started
    // games - e.g. a -2400 moneyline on a team already up big late - which
    // would otherwise get cached as if it were the pregame line, permanently,
    // for the rest of the day. Excluding already-started games here means
    // worst case we cache nothing for them (fixable by the cron catching up
    // sportsbook-side next time), never a wrong number silently treated as
    // real - since this feeds real ROI/profit tracking, missing beats wrong.
    .filter((g: OddsGame) => new Date(g.commenceTime) > fetchedAt);
  // Deliberately no upper date bound here - this cache is shared by
  // consumers with genuinely different windows (the odds board wants
  // whatever the Odds API has posted, which for NFL is a full week at once;
  // grading/pregame-facts want today only; bulk-import wants today+tomorrow),
  // and starving the fetch itself to satisfy the narrowest of them silently
  // broke the others (e.g. NFL's odds board going empty days out from a
  // Sunday slate). Each consumer now applies its own window on top of this
  // full cache instead: grading.ts's deriveLedgerFields and pregame-
  // facts.ts's getPregameEventFacts both same-day-scope their own match
  // (with closestByTime disambiguation, same pattern as resolveOddsGame
  // below) precisely to guard the same-team-rematch risk this filter used to
  // paper over; the live ticker (live-ticker.ts) keeps its own same-day
  // display filter independently.

  await prisma.oddsSnapshot.upsert({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    update: { data: games as any },
    create: { sportKey, fetchDate, data: games as any },
  });

  // Temporary diagnostic for the 2026-08-21 live-page-empty incident - a
  // "success" response that came back with mergedCount 0 (or every game
  // already started, so the post-filter games.length is 0 while the upstream
  // actually returned some) is a different failure mode than the upstream
  // error case above, and was equally invisible before this.
  console.log(
    "[getOddsForSport] live fetch cached",
    JSON.stringify({
      sportKey,
      requestKeys,
      fetchDate,
      mergedCount: mergedRaw.length,
      cachedCount: games.length,
    })
  );

  return { games, status: "seeded", credits, fetchDate };
}

// Yesterday's cached OddsSnapshot, read-only - never fetches, never writes.
// The Live tab uses this to carry a game that started last night and is
// still in progress after midnight onto today's board: getOddsForSport is
// keyed to today's Eastern date, so once the clock rolls over, a game whose
// commenceTime was "yesterday" is no longer in the list it returns, and a
// still-live game would otherwise just vanish (see LiveScoreboard, which
// drops these again the moment they go Final). Returns [] if last night's
// snapshot is missing - same "nothing to show" outcome as any other day
// with no cached odds.
export async function getYesterdayOddsForSport(sportKey: string): Promise<OddsGame[]> {
  const fetchDate = easternDateKey(new Date(Date.now() - 86400000));
  const snapshot = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  return snapshot ? (snapshot.data as unknown as OddsGame[]) : [];
}

// Runs periodically (see /api/cron/backfill-odds), well after the once-daily
// seed fetch above. That seed fetch locks in OddsSnapshot for the rest of
// the day the moment it succeeds - so a game whose sportsbook lines simply
// weren't posted yet when it ran (a doubleheader nightcap, a weather-
// rescheduled game, anything late) is silently absent from the cache with no
// other path to ever pick it up before the next day's seed fetch. This adds
// exactly those missing games and nothing else: it diffs a fresh API
// response against what's already cached today by the Odds API's own event
// id and only appends games not already present. Every already-cached game
// is left byte-for-byte untouched - in particular this must never refresh an
// already-cached game's price with a current/in-play one, same reason
// getOddsForSport excludes started games from its own fetch below.
//
// True only for the one BackfillStatus where the update below actually ran -
// every other status ("off_season"/"no_base_row"/"no_api_key"/"all_started"/
// "fetch_failed"/"nothing_missing") leaves the cache's current contents
// accurate, same reasoning as oddsWriteInvalidatesCache above. This being a
// partial/additive write (only appends missing games) rather than a full
// reseed doesn't change whether to invalidate - it still changed what the
// row contains, which is the only condition that matters here.
export function backfillWriteInvalidatesCache(status: BackfillStatus): boolean {
  return status === "added";
}

export async function backfillOddsForSport(sportKey: string): Promise<{ added: number; status: BackfillStatus }> {
  if (!isSportInSeason(sportKey)) return { added: 0, status: "off_season" };

  const fetchDate = easternDateKey(new Date());

  // Nothing to merge into - creating today's first snapshot is
  // getOddsForSport's job (via the seed cron, or a page load that beats it),
  // not this function's. Running the full fetch below without an existing
  // row would just duplicate that path for no benefit.
  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
  });
  if (!existing) return { added: 0, status: "no_base_row" };

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { added: 0, status: "no_api_key" };

  const existingGames = existing.data as unknown as OddsGame[];
  const existingIds = new Set(existingGames.map((g) => g.id));

  // Credit-cost guard: once every game already cached for today has started,
  // there's nothing left this function could add for today - it only ever
  // appends not-yet-started games (see the already-started filter below), so
  // a still-missing game that has ALSO already started is unrecoverable
  // either way, same "missing beats wrong" tradeoff as everywhere else in
  // this file. Skipping here avoids an API call - and its Odds API credit
  // cost (markets x regions, not free) - that's guaranteed to find nothing.
  // Only skips when there's at least one cached game for today AND all of
  // them have started: an empty todayGames list (e.g. the 4am seed fetch
  // found nothing posted yet) must NOT skip, since that's exactly the
  // "genuinely still missing" case this function exists to catch - the
  // original doubleheader-nightcap incident this was built for.
  const now = new Date();
  const todayGames = existingGames.filter((g) => easternDateKey(new Date(g.commenceTime)) === fetchDate);
  if (todayGames.length > 0 && todayGames.every((g) => new Date(g.commenceTime) <= now)) {
    return { added: 0, status: "all_started" };
  }

  // Same key selection + merge as getOddsForSport's own fetch (single key for
  // ~11 months, the regular + preseason pair during the NFL handoff window).
  // A primary-key failure aborts this additive pass the same way `!res.ok`
  // did before; a preseason-key-only failure is logged and ignored.
  const requestKeys = oddsApiRequestKeys(sportKey);
  const { games: mergedRaw, primaryFailed, credits } = await fetchMergedOddsListing(sportKey, requestKeys, apiKey, {
    fetchDate,
  });
  if (credits) {
    await recordBulkUsage(sportKey, mergedRaw.length, credits);
  }
  if (primaryFailed) return { added: 0, status: "fetch_failed" };

  const fetchedAt = new Date();
  const freshGames: OddsGame[] = mergedRaw
    // Identical pregame-only guarantee as getOddsForSport's own fetch - a
    // game already under way must never get captured at all here either, so
    // an in-play price can't sneak into the cache as if it were the pregame
    // line. A game that started before ANY fetch (seed or backfill) ever
    // saw it stays permanently missing - that's the existing, deliberate
    // "missing beats wrong" tradeoff, unchanged by this function.
    .filter((g: OddsGame) => new Date(g.commenceTime) > fetchedAt)
    // The raw endpoint has no date bound - it's whatever the API currently
    // has odds posted for, which by evening already includes tomorrow's
    // slate. getOddsForSport gets away without this filter because its one
    // fetch always runs at 4am ET, hours before any future day's lines are
    // posted - but this function runs all day, so without this it would
    // "backfill" every future day's entire slate into today's row on every
    // run. Confirmed live: an unfiltered run at ~8pm ET pulled in 16 of
    // tomorrow's games alongside the 1 real gap it was meant to fill.
    .filter((g: OddsGame) => easternDateKey(new Date(g.commenceTime)) === fetchDate);

  const missingGames = freshGames.filter((g) => !existingIds.has(g.id));
  if (missingGames.length === 0) return { added: 0, status: "nothing_missing" };

  await prisma.oddsSnapshot.update({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    data: { data: [...existingGames, ...missingGames] as any },
  });

  // Same try/catch/log-and-continue treatment as seedOddsSnapshot - this
  // runs from the real cron Route Handler in production, where
  // revalidateTag is safe, but a failed invalidation must never fail the
  // write it's reporting on regardless. Uses this call's own local
  // fetchDate (already matches the WHERE clause above), never a second
  // new Date() computation.
  if (backfillWriteInvalidatesCache("added")) {
    try {
      revalidateTag(cacheKeys.odds(sportKey, fetchDate));
    } catch (err) {
      console.error(
        "[backfillOddsForSport] revalidateTag failed - odds write succeeded, cache invalidation did not; TTL backstop will catch up",
        JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) })
      );
    }
  }

  return { added: missingGames.length, status: "added" };
}

export async function getMlbLiveScores(): Promise<ScoreGame[]> {
  const yesterday = easternDateKey(new Date(Date.now() - 86400000));
  const tomorrow = easternDateKey(new Date(Date.now() + 86400000));
  const url =
    "https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=" +
    yesterday +
    "&endDate=" +
    tomorrow +
    "&hydrate=linescore";

  // No per-fetch cache directive here on purpose: live-score caching is owned
  // by getLiveScoresForSport's wrapper (see ttl-memo.ts) - a short
  // TTL layer that fetches once per sport per window and serves that to every
  // polling client. Setting no-store here as well would conflict with the
  // unstable_cache boundary that wrapper puts around this call.
  const res = await fetch(url);
  if (!res.ok) return [];

  const data = await res.json();
  const games = (data.dates ?? []).flatMap((d: any) => d.games ?? []);

  return games.map((g: any) => {
    const state = g.status?.abstractGameState;
    const status: "preview" | "live" | "final" =
      state === "Final" ? "final" : state === "Live" ? "live" : "preview";

    return {
      id: String(g.gamePk),
      homeTeam: g.teams.home.team.name,
      awayTeam: g.teams.away.team.name,
      status,
      scores:
        status === "preview"
          ? null
          : [
              { name: g.teams.home.team.name, score: String(g.teams.home.score ?? 0) },
              { name: g.teams.away.team.name, score: String(g.teams.away.score ?? 0) },
            ],
      commenceTime: g.gameDate,
      inningHalf: status === "live" ? (g.linescore?.inningState ?? null) : null,
      inningOrdinal: status === "live" ? (g.linescore?.currentInningOrdinal ?? null) : null,
      // Already present on every game in this same response (confirmed live,
      // 2026-09-25) - was simply never read before. gameNumber is 1 for a
      // single game (not just for game 1 of a doubleheader), so it's only
      // meaningful together with doubleHeaderStatus.
      gameNumber: typeof g.gameNumber === "number" ? g.gameNumber : null,
      doubleHeaderStatus: g.doubleHeader ?? null,
      innings:
        status === "live" || status === "final"
          ? (g.linescore?.innings ?? []).map((i: any) => ({
              num: i.num,
              home: typeof i.home?.runs === "number" ? { runs: i.home.runs } : null,
              away: typeof i.away?.runs === "number" ? { runs: i.away.runs } : null,
            }))
          : null,
    };
  });
}

// Maps one ESPN scoreboard event to our ScoreGame shape - shared by every
// per-date fetch getEspnScores fans out (see below).
function espnEventToScoreGame(e: any): ScoreGame {
  const competitors = e.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  const state = e.status?.type?.state;
  const status: "preview" | "live" | "final" = state === "post" ? "final" : state === "in" ? "live" : "preview";

  return {
    id: String(e.id),
    homeTeam: home?.team?.displayName ?? "",
    awayTeam: away?.team?.displayName ?? "",
    status,
    scores:
      status === "preview"
        ? null
        : [
            { name: home?.team?.displayName ?? "", score: String(home?.score ?? 0) },
            { name: away?.team?.displayName ?? "", score: String(away?.score ?? 0) },
          ],
    commenceTime: e.date,
    inningHalf: null,
    inningOrdinal: null,
    innings: null,
    period: status === "live" ? (e.status?.period ?? null) : null,
    clock: status === "live" ? (e.status?.displayClock ?? null) : null,
  } as ScoreGame;
}

// Fetches one day's scoreboard. ESPN's `dates` param used to accept a
// YYYYMMDD-YYYYMMDD range (see getEspnScores below for why that no longer
// works) but a single YYYYMMDD date has always been - and still is -
// accepted, so this is the unit getEspnScores fans out over the window with.
// A non-ok response is logged (sportPath, dateKey, status) and treated as
// "no events for this date" rather than failing the whole window - one bad
// date (a transient blip, an ESPN-side hiccup) shouldn't blank out the two
// good ones alongside it.
//
// Deliberately NO `limit` param (see getEspnScores' note above `groups=80` -
// this used to carry `limit=1000` to defend against the OLD range-request's
// ~25-event default-page truncation). A 2026-09-21 investigation into 63
// stuck NCAAF picks found `limit` on THIS per-date endpoint is now actively
// harmful, not just unnecessary: ESPN caps the response at exactly 25 events
// whenever `limit` is set above ~500 (confirmed live: limit=500 -> 71 events
// on a real 71-game Saturday, limit=600/1000/2000 -> 25 events, same day,
// repeated 5x, 100% consistent), and `limit` below that threshold behaves
// erratically too (limit=25 -> 50 events, limit=26 -> 52 events - NOT a
// simple page size). `page` is a no-op (page=1 and page=2 return byte-
// identical event lists), so there is no real pagination to fall back to
// either. Omitting `limit` entirely was verified live across 4 different
// high-volume Saturdays (2026-08-29: 8 events, 09-05: 68, 09-12: 80,
// 09-19: 71 - each stable across repeat calls) and reliably returns the
// FULL slate every time. The per-date fetch this function makes (vs. the
// old 3-day range) already solves the original truncation concern on its
// own - a single day's real event count never approaches whatever ESPN's
// actual unparameterized default page size is.
async function getEspnScoresForDate(
  sportPath: string,
  dateKey: string,
  options: { groups?: string } = {}
): Promise<any[]> {
  const params = new URLSearchParams({ dates: dateKey });
  if (options.groups) params.set("groups", options.groups);
  const url =
    "https://site.api.espn.com/apis/site/v2/sports/" + sportPath + "/scoreboard?" + params.toString();

  // Same as getMlbLiveScores: no per-fetch cache directive here - caching is
  // owned by getLiveScoresForSport's short-TTL wrapper (ttl-memo.ts).
  const res = await fetch(url);
  if (!res.ok) {
    console.error(
      "[getEspnScoresForDate] non-ok response - treating as no events for this date",
      JSON.stringify({ sportPath, dateKey, groups: options.groups ?? null, url, status: res.status })
    );
    return [];
  }

  const data = await res.json();
  return data.events ?? [];
}

// Shared by every ESPN-backed score source (NBA, WNBA, ...) - ESPN's free
// public scoreboard endpoint (no key required, same "free/unauthenticated"
// pattern as MLB Stats API) has an identical response shape across sports,
// just a different URL path segment. This only covers full-game status/
// scores, enough for live display and full-game Moneyline/Spread/Total
// grading - first-half and touchdown-prop grading need the heavier
// per-event summary endpoint instead (see getNflGameFacts and
// getNflPlayerTdStats below, NFL-only for now).
//
// One request PER DATE across yesterday..tomorrow, not a single
// dates=YYYYMMDD-YYYYMMDD range request: ESPN's scoreboard now rejects the
// range form outright (HTTP 400 "Failed to get events endpoint.", confirmed
// live against football/nfl, football/college-football, and basketball/wnba
// - a single date on the same endpoint returns 200 fine). The old range call
// silently swallowed that 400 into an empty score feed for every ESPN sport,
// which was invisible for upcoming games (the odds-feed fallback in
// resolveScheduleGameFromFeeds still had them) but broke catalog-import
// matching and grading for every completed game, since a finished game has
// no odds-feed fallback to hide behind.
async function getEspnScores(sportPath: string, options: { groups?: string } = {}): Promise<ScoreGame[]> {
  const fmt = (d: Date) => easternDateKey(d).replace(/-/g, "");
  const dateKeys = [
    fmt(new Date(Date.now() - 86400000)),
    fmt(new Date()),
    fmt(new Date(Date.now() + 86400000)),
  ];

  const perDateEvents = await Promise.all(dateKeys.map((dateKey) => getEspnScoresForDate(sportPath, dateKey, options)));
  const events = perDateEvents.flat();

  // Lightweight completeness signal: this is a plain visibility line, not a
  // truncation detector - see getEspnScoresForDate's note on why `limit` was
  // removed entirely (ESPN's truncation there was a hard-coded ~25-event cap
  // unrelated to the requested limit value, not a page-size match, so an
  // "actual === requested" check would never have fired for it and isn't
  // implemented here). Cheap to leave in regardless - one line per sport per
  // TTL window (~15s) - so a suspiciously low count is still visible in logs
  // for a human to notice.
  console.log(
    "[getEspnScores]",
    sportPath,
    "dates=" + dateKeys.join(","),
    options.groups ? "groups=" + options.groups : "",
    "->",
    events.length,
    "events"
  );

  // Dedupe by event id: each per-date request is its own independent window,
  // so an event ESPN buckets oddly close to a day boundary could in theory
  // show up under two adjacent date keys.
  const seen = new Set<string>();
  const games: ScoreGame[] = [];
  for (const e of events) {
    const id = String(e.id);
    if (seen.has(id)) continue;
    seen.add(id);
    games.push(espnEventToScoreGame(e));
  }
  return games;
}

export function getNbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/nba");
}

export function getWnbaLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("basketball/wnba");
}

export function getNflLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("football/nfl");
}

// Same shared ESPN scoreboard helper as every other ESPN-backed sport above,
// just a different sport path - confirmed live (real FBS week-1 coverage,
// same response shape) before adding this during the NCAAF ecosystem
// investigation. groups=80 pins it to FBS (see getEspnScores' note) - the
// one sport where the default response is both truncated and
// division-mixed.
export function getNcaafLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("football/college-football", { groups: "80" });
}

// Same shared ESPN scoreboard helper again, sport path "hockey/nhl".
// Confirmed live (real 2025-26 regular-season, overtime, and shootout finals,
// plus preseason previews) during the NHL grading build: identical
// `events[].competitions[0].competitors[]` shape as every other ESPN sport -
// `competitor.score` is the final score INCLUDING overtime and the shootout
// deciding goal, which is exactly what sportsbooks grade NHL moneyline / puck
// line / total against, so no OT/SO-specific handling is needed here or in
// gradePick. Per-period `linescores` from the summary endpoint feed P1-P3
// grading (getEspnGameSegments -> GameResult.linescoreJson); "Final/OT" /
// "Final/SO" status details remain unused (the score already accounts for them).
//
// icehockey_nhl is in RESOLVABLE_SPORT_KEYS, so the grade cron / live routes /
// catalog-import game resolution all reach this - but the NHL season gate
// (SPORT_SEASON_CONFIG: 2026-10-07) keeps it inert until the season opens.
export function getNhlLiveScores(): Promise<ScoreGame[]> {
  return getEspnScores("hockey/nhl");
}

// How many days back The Odds API's /scores endpoint is asked to include
// completed games. 3 covers a Thursday-Saturday CFL slate even if the grade
// cron didn't run again until Monday. daysFrom is what makes /scores return
// completed games at all (without it the endpoint is upcoming + live only) -
// and it also doubles the credit cost of the call from 1 to 2.
const CFL_SCORE_DAYS_FROM = 3;

// How far around a CFL game's start time getCflLiveScores is allowed to hit
// the paid /scores endpoint (see cflGameWithinScoreWindow). 7h back covers a
// ~3h game plus a wide margin for a late final; 1h forward lets the first
// poll land just before kickoff.
const CFL_SCORE_WINDOW_BEFORE_MS = 7 * 60 * 60 * 1000;
const CFL_SCORE_WINDOW_AFTER_MS = 60 * 60 * 1000;

// CFL has no free score source - ESPN dropped CFL coverage after 2022 and
// the official api.cfl.ca is discontinued - so scores come from The Odds
// API's own /scores endpoint at 2 credits per call (daysFrom is required to
// get completed games). The grade cron would otherwise poll this every 15
// minutes all season for a league that plays ~4 games a week, ~90% of those
// calls returning nothing. This gate reads the already-cached CFL
// OddsSnapshot (no API call, no cost) and only allows the /scores fetch when
// a CFL game is currently in progress or just finished. In the dormant state
// (no CFL OddsSnapshot because CFL isn't in LIVE_SPORTS / SPORT_SEASON_CONFIG
// yet) there are no rows, so this returns false and getCflLiveScores never
// hits the network.
async function cflGameWithinScoreWindow(): Promise<boolean> {
  const today = easternDateKey(new Date());
  const yesterday = easternDateKey(new Date(Date.now() - 86400000));
  const snapshots = await prisma.oddsSnapshot.findMany({
    where: { sportKey: "americanfootball_cfl", fetchDate: { in: [today, yesterday] } },
    select: { data: true },
  });
  const now = Date.now();
  for (const snapshot of snapshots) {
    for (const game of snapshot.data as unknown as OddsGame[]) {
      const start = new Date(game.commenceTime).getTime();
      if (start <= now + CFL_SCORE_WINDOW_AFTER_MS && start >= now - CFL_SCORE_WINDOW_BEFORE_MS) {
        return true;
      }
    }
  }
  return false;
}

// CFL live/final scores from The Odds API's /scores endpoint - the ONLY
// viable source (see cflGameWithinScoreWindow's note). Unlike every
// getEspnScores-backed sport this hits a paid, authenticated endpoint, so
// callers reach it through dispatchLiveScoresForSport, which applies both the
// season gate and the score-window gate first. The response is flat
// (home_team/away_team/completed/scores), not ESPN's nested
// competitions[].competitors[] - and its event `id` is the SAME id as the
// odds snapshot's (same provider), so game resolution against the odds
// board is exact with no team-name matching needed.
//
// NOT yet wired for grading: americanfootball_cfl is absent from
// RESOLVABLE_SPORT_KEYS, LIVE_SPORTS, and SPORT_SEASON_CONFIG, so nothing
// reaches this in production. Built dormant per
// docs/sports-props-expansion-plan.md.
export async function getCflLiveScores(): Promise<ScoreGame[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("[getCflLiveScores] no ODDS_API_KEY configured");
    return [];
  }

  const url =
    BASE_URL +
    "/sports/americanfootball_cfl/scores/?apiKey=" +
    apiKey +
    "&daysFrom=" +
    CFL_SCORE_DAYS_FROM +
    "&dateFormat=iso";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    console.error(
      "[getCflLiveScores] upstream fetch failed",
      JSON.stringify({ status: res.status, statusText: res.statusText, body: bodyText.slice(0, 500) })
    );
    return [];
  }

  const raw = await res.json();
  if (!Array.isArray(raw)) return [];

  return raw.map((g: any): ScoreGame => {
    // completed -> final; has partial scores but not completed -> live;
    // no scores yet -> preview. Mirrors ESPN's post/in/pre mapping.
    const status: "preview" | "live" | "final" = g.completed ? "final" : g.scores ? "live" : "preview";
    return {
      id: String(g.id),
      homeTeam: g.home_team,
      awayTeam: g.away_team,
      status,
      scores: Array.isArray(g.scores)
        ? g.scores.map((s: any) => ({ name: s.name, score: String(s.score) }))
        : null,
      commenceTime: g.commence_time,
      // CFL has no half/inning data from this endpoint - full-game only, same
      // initial scope as every ESPN-backed sport.
      inningHalf: null,
      inningOrdinal: null,
      innings: null,
    };
  });
}

// Sports with a real score source wired up (see getLiveScoresForSport below).
// The rest of LIVE_SPORTS still get odds display, just no live score/badge,
// game resolution, or auto-grading yet - add a key here (and a case below)
// once a free score source is wired up for it.
export const RESOLVABLE_SPORT_KEYS = [
  "baseball_mlb",
  "basketball_nba",
  "basketball_wnba",
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  // NHL: free score source (getNhlLiveScores) is confirmed live and has an
  // acceptance test; full-game grading needs no NHL-specific code (see
  // nhl-grading-acceptance-test.ts), and per-period grading (P1-P3) is wired
  // via getEspnGameSegments + GameResult.linescoreJson. Inert until the NHL
  // season window opens (SPORT_SEASON_CONFIG: 2026-10-07) - the season gate
  // in dispatchLiveScoresForSport returns [] before then.
  "icehockey_nhl",
];

// Dispatches to the right free score source for a sport. Add a case here
// (and a getXLiveScores() above) when wiring up a new sport.
async function dispatchLiveScoresForSport(sportKey: string): Promise<ScoreGame[]> {
  if (sportKey === "baseball_mlb") return getMlbLiveScores();
  if (sportKey === "basketball_nba") return getNbaLiveScores();
  if (sportKey === "basketball_wnba") return getWnbaLiveScores();
  if (sportKey === "americanfootball_nfl") {
    // ESPN's scoreboard is free either way, but off-season it's just
    // preseason noise - gating it keeps preseason games out of live
    // display, catalog-import game resolution, and auto-grading alike,
    // not only the credit-costing Odds API side.
    if (!isSportInSeason(sportKey)) return [];
    return getNflLiveScores();
  }
  if (sportKey === "americanfootball_ncaaf") {
    // Same reasoning as NFL above - off-season (including spring games)
    // would otherwise leak into live display/game resolution/grading as
    // pure noise.
    if (!isSportInSeason(sportKey)) return [];
    return getNcaafLiveScores();
  }
  if (sportKey === "icehockey_nhl") {
    // Same season gate as NFL/NCAAF above - NHL preseason (late September)
    // is on ESPN's scoreboard too, and SPORT_SEASON_CONFIG's NHL window is
    // regular-season-only (starts Oct 7), so this keeps preseason games out
    // of live display and grading. Reachable only once icehockey_nhl is
    // added to RESOLVABLE_SPORT_KEYS - see getNhlLiveScores' note.
    if (!isSportInSeason(sportKey)) return [];
    return getNhlLiveScores();
  }
  if (sportKey === "americanfootball_cfl") {
    // Two gates, not one, because CFL scores are NOT free - each getCflLiveScores
    // call spends 2 Odds API credits (see its note). Season gate first (cheap,
    // and it short-circuits the whole thing in the dormant state since CFL has
    // no SPORT_SEASON_CONFIG entry yet); then the score-window gate, which reads
    // only the already-cached OddsSnapshot, so the paid /scores endpoint is hit
    // only while a CFL game is actually in progress or just finished. Reachable
    // only once americanfootball_cfl is added to RESOLVABLE_SPORT_KEYS.
    if (!isSportInSeason(sportKey)) return [];
    if (!(await cflGameWithinScoreWindow())) return [];
    return getCflLiveScores();
  }
  return [];
}

// Cross-instance layer: unstable_cache stores the parsed result in the
// Next.js Data Cache, which on Vercel is shared across every serverless
// instance - so one upstream fetch per sport per TTL serves the whole fleet.
// The result is small and the whole point is to be current-ish, so the TTL is
// short (LIVE_SCORES_TTL_SECONDS, default 15). Tagged so a manual purge is
// possible if ever needed.
//
// Outside a Next request/render context (bare scripts, the tsx acceptance
// tests) there is no incremental cache and unstable_cache rejects with an
// invariant - fall back to calling straight through in that case. Real
// traffic (route handlers, cron routes) always has the context.
function dataCachedLiveScores(sportKey: string): Promise<ScoreGame[]> {
  const run = unstable_cache(() => dispatchLiveScoresForSport(sportKey), [cacheKeys.liveScores(sportKey)], {
    revalidate: LIVE_SCORES_TTL_SECONDS,
    tags: [cacheKeys.liveScores(sportKey)],
  });
  return run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("incrementalCache")) return dispatchLiveScoresForSport(sportKey);
    throw err;
  });
}

// Public entry point. memoizeWithTtl is the process-local layer in front of
// the Data Cache - see ttl-memo.ts for why both exist.
export async function getLiveScoresForSport(sportKey: string): Promise<ScoreGame[]> {
  return memoizeWithTtl(cacheKeys.liveScores(sportKey), () => dataCachedLiveScores(sportKey), {
    ttlMs: LIVE_SCORES_TTL_SECONDS * 1000,
  });
}

export type MlbEarlyInningScores = {
  firstInning: { home: number; away: number } | null;
  firstFive: { home: number; away: number } | null;
};

// Reads innings 1 and 1-5 from a finished game's linescore in a single
// fetch, for grading NRFI and F5/first-half picks respectively. Only call
// this once a game is Final - mid-game, a still-in-progress inning would
// report an incomplete (and misleading) score for whichever team hasn't
// batted yet. The schedule endpoint used by getMlbLiveScores() doesn't
// include inning-by-inning data, so this hits the heavier live-feed
// endpoint - only worth it for the one-time capture per game (both values
// share this one fetch rather than each needing their own).
export async function getMlbEarlyInningScores(gamePk: string): Promise<MlbEarlyInningScores> {
  const res = await fetch("https://statsapi.mlb.com/api/v1.1/game/" + gamePk + "/feed/live", {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return { firstInning: null, firstFive: null };

  const data = await res.json();
  const innings = data.liveData?.linescore?.innings ?? [];

  const inning1 = innings.find((i: any) => i.num === 1);
  const firstInning = inning1 ? { home: inning1.home?.runs ?? 0, away: inning1.away?.runs ?? 0 } : null;

  const firstFiveInnings = innings.filter((i: any) => i.num <= 5);
  let firstFive: { home: number; away: number } | null = null;
  if (firstFiveInnings.length >= 5) {
    let home = 0;
    let away = 0;
    for (const inning of firstFiveInnings) {
      home += inning.home?.runs ?? 0;
      away += inning.away?.runs ?? 0;
    }
    firstFive = { home, away };
  }

  return { firstInning, firstFive };
}

export type NflGameFacts = {
  // Q1+Q2 summed - same value the old getNflFirstHalfScore returned, for
  // grading 1st-half Moneyline/Spread/Total picks.
  firstHalf: { home: number; away: number } | null;
  // Per-quarter {home, away} score array (Q1..Q4, plus any OT periods), in
  // order - feeds NFL Game Pulse's leadingAtHalftime and trailingEntering4th
  // questions (see nfl-game-pulse-situations.ts). Persisted as
  // GameResult.quartersJson.
  quarters: { home: number; away: number }[] | null;
  // Every scoring play in the game, in chronological order, as {home, away}
  // running score snapshots (the score immediately after that play) - which
  // team scored on a given play is derivable from which number increased,
  // so team identity doesn't need to be captured separately. Empty array
  // (not null) for a genuine scoreless game; null only when ESPN didn't
  // return this field at all. Feeds scoredFirst and ledByDoubleDigits.
  // Persisted as GameResult.scoringPlaysJson.
  scoringPlays: { home: number; away: number }[] | null;
  // Turnovers (interceptions thrown + fumbles lost) per team, from ESPN's
  // boxscore team statistics. Feeds wonTurnoverBattle. Persisted as
  // GameResult.homeTurnovers/awayTurnovers.
  turnovers: { home: number; away: number } | null;
};

// Single fetch to ESPN's NFL summary endpoint - replaces the old
// getNflFirstHalfScore (which hit this same URL for Q1+Q2 alone) with
// everything persistFinalScores needs to capture for a finished NFL game in
// one round trip: first-half score (unchanged grading behavior), the full
// per-quarter linescore and scoring-play margin trail for NFL Game Pulse,
// and each team's turnover count. getNflPlayerTdStats below stays a
// separate fetch to this same endpoint deliberately - it's called
// independently at touchdown-prop GRADING time (resolveTouchdownProp, once
// per pending prop pick), not at this capture-time step, so folding it in
// here wouldn't actually eliminate a redundant call. Only call this once a
// game is Final - a still-in-progress game would report incomplete
// quarters/scoring plays, same caution as getMlbEarlyInningScores.
export async function getNflGameFacts(eventId: string): Promise<NflGameFacts | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const competitors = data.header?.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  if (!home || !away) return null;

  // Each competitor's `linescores` entries only carry a `displayValue`
  // string (confirmed against real final games), no numeric `value` field,
  // so this parses it. Missing/empty entirely -> null (no usable checkpoint
  // at all) - a real finished NFL game always has at least 4 linescores, so
  // there's no legitimate "empty but valid" case to preserve here, unlike
  // scoringPlays below.
  const parseQuarterValues = (linescores: any[] | undefined): number[] | null => {
    if (!linescores || linescores.length === 0) return null;
    const values = linescores.map((l: any) => parseFloat(l?.displayValue ?? ""));
    return values.some((v) => Number.isNaN(v)) ? null : values;
  };
  const homeQuarterValues = parseQuarterValues(home.linescores);
  const awayQuarterValues = parseQuarterValues(away.linescores);

  let quarters: { home: number; away: number }[] | null = null;
  if (homeQuarterValues && awayQuarterValues && homeQuarterValues.length === awayQuarterValues.length) {
    quarters = homeQuarterValues.map((h, i) => ({ home: h, away: awayQuarterValues[i] }));
  }

  const firstHalf =
    quarters && quarters.length >= 2
      ? { home: quarters[0].home + quarters[1].home, away: quarters[0].away + quarters[1].away }
      : null;

  // Array.isArray, not a length/truthiness check - a genuinely scoreless
  // game (0-0) legitimately has an empty scoringPlays array, distinct from
  // ESPN not returning the field at all (null, "we don't have this data").
  const scoringPlays: { home: number; away: number }[] | null = Array.isArray(data.scoringPlays)
    ? data.scoringPlays.map((p: any) => ({ home: p.homeScore ?? 0, away: p.awayScore ?? 0 }))
    : null;

  const boxscoreTeams = data.boxscore?.teams ?? [];
  const homeBox = boxscoreTeams.find((t: any) => t.homeAway === "home");
  const awayBox = boxscoreTeams.find((t: any) => t.homeAway === "away");
  const findTurnovers = (team: any): number | null => {
    const stat = team?.statistics?.find((s: any) => s.name === "turnovers");
    const parsed = stat ? parseInt(stat.displayValue, 10) : NaN;
    return Number.isNaN(parsed) ? null : parsed;
  };
  const homeTurnovers = findTurnovers(homeBox);
  const awayTurnovers = findTurnovers(awayBox);
  const turnovers = homeTurnovers !== null && awayTurnovers !== null ? { home: homeTurnovers, away: awayTurnovers } : null;

  return { firstHalf, quarters, scoringPlays, turnovers };
}

export type EspnGameSegments = {
  // Ordered per-quarter (football/basketball) or per-period (hockey)
  // {home, away} scores, straight from ESPN's summary-endpoint linescores.
  // Any overtime / shootout entries are left on the end (index >= 4 for
  // football/basketball, >= 3 for hockey), so a Q4 / P3 read never picks
  // them up. null if the linescores are missing or any entry is non-numeric.
  linescore: { home: number; away: number }[] | null;
  // Q1+Q2 sum - the first-half score for football/basketball, grading's
  // Period.FIRST_HALF source (same value getNflGameFacts.firstHalf returns).
  // null for hockey (no first-half market) and whenever linescore is null or
  // shorter than two entries.
  firstHalf: { home: number; away: number } | null;
};

// The ESPN summary-endpoint sport path for each sport whose per-segment
// linescore grading reads. Confirmed live for all five (NFL/NCAAF/NBA/WNBA
// via the earlier first-half work, NHL during this build): identical
// `header.competitions[0].competitors[].linescores[].displayValue` shape,
// string values only (no numeric `value` field). Football/basketball have 4
// quarter entries; NHL has 3 period entries, plus a 4th for OT and a 5th for
// a shootout on games that reach them.
const ESPN_SUMMARY_SPORT_PATH: Record<string, string> = {
  americanfootball_nfl: "football/nfl",
  americanfootball_ncaaf: "football/college-football",
  basketball_nba: "basketball/nba",
  basketball_wnba: "basketball/wnba",
  icehockey_nhl: "hockey/nhl",
};

function parseEspnLinescores(data: any): { home: number; away: number }[] | null {
  const competitors = data?.header?.competitions?.[0]?.competitors ?? [];
  const home = competitors.find((c: any) => c.homeAway === "home");
  const away = competitors.find((c: any) => c.homeAway === "away");
  const nums = (linescores: any[] | undefined): number[] | null => {
    if (!Array.isArray(linescores) || linescores.length === 0) return null;
    const v = linescores.map((l: any) => parseFloat(l?.displayValue ?? ""));
    return v.some((n) => Number.isNaN(n)) ? null : v;
  };
  const h = nums(home?.linescores);
  const a = nums(away?.linescores);
  if (!h || !a || h.length !== a.length) return null;
  return h.map((hv, i) => ({ home: hv, away: a[i] }));
}

// One fetch to ESPN's per-event summary endpoint for a FINAL game, returning
// its per-segment linescore (+ derived first-half sum). Replaces the old
// per-sport getNcaafFirstHalfScore / getNbaFirstHalfScore first-half-only
// helpers with one function covering NCAAF, NBA, WNBA and NHL - NFL keeps its
// own getNflGameFacts (which also pulls Game Pulse data from the same fetch).
// Only call once a game is Final: an in-progress game reports incomplete
// segments, same caution as getNflGameFacts / getMlbEarlyInningScores.
export async function getEspnGameSegments(sportKey: string, eventId: string): Promise<EspnGameSegments | null> {
  const path = ESPN_SUMMARY_SPORT_PATH[sportKey];
  if (!path) return null;
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/" + path + "/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const linescore = parseEspnLinescores(data);
  const firstHalf =
    sportKey !== "icehockey_nhl" && linescore && linescore.length >= 2
      ? { home: linescore[0].home + linescore[1].home, away: linescore[0].away + linescore[1].away }
      : null;
  return { linescore, firstHalf };
}

export type NflPlayerTdStats = {
  playerName: string;
  rushTds: number;
  recTds: number;
  // Passing-category fields, parsed the same way as rushTds/recTds but NOT
  // yet read by any grading path (PLAYER_PROP still means TD-prop only -
  // see resolveTouchdownProp in grading.ts). Added to prove the data is
  // extractable ahead of the passing-prop schema work; 0 for a player with
  // no passing line at all, same "present with zeros" convention as
  // rushTds/recTds.
  passTds: number;
  passYards: number;
  passAttempts: number;
  passCompletions: number;
};

// Every player who appears anywhere in a finished NFL game's box score, with
// their rushing and receiving TD counts (0 if they have a stat line in that
// category but no TD there; genuinely absent from the map entirely if they
// don't appear in the box score at all, e.g. a name that doesn't match
// anyone who played). Scans every statistics category (not just rushing/
// receiving) so a player is still present with rushTds/recTds both 0 if
// they only show up elsewhere (e.g. a QB who only has a passing line) -
// callers use "found in this map" vs "not found at all" to tell a confident
// 0-TD grade apart from a name that couldn't be matched to anyone in the
// game (see gradeTouchdownProp in grading.ts). Confirmed against a real
// final game's response shape: each category has its own `labels` array and
// a `TD` column isn't always at the same index across categories, so the
// index is looked up per-category rather than hardcoded.
//
// The passing category (confirmed against real Week 1 2026 box scores) uses
// labels ["C/ATT","YDS","AVG","TD","INT","SACKS","QBR","RTG"] - completions
// and attempts are NOT separate columns, they're one combined "20/29"
// string under "C/ATT" that has to be split on "/". Every other stat here
// (YDS, TD) is a plain per-column number same as rushing/receiving.
// Multi-QB games are common, not an edge case: a backup mopping up, a
// gadget-play pass from a non-QB, or a punter (seen for real in a Week 1
// game) can all produce a second passing-category athlete with 0-1
// attempts. Each such athlete still gets its own map entry keyed by name,
// same as any other stat category here - nothing about a backup or
// trick-play passer breaks this parsing, it just means a team can map to
// more than one passer for a given game.
export async function getNflPlayerTdStats(eventId: string): Promise<NflPlayerTdStats[] | null> {
  const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=" + eventId, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const teams = data.boxscore?.players ?? [];
  if (teams.length === 0) return null;

  const byPlayer = new Map<string, NflPlayerTdStats>();

  for (const team of teams) {
    for (const category of team.statistics ?? []) {
      const labels: string[] = category.labels ?? [];
      const tdIndex = labels.indexOf("TD");
      const passYardsIndex = category.name === "passing" ? labels.indexOf("YDS") : -1;
      const passCAttIndex = category.name === "passing" ? labels.indexOf("C/ATT") : -1;
      for (const athlete of category.athletes ?? []) {
        const name = athlete.athlete?.displayName;
        if (!name) continue;

        const entry =
          byPlayer.get(name) ??
          { playerName: name, rushTds: 0, recTds: 0, passTds: 0, passYards: 0, passAttempts: 0, passCompletions: 0 };
        if (tdIndex !== -1) {
          const tdCount = parseInt(athlete.stats?.[tdIndex] ?? "0", 10) || 0;
          if (category.name === "rushing") entry.rushTds = tdCount;
          else if (category.name === "receiving") entry.recTds = tdCount;
          else if (category.name === "passing") entry.passTds = tdCount;
        }
        if (category.name === "passing") {
          if (passYardsIndex !== -1) entry.passYards = parseInt(athlete.stats?.[passYardsIndex] ?? "0", 10) || 0;
          if (passCAttIndex !== -1) {
            const [completions, attempts] = String(athlete.stats?.[passCAttIndex] ?? "0/0").split("/");
            entry.passCompletions = parseInt(completions, 10) || 0;
            entry.passAttempts = parseInt(attempts, 10) || 0;
          }
        }
        byPlayer.set(name, entry);
      }
    }
  }

  return Array.from(byPlayer.values());
}

// How many Eastern calendar days a candidate game may sit from `referenceTime`
// (import time, normally) and still be accepted as the game a pick refers to.
//
// This has to cover how weekly-sport cappers actually post: an NFL / NCAAF
// slate goes up 2-4 days before kickoff, often the whole upcoming week at
// once (Monday post -> that week's Thursday is +3, Sunday +6, Monday +7). A
// window of 7 does that. It stays a safe guardrail because it is still the
// FALLBACK odds feed (resolveScheduleGameFromFeeds below) that this bounds -
// two NFL / NCAAF teams never play twice inside 7 days, so a same-matchup
// mis-attach is impossible there; for the daily sports the score feed almost
// always has the near game already (so the odds fallback never runs), and
// when it does the same-day / closest-by-time preference still picks the
// soonest of any repeated series. Beyond 7 days a pick is far likelier a
// typo / wrong game than a genuine advance post, so it routes to "add
// manually" instead of guessing.
//
// Was 2 (added 2026-08-29 as a pure backstop, when import resolution only
// ever saw getLiveScoresForSport's yesterday..tomorrow feed): that silently
// dropped ~every pick in an advance-posted weekend slate.
const MAX_RESOLVE_DATE_DRIFT_DAYS = 7;

function withinResolveWindow(commenceTime: string, referenceTime: Date): boolean {
  return withinDateDriftDays(new Date(commenceTime), referenceTime, MAX_RESOLVE_DATE_DRIFT_DAYS);
}

// Sports "gameday" boundary for game-RESOLUTION's same-slate-day comparisons
// only (not dates.ts's general Eastern-calendar-day helpers, which
// intentionally stay on the literal midnight boundary for display/report/
// bucketing elsewhere in the app). The latest first pitch/tipoff among the
// resolvable sports is ~10:30pm ET (West Coast MLB/NBA night games), and
// those games routinely run past midnight ET - importing a pick for one
// right after it ends, or importing ANY late-night pick from a Central-time
// (or further west) capper session, can land at 12:01am-5:59am ET: past
// Eastern midnight by the wall clock, but still unambiguously "tonight's
// slate" to the person typing it in. Without this, sameSlateDay below would
// stop matching a just-finished game the instant the clock ticks past
// midnight ET, and the resolver would fall through to whatever's next for
// that team - the exact wrong-game bug this file exists to prevent, just
// triggered by the clock instead of by a multi-day score-feed window.
// Rolling the slate-day boundary to 6am ET instead of midnight keeps
// sameSlateDay agreeing with what a Central (or Pacific) -time user means by
// "today" for any import that happens before they'd plausibly be asleep.
const SLATE_DAY_ROLLOVER_HOUR_ET = 6;

// en-US + hour12:false can format midnight as "24" instead of "00"
// depending on the ICU/Node build - `% 24` normalizes either back to 0.
function easternHour(date: Date): number {
  const raw = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(raw) % 24;
}

// A timestamp between midnight and SLATE_DAY_ROLLOVER_HOUR_ET ET still
// belongs to the PREVIOUS slate day - step it back 24h so sameEasternDay's
// calendar-day comparison lands there instead of rolling over early.
function slateDayAnchor(date: Date): Date {
  return easternHour(date) < SLATE_DAY_ROLLOVER_HOUR_ET ? new Date(date.getTime() - 24 * 3600000) : date;
}

function sameSlateDay(a: Date, b: Date): boolean {
  return sameEasternDay(slateDayAnchor(a), slateDayAnchor(b));
}

// An OddsGame reshaped as the minimal schedule game the resolver and its
// callers read (id / teams / commenceTime / status). Odds-cache games are
// pregame by construction - getOddsForSportUncached drops anything already
// started before the snapshot was written - and the odds feed is only ever
// consulted here when nothing in the ~yesterday..tomorrow score feed matched,
// so "preview" is the correct status: a game far enough out to be odds-only
// has not kicked off. scores stay null (no live data on the odds side).
function oddsGameToScheduleGame(g: OddsGame): ScoreGame {
  return {
    id: g.id,
    homeTeam: g.homeTeam,
    awayTeam: g.awayTeam,
    status: "preview",
    scores: null,
    commenceTime: g.commenceTime,
    inningHalf: null,
    inningOrdinal: null,
    innings: null,
  };
}

// The tail of resolveGameForNickname / resolveGameForTeams, extracted so both
// share it and it can be unit-tested: from >=1 already-team-and-window-matched
// candidates, prefer one on the same slate day as `referenceTime` (see
// sameSlateDay above), then one that hasn't finished, then whichever started
// closest to `referenceTime`.
//
// Doubleheader guard: when the same-slate-day pool has 2+ candidates for this
// one matchup, a bare pick can't say which game it means on its own -
// `gameNumber` (from the pick's own "Game 2"/"G2"/... text, or a user's
// choice on a previously-flagged pick) resolves this directly:
//   - MLB's own gameNumber metadata (see ScoreGame's doubleHeaderStatus/
//     gameNumber comment) is trusted outright when present, even when it
//     disagrees with start-time order - expected and correct for a "Y"
//     (traditional) doubleheader, where the second game's listed start time
//     is often just a placeholder a few minutes after the first.
//   - Only when that metadata is absent (a non-MLB sport, or a row from
//     before this shipped) does this fall back to start-time order: sort the
//     pool ascending, take index gameNumber-1. Missing (gameNumber=2 but only
//     one game in the pool) returns null - never falls back to game 1.
// With no gameNumber at all, on a pool MLB's own feed marks as a real
// doubleheader (any candidate's doubleHeaderStatus is "Y" or "S"): default to
// the earliest leg that ISN'T final yet (one final + one not -> the not-final
// one; neither final -> the earliest, ordinarily Game 1) rather than refusing
// to guess - a bare "Cubs ML" on a doubleheader day is virtually always about
// whichever leg hasn't been decided yet. Only when EVERY leg is already final
// does this return null (doubleheaderBothLegsFinal: true - the caller shows
// its own "add manually" message, since there's no default left to apply). A
// same-day repeat fixture that ISN'T flagged as a doubleheader
// (doubleHeaderStatus "N", or no metadata for a non-MLB sport) keeps the
// original narrower behavior: flagged only on a genuine finished/not-finished
// split, since that's ambiguous same-team-rematch scheduling, not a
// doubleheader, and still needs a tiebreak rather than a default.
// A lone candidate (no second leg to compare against) is confirmed missing
// its doubleheader partner - by MLB's own metadata - only when it's itself
// tagged as one leg of a real doubleheader and that leg isn't the one asked
// for. A candidate with no doubleheader metadata at all (non-MLB sport, or
// truly just one game on the slate) can't be told apart from "this matchup
// only has one game today" - that residual ambiguity is inherent without an
// authoritative signal, and falls through to "ignore gameNumber, resolve
// normally" as Step 2's spec calls for.
function isConfirmedMissingPartnerLeg(only: ScoreGame, gameNumber: 1 | 2 | null): boolean {
  return (
    gameNumber !== null &&
    (only.doubleHeaderStatus === "Y" || only.doubleHeaderStatus === "S") &&
    only.gameNumber != null &&
    only.gameNumber !== gameNumber
  );
}

// Return shape for pickBestScheduleCandidate (and everything that simply
// passes its result through - resolveScheduleGameFromFeeds, resolveScheduleGame,
// resolveGameForNickname/Teams): `game` is the usual resolved-or-not result,
// and `doubleheaderBothLegsFinal` is true ONLY for the one case that gets its
// own caller-facing message instead of the generic "couldn't match" one - a
// confirmed doubleheader (MLB flags it) whose every leg is already final, so
// there is no "earliest not-final leg" default left to resolve to.
export type ScheduleCandidateResult = { game: ScoreGame | null; doubleheaderBothLegsFinal: boolean };

function noMatch(): ScheduleCandidateResult {
  return { game: null, doubleheaderBothLegsFinal: false };
}
function resolved(game: ScoreGame | null): ScheduleCandidateResult {
  return { game, doubleheaderBothLegsFinal: false };
}

export function pickBestScheduleCandidate(
  candidates: ScoreGame[],
  referenceTime: Date,
  gameNumber: 1 | 2 | null = null
): ScheduleCandidateResult {
  if (candidates.length === 0) return noMatch();
  if (candidates.length === 1) {
    return resolved(isConfirmedMissingPartnerLeg(candidates[0], gameNumber) ? null : candidates[0]);
  }

  const sameDay = candidates.filter((g) => sameSlateDay(new Date(g.commenceTime), referenceTime));
  const pool = sameDay.length > 0 ? sameDay : candidates;

  if (pool.length === 1) {
    // The wider `candidates` array had 2+ entries, but only one survived the
    // same-slate-day filter - same "confirmed missing partner leg" check as
    // the single-candidate case above, since gameNumber/doubleheader status
    // are never otherwise consulted for a pool this small.
    return resolved(isConfirmedMissingPartnerLeg(pool[0], gameNumber) ? null : pool[0]);
  }

  if (gameNumber !== null) {
    const byMlbGameNumber = pool.find((g) => g.gameNumber === gameNumber);
    if (byMlbGameNumber) return resolved(byMlbGameNumber);

    // No authoritative MLB gameNumber on any candidate - fall back to
    // start-time order. A missing index (Game 2 asked for but not present
    // in the pool - postponed, not yet loaded) is null, never game 1.
    const sorted = [...pool].sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());
    return resolved(sorted[gameNumber - 1] ?? null);
  }

  const doubleheaderFlagged = pool.some((g) => g.doubleHeaderStatus === "Y" || g.doubleHeaderStatus === "S");
  if (doubleheaderFlagged) {
    // No explicit gameNumber text - default to the earliest leg that ISN'T
    // final yet, rather than refusing to guess outright:
    //   - one leg final, the other not -> the not-final leg (the game that
    //     hasn't been played is virtually always the one still being bet)
    //   - neither final -> the earliest leg (ordinarily Game 1)
    //   - every leg already final -> nothing left to default to; flagged,
    //     with doubleheaderBothLegsFinal telling the caller to show its own
    //     "add manually" message instead of the generic unmatched one.
    const notFinalLegs = pool.filter((g) => g.status !== "final");
    if (notFinalLegs.length === 0) return { game: null, doubleheaderBothLegsFinal: true };

    const earliest = [...notFinalLegs].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    )[0];
    return resolved(earliest);
  }

  const hasFinal = pool.some((g) => g.status === "final");
  const hasNonFinal = pool.some((g) => g.status !== "final");
  if (hasFinal && hasNonFinal) return noMatch();

  const notFinal = pool.filter((g) => g.status !== "final");
  const finalPool = notFinal.length > 0 ? notFinal : pool;

  return resolved(closestByTime(finalPool, (g) => new Date(g.commenceTime).getTime(), referenceTime.getTime()));
}

// Pure core of catalog-import game resolution, over two feeds:
//   - score feed (~yesterday..tomorrow): authoritative for anything happening
//     now - live status, the ID the grading pipeline keys on, repeated-matchup
//     handling. A same-slate-day match here wins outright, INCLUDING one
//     that's already final - see sameSlateDay above. This is what keeps a
//     late import for an already-finished game attached to THAT game instead
//     of the next game in a series/back-to-back that also happens to be
//     sitting in the score feed's yesterday..tomorrow window (confirmed via
//     the acceptance test below - was previously excluded outright by a
//     finals-only prefilter, see git history of this comment for the bug).
//   - odds feed (full posted schedule): fills in only when the score feed has
//     no SAME-SLATE-DAY match at all AND no other UPCOMING match either -
//     either nothing at all (the normal advance-post case: a pick dropped
//     days before kickoff), or only a game that finished on some earlier day
//     with nothing upcoming near it (the capper means the team's NEXT game,
//     not the one that already ended). A finished score-feed game from an
//     earlier day is used only as the very last resort, so logging a pick
//     right after its game still works when nothing else is ahead.
// Deliberately a fallback, not a merge: a game happening now is in BOTH feeds
// with different IDs, and merging would double it in the candidate pool.
// Exported for the acceptance test; the async wrapper below supplies the feeds.
export function resolveScheduleGameFromFeeds(
  scoreGames: ScoreGame[],
  oddsGames: OddsGame[],
  teamMatches: (g: { homeTeam: string; awayTeam: string }) => boolean,
  referenceTime: Date,
  gameNumber: 1 | 2 | null = null
): ScheduleCandidateResult {
  const inWindow = (g: { commenceTime: string }) => withinResolveWindow(g.commenceTime, referenceTime);

  const fromScores = scoreGames.filter((g) => teamMatches(g) && inWindow(g));

  const sameDayScores = fromScores.filter((g) => sameSlateDay(new Date(g.commenceTime), referenceTime));
  if (sameDayScores.length > 0) return pickBestScheduleCandidate(sameDayScores, referenceTime, gameNumber);

  const scoresUpcoming = fromScores.filter((g) => g.status !== "final");
  if (scoresUpcoming.length > 0) return pickBestScheduleCandidate(scoresUpcoming, referenceTime, gameNumber);

  const fromOdds = oddsGames.filter((g) => teamMatches(g) && inWindow(g)).map(oddsGameToScheduleGame);
  if (fromOdds.length > 0) return pickBestScheduleCandidate(fromOdds, referenceTime, gameNumber);

  return pickBestScheduleCandidate(fromScores, referenceTime, gameNumber);
}

// `nearTermOnly` skips the odds-feed fallback: it answers "does this team have
// a game in the ~yesterday..tomorrow score feed" rather than "anywhere in the
// posted schedule". The catalog-import disambiguation schedule check
// (checkAmbiguousTeamSchedules) needs the tight question - a daily-sport team
// with a game 5 days out is not "playing now" and must not out-vote a weekly
// team by default. Import game-MATCHING wants the wide question and leaves
// this off.
export type ResolveGameOpts = {
  referenceTime?: Date;
  nearTermOnly?: boolean;
  // From the pick's own "Game 2"/"G2"/... text, or a user's choice on a
  // previously-flagged doubleheader pick - see pickBestScheduleCandidate's
  // own comment for how this is used (and when it's ignored).
  gameNumber?: 1 | 2 | null;
};

// Async wrapper around resolveScheduleGameFromFeeds. The score feed is fetched
// first; the odds feed (a memoized OddsSnapshot read - already warm for most
// import batches, since resolveGameAndOdds reads it again for pricing) is
// fetched only when needed - never for nearTermOnly, and otherwise only when
// the score feed has no UPCOMING match, keeping the common "game is
// today/tomorrow" path a single fetch. A feed that throws (network blip) is
// treated as empty so the other one can still answer.
// A feed fetch is allowed to fail soft (empty array, so the other feed can
// still answer) ONLY for what it's actually meant to tolerate - a network
// blip against the external score/odds API. It must never silently swallow
// an unexpected error (a code bug, a DB/schema mismatch surfaced through a
// downstream call) into the exact same "no games" result a genuine empty
// feed produces - that turns a real bug into a false "couldn't match" for
// every caller, with no trace of what actually happened. Logged loudly here
// (not just caught) so a real error is visible even though resolution still
// degrades gracefully to "try the other feed" for it.
async function fetchFeedOrEmpty<T>(label: string, fetch: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fetch();
  } catch (err) {
    console.error(
      `[resolveScheduleGame] ${label} fetch failed - treating as empty for this resolution attempt, but this is NOT expected to be silent`,
      JSON.stringify({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
    );
    return [];
  }
}

async function resolveScheduleGame(
  sportKey: string,
  teamMatches: (g: { homeTeam: string; awayTeam: string }) => boolean,
  { referenceTime = new Date(), nearTermOnly = false, gameNumber = null }: ResolveGameOpts
): Promise<ScheduleCandidateResult> {
  const scoreGames = await fetchFeedOrEmpty("score", () => getLiveScoresForSport(sportKey));

  if (nearTermOnly) return resolveScheduleGameFromFeeds(scoreGames, [], teamMatches, referenceTime, gameNumber);

  const scoreHasUpcoming = scoreGames.some(
    (g) => teamMatches(g) && g.status !== "final" && withinResolveWindow(g.commenceTime, referenceTime)
  );
  const oddsGames = scoreHasUpcoming ? [] : await fetchFeedOrEmpty("odds", () => getOddsForSport(sportKey));
  return resolveScheduleGameFromFeeds(scoreGames, oddsGames, teamMatches, referenceTime, gameNumber);
}

// Resolves a bare team nickname (e.g. "white sox", parsed from a capper's raw
// pick text) to the real game it refers to. The ~yesterday..tomorrow score
// feed is checked first; if nothing there matches, the full-schedule odds
// feed fills in (see resolveScheduleGame / resolveScheduleGameFromFeeds), so
// a pick posted days ahead of kickoff still resolves. Same-team matchups
// repeat within a season (series / weekly opponents), so when more than one
// game matches we prefer one on the same Eastern day as `referenceTime`,
// then one that hasn't finished, then whichever started closest to it. Every
// candidate is first constrained to MAX_RESOLVE_DATE_DRIFT_DAYS of
// `referenceTime` so a far-future game for the same team can't be attached to
// a pick whose game isn't in either feed.
export async function resolveGameForNickname(
  sportKey: string,
  nickname: string,
  opts: ResolveGameOpts = {}
): Promise<ScheduleCandidateResult> {
  return resolveScheduleGame(
    sportKey,
    (g) => g.homeTeam.toLowerCase().endsWith(nickname) || g.awayTeam.toLowerCase().endsWith(nickname),
    opts
  );
}

// Same idea as resolveGameForNickname, but for picks that name both teams
// (e.g. "Dodgers Cubs under 8.5") - requiring both nicknames to match pins the
// exact matchup directly instead of leaning on time-proximity guessing, and
// naturally disambiguates cases a single nickname alone couldn't.
export async function resolveGameForTeams(
  sportKey: string,
  nicknameA: string,
  nicknameB: string,
  opts: ResolveGameOpts = {}
): Promise<ScheduleCandidateResult> {
  return resolveScheduleGame(
    sportKey,
    (g) => {
      const home = g.homeTeam.toLowerCase();
      const away = g.awayTeam.toLowerCase();
      return (
        (home.endsWith(nicknameA) && away.endsWith(nicknameB)) ||
        (home.endsWith(nicknameB) && away.endsWith(nicknameA))
      );
    },
    opts
  );
}

// Matches a single odds-listed game to its live/final score by team pair,
// preferring whichever score candidate started closest to the odds game's
// commenceTime - same repeat-matchup problem resolveGameForNickname solves.
// teamNamesMatch, not ===: `scores` is score-source-spelled (ESPN) and `game`
// is odds-source-spelled (The Odds API), which disagree for a few teams (see
// team-name-match.ts).
export function matchScoreToGame(
  scores: ScoreGame[],
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): ScoreGame | undefined {
  const candidates = scores.filter(
    (s) => teamNamesMatch(s.homeTeam, game.homeTeam) && teamNamesMatch(s.awayTeam, game.awayTeam)
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (s) => new Date(s.commenceTime).getTime(), gameStart);
}

// Shared by findMarketPrice, findMarketTotalLine, and (via nfl-prop-odds.ts)
// resolvePropOdds - resolves which odds-listed game (by team pair + closest
// commenceTime) a schedule-sourced game corresponds to, same repeat-matchup
// handling as matchScoreToGame. teamNamesMatch, not ===: `game` here is
// schedule/score-source-spelled while oddsGames is odds-source-spelled (see
// team-name-match.ts). Exported (not module-private) so nfl-prop-odds.ts's
// resolvePropOdds can match a pick to the same cached OddsGame findMarketPrice
// would, rather than re-implementing this resolution step.
export async function resolveOddsGame(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): Promise<OddsGame | null> {
  const oddsGames = await getOddsForSport(sportKey);
  const candidates = oddsGames.filter(
    (g) => teamNamesMatch(g.homeTeam, game.homeTeam) && teamNamesMatch(g.awayTeam, game.awayTeam)
  );
  if (candidates.length === 0) return null;

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (g) => new Date(g.commenceTime).getTime(), gameStart);
}

// The favored side of a game's head-to-head (moneyline) market: "HOME"/"AWAY"
// by comparing the two outcome prices (lower American price = more favored), or
// null when the h2h market is absent, a side's price is missing, or the two are
// exactly equal (a true pick'em has no favorite). Pure - the same
// homePrice < awayPrice comparison recomputeTeamTendencies already uses, just
// off a single OddsGame. First bookmaker that lists both sides wins, matching
// findMarketPrice's first-bookmaker-wins style.
export function favoredSideFromOddsGame(oddsGame: OddsGame): "HOME" | "AWAY" | null {
  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "h2h");
    if (!market) continue;
    const home = market.outcomes.find((o) => o.name === oddsGame.homeTeam);
    const away = market.outcomes.find((o) => o.name === oddsGame.awayTeam);
    if (home && away && home.price !== away.price) {
      return home.price < away.price ? "HOME" : "AWAY";
    }
  }
  return null;
}

// Resolves which odds-listed game a schedule game corresponds to (same team-pair
// + closest-commenceTime match findMarketPrice uses) and returns its h2h favored
// side. Null when the game isn't in the odds cache (e.g. it has already started -
// getOddsForSport drops in-progress games) or has no usable h2h market. Called
// once per bulk-imported MONEYLINE pick to stamp Pick.mlFavoredSide, so
// favoriteOrUnderdog can classify FAV_ML vs DOG_ML correctly even in a juiced
// near-pick'em where the odds sign alone can't.
export async function findFavoredSide(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): Promise<"HOME" | "AWAY" | null> {
  const oddsGame = await resolveOddsGame(sportKey, game);
  return oddsGame ? favoredSideFromOddsGame(oddsGame) : null;
}

// Looks up the real market price for a resolved game (see
// resolveGameForNickname), so bulk-imported picks that didn't state an
// explicit price can use the actual line instead of a hardcoded -110.
export async function findMarketPrice(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP" | "NRFI",
  side: "home" | "away" | "over" | "under"
): Promise<number | null> {
  // No odds-API market exists for NRFI, so it falls through to null (default -110)
  // same as PLAYER_PROP - only h2h/spreads/totals have a real market to look up.
  const marketKey =
    betType === "MONEYLINE" ? "h2h" : betType === "SPREAD" ? "spreads" : betType === "TOTAL" ? "totals" : null;
  if (!marketKey) return null;

  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;

  const outcomeName =
    side === "home" ? oddsGame.homeTeam : side === "away" ? oddsGame.awayTeam : side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome) return outcome.price;
  }

  return null;
}

// Looks up the real market TOTAL LINE (the point number, e.g. 8.5 - not the
// price) for a resolved game, so a TOTAL pick whose raw bet text had no
// parseable number at all (missing or garbled, e.g. "Cubs under a") can have
// today's real line proposed for the user's confirmation instead of staying
// permanently ungradeable. Never used to override a number the capper
// actually specified - see previewMissingTotalLines, the only caller.
// Looks up the real market SPREAD LINE (the point number, e.g. -4.5 - not
// the price) for a resolved game. Unlike findMarketTotalLine, this is not
// gated on the capper's own text being missing/garbled - it exists for MLP
// (moneyline-parlay) legs, where the number written next to a leg is a
// label/shorthand pointing at a real pick, not the real line, so the actual
// current line must always be looked up live rather than trusted from text
// (see bulk-picks.ts's resolveLegAndOdds, the only caller).
export async function findMarketSpreadLine(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  side: "home" | "away"
): Promise<number | null> {
  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;

  const outcomeName = side === "home" ? oddsGame.homeTeam : oddsGame.awayTeam;

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "spreads");
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome?.point !== undefined) return outcome.point;
  }

  return null;
}

export async function findMarketTotalLine(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  side: "over" | "under"
): Promise<number | null> {
  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;

  const outcomeName = side === "over" ? "Over" : "Under";

  for (const bookmaker of oddsGame.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === "totals");
    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
    if (outcome?.point !== undefined) return outcome.point;
  }

  return null;
}


