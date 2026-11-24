// Live (in-play) FanDuel prices for the Parlay Generator's started games: one Odds API listing call per
// league - /sports/{key}/odds with markets=h2h,spreads,totals and bookmakers=fanduel (3 credits) - kept for
// 60 s in the shared Data Cache (cachedByTag), so every user's build in that minute reuses one response.
// lib/parlay/live-price.ts turns it into each pick's live price.
//
// Asked only when the build needs it (leaguesNeedingLivePrices): "Include live games" on and at least one
// started game in the pool. A failed or timed-out call is never cached and never blocks the build: that
// league's picks keep their posted prices and the snapshot records FAILED (the run trace shows it).
//
// No Supabase read on the price path. Each real call writes one usage-log row (persistOddsApiUsage, caller
// "live-prices"), deferred past the response.
import { cachedByTag } from "@/server/data/cached";
import { ODDS_API_BASE_URL, readOddsApiCredits, type OddsApiCredits } from "@/server/data/odds";
import { persistOddsApiUsage } from "@/server/data/odds-api-usage";
import { deferToPlatform } from "@/server/defer-work";
import { leaguesNeedingLivePrices, withLivePrices, type LiveListingGame, type LivePriceStatus, type LivePricing } from "@/lib/parlay/live-price";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";

export const LIVE_LISTING_TTL_SECONDS = 60;
export const LIVE_LISTING_TIMEOUT_MS = 4000;
export const LIVE_LISTING_MARKETS = ["h2h", "spreads", "totals"] as const;
const LOG_TAG = "[live-prices]";

export type LivePriceDeps = {
  // One listing call for one sport key: the in-play events, trimmed. Throws on any failure.
  fetchListing: (sportKey: string, now: Date) => Promise<LiveListingGame[]>;
  // The shared cache: the value for `key` if one is younger than `ttlSeconds`, else fn()'s (a rejection is not kept).
  cached: <T>(key: string, ttlSeconds: number, fn: () => Promise<T>) => Promise<T>;
};

export const liveListingCacheKey = (sportKey: string) => "live-fanduel-listing:" + sportKey;

// Per league: its listing, or FAILED. `leagues` maps the league label to the Odds API sport key.
export async function loadLiveListings(
  leagues: { league: string; sportKey: string }[],
  now: Date,
  deps: LivePriceDeps = productionLivePriceDeps
): Promise<{ listings: Map<string, LiveListingGame[]>; status: Record<string, LivePriceStatus> }> {
  const listings = new Map<string, LiveListingGame[]>();
  const status: Record<string, LivePriceStatus> = {};
  await Promise.all(
    leagues.map(async ({ league, sportKey }) => {
      try {
        listings.set(league, await deps.cached(liveListingCacheKey(sportKey), LIVE_LISTING_TTL_SECONDS, () => deps.fetchListing(sportKey, now)));
        status[league] = "FETCHED";
      } catch (err) {
        status[league] = "FAILED";
        console.warn(LOG_TAG + " listing failed - posted prices used", JSON.stringify({ league, sportKey, error: err instanceof Error ? err.message : String(err) }));
      }
    })
  );
  return { listings, status };
}

type RawOutcome = { name?: unknown; price?: unknown; point?: unknown };
type RawEvent = { id?: unknown; home_team?: unknown; away_team?: unknown; commence_time?: unknown; bookmakers?: { key?: unknown; markets?: { key?: unknown; outcomes?: RawOutcome[] }[] }[] };

// The listing's in-play events (commence time passed), FanDuel's three markets only - a few KB to cache.
export function trimLiveListing(raw: unknown, now: Date): LiveListingGame[] {
  if (!Array.isArray(raw)) throw new Error("listing is not an array");
  const out: LiveListingGame[] = [];
  for (const e of raw as RawEvent[]) {
    if (typeof e.id !== "string" || typeof e.home_team !== "string" || typeof e.away_team !== "string") continue;
    const start = typeof e.commence_time === "string" ? Date.parse(e.commence_time) : NaN;
    if (!Number.isFinite(start) || start > now.getTime()) continue;
    const fd = (e.bookmakers ?? []).find((b) => b.key === "fanduel");
    if (!fd) continue;
    const markets = (fd.markets ?? [])
      .filter((m) => typeof m.key === "string" && (LIVE_LISTING_MARKETS as readonly string[]).includes(m.key))
      .map((m) => ({
        key: m.key as string,
        outcomes: (m.outcomes ?? [])
          .filter((o) => typeof o.name === "string" && typeof o.price === "number")
          .map((o) => ({ name: o.name as string, price: o.price as number, ...(typeof o.point === "number" ? { point: o.point } : {}) })),
      }));
    out.push({ id: e.id, homeTeam: e.home_team, awayTeam: e.away_team, markets });
  }
  return out;
}

async function fetchLiveListing(sportKey: string, now: Date): Promise<LiveListingGame[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("no ODDS_API_KEY");
  const url =
    ODDS_API_BASE_URL + "/sports/" + sportKey + "/odds/?apiKey=" + apiKey + "&bookmakers=fanduel&markets=" + LIVE_LISTING_MARKETS.join(",") + "&oddsFormat=american";
  // The url carries the key: never logged.
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(LIVE_LISTING_TIMEOUT_MS) });
  const credits: OddsApiCredits = readOddsApiCredits(res, { sportKey, requestSportKey: sportKey });
  deferToPlatform(
    persistOddsApiUsage({ sportKey, marketsRequested: [...LIVE_LISTING_MARKETS], eventsRequested: 0, credits, httpStatus: res.status, caller: "live-prices" }).catch((err) =>
      console.error(LOG_TAG + " usage log failed", JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) }))
    )
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  return trimLiveListing(await res.json(), now);
}

export const productionLivePriceDeps: LivePriceDeps = {
  fetchListing: fetchLiveListing,
  cached: (key, ttl, fn) => cachedByTag(key, ttl, fn),
};

// The snapshot loader's one step: which leagues need live prices (none with "Include live games" off or no
// started game), their listings, and the games and slip picks with live prices set. `sportKeyOf` maps a
// league label to its Odds API sport key (the board it was read from).
export async function priceStartedGames(
  input: { games: GeneratorGame[]; slipPicks: GeneratorPick[]; includeLive: boolean; sportKeyOf: (league: string) => string | undefined },
  now: Date,
  deps: LivePriceDeps = productionLivePriceDeps
): Promise<{ games: GeneratorGame[]; slipPicks: GeneratorPick[]; livePricing: LivePricing; priced: number }> {
  const leagues = leaguesNeedingLivePrices(input.games, input.includeLive, now).flatMap((league) => {
    const sportKey = input.sportKeyOf(league);
    return sportKey ? [{ league, sportKey }] : [];
  });
  if (leagues.length === 0) return { games: input.games, slipPicks: input.slipPicks, livePricing: { asked: input.includeLive, leagues: {} }, priced: 0 };
  const { listings, status } = await loadLiveListings(leagues, now, deps);
  const priced = withLivePrices(input.games, input.slipPicks, listings, now);
  return { games: priced.games, slipPicks: priced.slipPicks, livePricing: { asked: true, leagues: status }, priced: priced.priced };
}
