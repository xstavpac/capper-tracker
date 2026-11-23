// The server half of "Send to FanDuel" (lib/parlay/fanduel-link.ts holds the
// matching and the link itself). Reads the legs' picks scoped to the signed-in
// user - the request names them by id only - and asks the Odds API for
// FanDuel's ids: the free event listing per league (and per preseason key the
// league has open - lib/sport-seasons.ts), then one metered call per
// event for just the main markets its legs need, and a second for the
// alternate-lines markets of only the legs that missed there.
//
// Only ever runs from a tap on the button (POST /api/parlay/fanduel-link).
// Nothing here is called on page load or from a cron.
import { LIVE_SPORTS, ODDS_API_BASE_URL, readOddsApiCredits } from "@/server/data/odds";
import { persistOddsApiUsage } from "@/server/data/odds-api-usage";
import { deferToPlatform } from "@/server/defer-work";
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

type Cached<T> = { expires: number; value: Promise<T | null>; state: { timedOut: boolean } };

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
//
// Two guards against the Odds API's burst rate limit (prod: every 429 on this path came in a second with 5+ calls
// from one send; credits were never the cause):
//   - at most maxConcurrent calls in flight per serverless instance, the rest wait their turn;
//   - one retry, after a short pause, of a call that threw, got a 429, or got a 5xx. A second failure is returned
//     as it is (the leg then reads "Unavailable"). Each attempt is passed to onResponse, so every response, the
//     429s included, is still written to the usage log. The slot is released while waiting to retry.
// Tunable (and zeroed in the test) through fanDuelFetchTuning.
//
// Two time bounds, so a send always ends (a stalled upstream used to hold the whole send, and its cached promise,
// until the platform killed the function): callTimeoutMs per call - the abort covers the body read too - and
// deadlineMs for the whole send, measured from when getFanDuelLink started. A call that times out, or that is
// reached after the deadline, is not retried and comes back as TIMEOUT.
//
// "Reached after the deadline" is read from the send's own SendDeadline, not from the clock alone. The timers run on
// the event loop's monotonic clock and the deadline is a Date.now() value, so a timer due at the deadline can fire
// while Date.now() still reads 1 ms short of it (seen on Linux CI). The slot that timer frees would then go to a
// queued call with "1 ms left", and fire a real request. So a timer whose length the deadline set marks the send's
// deadline passed when it fires - before its call returns and hands the slot on - and a call that gets a slot after
// that gives up without fetching. One SendDeadline per send (oddsApiDeps): another send's never touches it.
// now() is the clock the deadline is read against - Date.now in production, swapped by the test to recreate a clock
// that still reads just short of the deadline when the timers due at it fire.
export const fanDuelFetchTuning = { maxConcurrent: 4, retryDelayMs: 500, callTimeoutMs: 8000, deadlineMs: 25000, now: (): number => Date.now() };
const TIMEOUT = "timeout" as const;
type Timeout = typeof TIMEOUT;
type SendDeadline = { at: number; passed: boolean };
let inFlight = 0;
const waiting: (() => void)[] = [];
async function acquireSlot() {
  if (inFlight < fanDuelFetchTuning.maxConcurrent) {
    inFlight++;
    return;
  }
  // The releasing call hands its slot straight to the next waiter, so inFlight stays put.
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}
const retryableStatus = (status: number) => status === 429 || status >= 500;

async function fetchOnce(url: string, ctx: Record<string, unknown>, deadline: SendDeadline): Promise<Response | Timeout | null> {
  await acquireSlot();
  try {
    // The wait for a slot counts against the deadline, so what is left is what this call may use.
    const left = deadline.at - fanDuelFetchTuning.now();
    if (deadline.passed || left <= 0) {
      console.error(LOG_TAG + " deadline passed before the call", JSON.stringify(ctx));
      return TIMEOUT;
    }
    const cutByDeadline = left <= fanDuelFetchTuning.callTimeoutMs;
    const ms = Math.min(fanDuelFetchTuning.callTimeoutMs, left);
    // The timer is left to run out rather than cleared on headers: the abort then also bounds the body read.
    // The race makes the bound hold even for a fetch that ignores its signal.
    const ac = new AbortController();
    const timeout = new Promise<Timeout>((resolve) => {
      setTimeout(() => {
        // Set before the race below settles, so before this call's finally hands its slot to a queued call.
        if (cutByDeadline) deadline.passed = true;
        ac.abort();
        resolve(TIMEOUT);
      }, ms);
    });
    const res = await Promise.race([fetch(url, { cache: "no-store", signal: ac.signal }), timeout]);
    if (res === TIMEOUT) console.error(LOG_TAG + " upstream call timed out", JSON.stringify({ ...ctx, ms }));
    return res;
  } catch (err) {
    console.error(LOG_TAG + " upstream fetch threw", JSON.stringify({ ...ctx, error: err instanceof Error ? err.name : "unknown" }));
    return null;
  } finally {
    releaseSlot();
  }
}

// A body read that was cut off by the abort is a timeout; any other failure is the caller's null.
async function readBody<T>(read: () => Promise<T>, ctx: Record<string, unknown>): Promise<T | Timeout | null> {
  try {
    return await read();
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    console.error(LOG_TAG + " reading the upstream body failed", JSON.stringify({ ...ctx, error: err instanceof Error ? err.name : "unknown" }));
    return aborted ? TIMEOUT : null;
  }
}

// Usage-log writes leave the critical path: they run one at a time (a 25-leg send used to fire ~100 queries at
// once) and are handed to waitUntil, so the platform keeps the function alive for them after the response.
let usageWrites: Promise<void> = Promise.resolve();
function deferUsageWrite(write: () => Promise<void>) {
  usageWrites = usageWrites.then(write, write);
  deferToPlatform(usageWrites);
}

async function oddsApiGet(
  url: string,
  ctx: Record<string, unknown>,
  deadline: SendDeadline,
  onResponse?: (res: Response) => Promise<void> | void
): Promise<Response | Timeout | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchOnce(url, ctx, deadline);
    // Never retried: waiting for the same stalled upstream a second time is what the bound exists to avoid.
    if (res === TIMEOUT) return TIMEOUT;
    if (res) await onResponse?.(res);
    if ((res !== null && !retryableStatus(res.status)) || attempt >= 1) return res;
    console.warn(LOG_TAG + " retrying once", JSON.stringify({ ...ctx, status: res?.status ?? null }));
    await res?.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, fanDuelFetchTuning.retryDelayMs === 0 ? 0 : fanDuelFetchTuning.retryDelayMs + Math.random() * 250));
  }
}

async function fetchEvents(sportKey: string, apiKey: string, deadline: SendDeadline): Promise<FanDuelEvent[] | Timeout | null> {
  const ctx = { sportKey, call: "events" };
  const res = await oddsApiGet(ODDS_API_BASE_URL + "/sports/" + sportKey + "/events?apiKey=" + apiKey, ctx, deadline);
  if (!res || res === TIMEOUT) return res;
  if (!res.ok) {
    console.error(LOG_TAG + " events listing failed", JSON.stringify({ sportKey, status: res.status }));
    return null;
  }
  const raw = await readBody<unknown>(() => res.json(), ctx);
  if (raw === TIMEOUT) return TIMEOUT;
  if (!Array.isArray(raw)) return null;
  // sportKey is the key asked under, which is the one the event's odds call needs.
  return raw.map((e) => ({ id: String(e.id), sportKey, homeTeam:String(e.home_team), awayTeam: String(e.away_team), commenceTime: String(e.commence_time) }));
}

async function fetchEventMarkets(sportKey: string, eventId: string, marketKeys: string[], apiKey: string, deadline: SendDeadline): Promise<FanDuelMarket[] | Timeout | null> {
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
    ctx,
    deadline,
    // Every attempt, including a 429 that is about to be retried: logs x-requests-remaining / -used / -last.
    // The headers are read now; the write itself is deferred (deferUsageWrite), so no record is lost and none waits.
    (attempt) => {
      const credits = readOddsApiCredits(attempt, { sportKey, requestSportKey: sportKey });
      const httpStatus = attempt.status;
      deferUsageWrite(async () => {
        try {
          await persistOddsApiUsage({ sportKey, marketsRequested: marketKeys, eventsRequested: 1, credits, httpStatus, caller: "fanduel-link" });
        } catch (err) {
          console.error(LOG_TAG + " failed to persist usage log", JSON.stringify({ ...ctx, error: err instanceof Error ? err.message : String(err) }));
        }
      });
    }
  );
  if (!res || res === TIMEOUT) return res;

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error(LOG_TAG + " event odds failed", JSON.stringify({ ...ctx, status: res.status, body: body.slice(0, 300) }));
    return null;
  }
  const raw = await readBody<any>(() => res.json(), ctx);
  if (raw === TIMEOUT) return TIMEOUT;
  const bookmakers: { key?: string; markets?: FanDuelMarket[] }[] = Array.isArray(raw?.bookmakers) ? raw.bookmakers : [];
  const markets = bookmakers.find((b) => b.key === "fanduel")?.markets ?? [];
  logThinResponse(ctx, bookmakers, markets);
  return markets;
}

// What a 200 that carries less than was asked for looks like, so a "Not found" / "Line unavailable" that
// resolves on a re-check can be told apart from a rate limit (a 429, logged above). Keys and counts only.
function logThinResponse(ctx: { sportKey: string; eventId: string; marketKeys: string[] }, bookmakers: { key?: string }[], markets: FanDuelMarket[]) {
  const returned = markets.map((m) => m.key);
  const missing = ctx.marketKeys.filter((k) => !returned.includes(k));
  if (markets.length > 0 && missing.length === 0) return;
  console.warn(
    LOG_TAG + " thin 200",
    JSON.stringify({ ...ctx, bookmakerKeys: bookmakers.map((b) => b.key ?? null), returnedMarketKeys: returned, missingMarketKeys: missing, noFanDuelMarkets: markets.length === 0 })
  );
}

// A failed fetch is not kept, and neither is an empty one (no events listed, or a 200 with no FanDuel markets):
// an answer that thin is as likely a feed that hasn't caught up as a true "not offered", and keeping it for
// CACHE_TTL_MS made a re-check inside the window read the same thin answer. The next tap tries again.
// A timed-out call resolves to null, so it is dropped here like any failed one - a re-tap fetches afresh instead of
// sharing a stuck promise. `state.timedOut` is read by whoever got that null, to say "took too long" for its legs.
type CallState = { timedOut: boolean };
function remember<T>(raw: Promise<T | Timeout | null>, state: CallState, forget: () => void): Promise<T | null> {
  const value = raw.then((v) => {
    if (v === TIMEOUT) {
      state.timedOut = true;
      return null;
    }
    return v;
  });
  value.then(
    (v) => {
      if (v === null || (Array.isArray(v) && v.length === 0)) forget();
    },
    () => forget()
  );
  return value;
}

// startedAt is when the send began: the whole send's deadline (fanDuelFetchTuning.deadlineMs) runs from it.
export function oddsApiDeps(now: Date, startedAt: number = Date.now()): FanDuelDeps {
  const apiKey = process.env.ODDS_API_KEY;
  const at = now.getTime();
  // This send's alone: every call it starts carries it, and only those calls' timers can mark it passed.
  const deadline: SendDeadline = { at: startedAt + fanDuelFetchTuning.deadlineMs, passed: false };
  dropExpired(at);
  // What this send's callers got a timeout for: "<sportKey>|events" and "<sportKey>|<eventId>".
  const timedOut = new Set<string>();
  return {
    now,
    timedOut: (sportKey, eventId) => timedOut.has(sportKey + "|" + (eventId ?? "events")),
    async getEvents(sportKey) {
      if (!apiKey) {
        console.error(LOG_TAG + " no ODDS_API_KEY configured");
        return null;
      }
      let entry = eventListings.get(sportKey);
      if (!entry) {
        const state: CallState = { timedOut: false };
        const created: Cached<FanDuelEvent[]> = {
          expires: at + CACHE_TTL_MS,
          state,
          value: remember(fetchEvents(sportKey, apiKey, deadline), state, () => {
            if (eventListings.get(sportKey) === created) eventListings.delete(sportKey);
          }),
        };
        eventListings.set(sportKey, created);
        entry = created;
      }
      const result = await entry.value;
      if (result === null && entry.state.timedOut) timedOut.add(sportKey + "|events");
      return result;
    },
    async getEventMarkets(sportKey, eventId, marketKeys) {
      if (!apiKey) return null;
      const key = sportKey + "|" + eventId;
      let entry = (eventMarkets.get(key) ?? []).find((e) => marketKeys.every((k) => e.marketKeys.includes(k)));
      if (!entry) {
        const state: CallState = { timedOut: false };
        const created: Cached<FanDuelMarket[]> & { marketKeys: string[] } = {
          expires: at + CACHE_TTL_MS,
          marketKeys,
          state,
          value: remember(fetchEventMarkets(sportKey, eventId, marketKeys, apiKey, deadline), state, () =>
            eventMarkets.set(key, (eventMarkets.get(key) ?? []).filter((e) => e !== created))
          ),
        };
        eventMarkets.set(key, [...(eventMarkets.get(key) ?? []), created]);
        entry = created;
      }
      const result = await entry.value;
      if (result === null && entry.state.timedOut) timedOut.add(key);
      return result;
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
      pickedSide: row.pickedSide,
      // pickedSide was recorded against the ROW's home/away (ESPN's, at import); the board's game below can list
      // them the other way round at a neutral site. The leg reads the side as this row's team, never as a position.
      sideTeams: { homeTeam: row.homeTeam, awayTeam: row.awayTeam },
      line: pick.line,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      gameTime: pick.gameTime,
      playerName: row.playerName,
      propMarket: row.propMarket,
      gameStatus: pick.gameStatus ?? null,
      odds: pick.odds,
      oddsSource: row.oddsSource,
      onBoard: boardPick !== undefined,
    });
  }
  return legs;
}

export async function getFanDuelLink(userId: string, pickIds: string[], now: Date = new Date()): Promise<FanDuelLinkResponse> {
  const startedAt = Date.now();
  const legs = await loadLegs(userId, pickIds);
  const built = await buildFanDuelLink(
    pickIds.flatMap((id) => legs.get(id) ?? []),
    oddsApiDeps(now, startedAt)
  );
  const byId = new Map(built.legs.map((l) => [l.pickId, l]));
  const missing = (pickId: string): FanDuelLegResult => ({
    pickId,
    status: "not_found",
    reason: "This pick is no longer available.",
    pickOdds: null,
    fanDuelOdds: null,
    sentLine: null,
    warning: null,
  });
  return { url: built.url, legs: pickIds.map((id) => byId.get(id) ?? missing(id)) };
}
