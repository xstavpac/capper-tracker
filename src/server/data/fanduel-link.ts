// The server half of "Send to FanDuel" (lib/parlay/fanduel-link.ts holds the
// matching and the link itself). Reads the legs' picks scoped to the signed-in
// user - the request names them by id only - and asks the Odds API for
// FanDuel's ids: the free event listing per league, then one metered call per
// event for just the markets its legs need.
//
// Only ever runs from a tap on the button (POST /api/parlay/fanduel-link).
// Nothing here is called on page load or from a cron.
import { LIVE_SPORTS, ODDS_API_BASE_URL, readOddsApiCredits } from "@/server/data/odds";
import { persistOddsApiUsage } from "@/server/data/odds-api-usage";
import { getOwnedSlipPickRows, loadSlipBoards, offBoardSlipPick, picksOnBoards } from "@/server/data/parlay-slip-picks";
import {
  buildFanDuelLink,
  type FanDuelDeps,
  type FanDuelEvent,
  type FanDuelLegInput,
  type FanDuelLegResult,
  type FanDuelLinkResponse,
  type FanDuelMarket,
} from "@/lib/parlay/fanduel-link";

const LOG_TAG = "[fanduel-link]";

// A repeat tap inside this window reuses the last answer instead of spending
// credits again. Per serverless instance - a tap that lands on another
// instance fetches once more, which is the worst case, not a wrong answer.
const CACHE_TTL_MS = 60 * 1000;

type Cached<T> = { expires: number; value: Promise<T | null> };

const eventListings = new Map<string, Cached<FanDuelEvent[]>>();
// Per event: each fetch with the market keys it asked for. A later request is
// served by any live entry that already covers its keys.
const eventMarkets = new Map<string, (Cached<FanDuelMarket[]> & { marketKeys: string[] })[]>();

function dropExpired(now: number) {
  eventListings.forEach((entry, key) => {
    if (entry.expires <= now) eventListings.delete(key);
  });
  eventMarkets.forEach((entries, key) => {
    const live = entries.filter((e) => e.expires > now);
    if (live.length === 0) eventMarkets.delete(key);
    else eventMarkets.set(key, live);
  });
}

// The url carries the API key, so it is never logged - only what was asked for.
async function oddsApiGet(url: string, ctx: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch(url, { cache: "no-store" });
  } catch (err) {
    console.error(LOG_TAG + " upstream fetch threw", JSON.stringify({ ...ctx, error: err instanceof Error ? err.name : "unknown" }));
    return null;
  }
}

async function fetchEvents(sportKey: string, apiKey: string): Promise<FanDuelEvent[] | null> {
  const res = await oddsApiGet(ODDS_API_BASE_URL + "/sports/" + sportKey + "/events?apiKey=" + apiKey, { sportKey, call: "events" });
  if (!res) return null;
  if (!res.ok) {
    console.error(LOG_TAG + " events listing failed", JSON.stringify({ sportKey, status: res.status }));
    return null;
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) return null;
  return raw.map((e) => ({ id: String(e.id), homeTeam: String(e.home_team), awayTeam: String(e.away_team), commenceTime: String(e.commence_time) }));
}

async function fetchEventMarkets(sportKey: string, eventId: string, marketKeys: string[], apiKey: string): Promise<FanDuelMarket[] | null> {
  const params = new URLSearchParams({
    apiKey,
    regions: "us",
    bookmakers: "fanduel",
    markets: marketKeys.join(","),
    oddsFormat: "american",
    includeSids: "true",
    // The market's own sid comes back null; the outcome's betslip link is
    // where FanDuel's marketId is (see FanDuelOutcome in lib/parlay/fanduel-link.ts).
    includeLinks: "true",
  });
  const ctx = { sportKey, eventId, marketKeys };
  const res = await oddsApiGet(
    ODDS_API_BASE_URL + "/sports/" + sportKey + "/events/" + encodeURIComponent(eventId) + "/odds?" + params.toString(),
    ctx
  );
  if (!res) return null;

  // Logs x-requests-remaining / -used / -last for this call.
  const credits = readOddsApiCredits(res, { sportKey, requestSportKey: sportKey });
  try {
    await persistOddsApiUsage({ sportKey, marketsRequested: marketKeys, eventsRequested: 1, credits });
  } catch (err) {
    console.error(LOG_TAG + " failed to persist usage log", JSON.stringify({ ...ctx, error: err instanceof Error ? err.message : String(err) }));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error(LOG_TAG + " event odds failed", JSON.stringify({ ...ctx, status: res.status, body: body.slice(0, 300) }));
    return null;
  }
  const raw = await res.json();
  const bookmakers: { key?: string; markets?: FanDuelMarket[] }[] = Array.isArray(raw?.bookmakers) ? raw.bookmakers : [];
  return bookmakers.find((b) => b.key === "fanduel")?.markets ?? [];
}

// A failed fetch is not kept: the next tap tries again.
function remember<T>(value: Promise<T | null>, forget: () => void): Promise<T | null> {
  value.then(
    (v) => {
      if (v === null) forget();
    },
    () => forget()
  );
  return value;
}

function oddsApiDeps(now: Date): FanDuelDeps {
  const apiKey = process.env.ODDS_API_KEY;
  const at = now.getTime();
  dropExpired(at);
  return {
    now,
    async getEvents(sportKey) {
      if (!apiKey) {
        console.error(LOG_TAG + " no ODDS_API_KEY configured");
        return null;
      }
      const hit = eventListings.get(sportKey);
      if (hit) return hit.value;
      const value = remember(fetchEvents(sportKey, apiKey), () => eventListings.delete(sportKey));
      eventListings.set(sportKey, { expires: at + CACHE_TTL_MS, value });
      return value;
    },
    async getEventMarkets(sportKey, eventId, marketKeys) {
      if (!apiKey) return null;
      const key = sportKey + "|" + eventId;
      const hit = (eventMarkets.get(key) ?? []).find((e) => marketKeys.every((k) => e.marketKeys.includes(k)));
      if (hit) return hit.value;
      const entry = {
        expires: at + CACHE_TTL_MS,
        marketKeys,
        value: remember(fetchEventMarkets(sportKey, eventId, marketKeys, apiKey), () =>
          eventMarkets.set(key, (eventMarkets.get(key) ?? []).filter((e) => e !== entry))
        ),
      };
      eventMarkets.set(key, [...(eventMarkets.get(key) ?? []), entry]);
      return entry.value;
    },
  };
}

// The legs as the server knows them: each pick's own row, under the game the
// Live board shows it on (so its kickoff is the game's, not the row's stored
// time - see parlay-slip-picks.ts). An id that isn't this user's pick has no
// leg here.
async function loadLegs(userId: string, pickIds: string[]): Promise<Map<string, FanDuelLegInput>> {
  const rows = await getOwnedSlipPickRows(userId, pickIds);
  const boards = await loadSlipBoards(userId, rows);
  const onBoard = picksOnBoards(boards, pickIds);
  const legs = new Map<string, FanDuelLegInput>();
  for (const row of rows) {
    const boardPick = onBoard.get(row.id);
    const pick = boardPick ?? offBoardSlipPick(row);
    legs.set(row.id, {
      pickId: row.id,
      sportKey: LIVE_SPORTS.find((s) => s.label === pick.leagueName)?.key ?? null,
      leagueName: pick.leagueName,
      betType: pick.betType,
      period: pick.period,
      betDetail: pick.rawBetDetail,
      line: pick.line,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      gameTime: pick.gameTime,
      odds: pick.odds,
      onBoard: boardPick !== undefined,
    });
  }
  return legs;
}

export async function getFanDuelLink(userId: string, pickIds: string[], now: Date = new Date()): Promise<FanDuelLinkResponse> {
  const legs = await loadLegs(userId, pickIds);
  const built = await buildFanDuelLink(
    pickIds.flatMap((id) => legs.get(id) ?? []),
    oddsApiDeps(now)
  );
  const byId = new Map(built.legs.map((l) => [l.pickId, l]));
  const missing = (pickId: string): FanDuelLegResult => ({
    pickId,
    status: "not_found",
    reason: "This pick is no longer available.",
    pickOdds: null,
    fanDuelOdds: null,
    pickLine: null,
    fanDuelLine: null,
  });
  return { url: built.url, legs: pickIds.map((id) => byId.get(id) ?? missing(id)) };
}
