// Alternate-line prices, bought on demand at import.
//
// The day's snapshot only carries each book's MAIN spread and total, and a pick
// is priced at its exact line or not at all (findMarketPrice, odds.ts). So
// "Over 35.5" on a game whose total is 47.5 has no feed price. The Odds API
// sells the other lines as alternate_totals / alternate_spreads, but only per
// event (/events/{eventId}/odds), at 1 credit per market returned per region.
//
// findAltLinePrice is called by the import for a full-game SPREAD or TOTAL pick
// the snapshot could not price. It asks for the ONE market the pick needs, for
// that one event, at most once per Eastern day:
//   - odds_alt_line_fetches holds one row per (event, market, day). The row is
//     created before the request goes out, so its unique key is what stops a
//     second request, on this instance or another. The response is stored on
//     it, and every later pick on that game is priced from the row.
//   - a request that fails outright (network error, non-2xx) bought nothing,
//     so its row is removed and a later import may try again. A response with
//     no bookmakers is free and is remembered like any other.
//   - the price rule is findMarketPrice's: exact point and side, every
//     bookmaker checked. No match is null - the caller keeps the capper's
//     price or the DEFAULTED placeholder.
//   - skipped entirely at >=95% credit usage (the same gate as the prop
//     markets), for a game that has started (the feed would return in-play
//     prices), and when there is no API key.
//   - the import waits ALT_LINE_ODDS_TIMEOUT_MS at most. A slower request is
//     not cancelled (it may already be paid for): it finishes in the
//     background and its result prices the next pick on that game.
//
// Shape confirmed live 2026-10-12 against a real event (Buffalo Bills @ Los
// Angeles Rams, commence_time 2026-10-13T00:15:00Z) via
// GET /v4/sports/americanfootball_nfl/events/{eventId}/odds
//   ?regions=us&markets=alternate_totals,alternate_spreads&oddsFormat=american
// (x-requests-last: 2, i.e. 1 credit per market). Outcomes are
// `{ name, price, point }` - "Over"/"Under" for alternate_totals, the full team
// name (as in the spreads market) for alternate_spreads, with a signed point.
// Five books returned 41-90 distinct points per market; one (betrivers) had
// alternate_spreads and no alternate_totals. Trimmed capture saved at
// __fixtures__/odds-api-event-alt-lines-response.json.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { ODDS_API_BASE_URL, readOddsApiCredits, resolveOddsGame, type OddsGame, type OddsLoader } from "@/server/data/odds";
import { getLatestCreditUsageLevel, persistOddsApiUsage } from "@/server/data/odds-api-usage";

export const ALT_LINE_MARKET_KEYS = { TOTAL: "alternate_totals", SPREAD: "alternate_spreads" } as const;
export type AltLineMarketKey = (typeof ALT_LINE_MARKET_KEYS)[keyof typeof ALT_LINE_MARKET_KEYS];

type Bookmakers = OddsGame["bookmakers"];

const DEFAULT_TIMEOUT_MS = 4000;
// Read per call so it can be tuned (and tested) without a redeploy of this file.
function timeoutMs(): number {
  const n = Number(process.env.ALT_LINE_ODDS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Pure. The first bookmaker carrying this exact point on this side wins.
export function altLinePriceFromBookmakers(
  bookmakers: Bookmakers,
  marketKey: AltLineMarketKey,
  outcomeName: string,
  line: number
): number | null {
  for (const bookmaker of bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    const outcome = market?.outcomes.find((o) => o.name === outcomeName && o.point === line);
    if (outcome) return outcome.price;
  }
  return null;
}

// Requests under way on this instance, by event|market|day. A paste resolves
// every line at once, so two picks on one game reach here together: the second
// waits on the first's request instead of losing the race for the row and
// going unpriced. Also what keeps a timed-out request from being repeated.
const inFlight = new Map<string, Promise<Bookmakers | null>>();

async function releaseClaim(eventId: string, marketKey: string, fetchDate: string): Promise<void> {
  try {
    await prisma.oddsAltLineFetch.deleteMany({ where: { eventId, marketKey, fetchDate } });
  } catch (err) {
    console.error(
      "[alt-line-odds] could not release a failed request's row - this event + market will not be retried today",
      JSON.stringify({ eventId, marketKey, fetchDate, error: err instanceof Error ? err.message : String(err) })
    );
  }
}

// The stored market for this event today, buying it first if nobody has. null
// when there is nothing to price from.
async function loadAltLineMarket(
  game: OddsGame,
  sportKey: string,
  marketKey: AltLineMarketKey,
  fetchDate: string,
  apiKey: string
): Promise<Bookmakers | null> {
  const eventId = game.id;
  const where = { eventId_marketKey_fetchDate: { eventId, marketKey, fetchDate } };

  const existing = await prisma.oddsAltLineFetch.findUnique({ where });
  if (existing) return (existing.bookmakers as Bookmakers | null) ?? null;

  if (!(new Date(game.commenceTime) > new Date())) return null;

  if ((await getLatestCreditUsageLevel()) === "stop_lower_priority") {
    console.error(
      "[alt-line-odds] skipped - credit usage >=95%, lower-priority markets paused",
      JSON.stringify({ eventId, marketKey })
    );
    return null;
  }

  try {
    await prisma.oddsAltLineFetch.create({ data: { eventId, marketKey, fetchDate, sportKey } });
  } catch (err) {
    // Another request created the row first and owns the fetch. Whatever it
    // has stored by now is all there is for this pick.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const theirs = await prisma.oddsAltLineFetch.findUnique({ where });
      return (theirs?.bookmakers as Bookmakers | null | undefined) ?? null;
    }
    throw err;
  }

  // A preseason game's event URL needs the key its listing came from.
  const requestSportKey = game.sportKey.startsWith(sportKey) ? game.sportKey : sportKey;
  const url =
    ODDS_API_BASE_URL +
    "/sports/" +
    requestSportKey +
    "/events/" +
    eventId +
    "/odds?apiKey=" +
    apiKey +
    "&regions=us&markets=" +
    marketKey +
    "&oddsFormat=american";

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    console.error(
      "[alt-line-odds] upstream fetch threw",
      JSON.stringify({ eventId, marketKey, error: err instanceof Error ? err.message : String(err) })
    );
    await releaseClaim(eventId, marketKey, fetchDate);
    return null;
  }

  const credits = readOddsApiCredits(res, { sportKey, requestSportKey });
  // One odds_api_usage_log row per call that got a response, failed or not. A
  // failed write there never loses the odds just bought.
  const logUsage = () =>
    persistOddsApiUsage({ sportKey, marketsRequested: [marketKey], eventsRequested: 1, credits, httpStatus: res.status, caller: "alt-lines" }).catch((err) => {
      console.error(
        "[alt-line-odds] failed to persist usage log",
        JSON.stringify({ eventId, marketKey, error: err instanceof Error ? err.message : String(err) })
      );
    });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    console.error(
      "[alt-line-odds] upstream fetch failed",
      JSON.stringify({ eventId, marketKey, status: res.status, statusText: res.statusText, body: bodyText.slice(0, 500) })
    );
    await logUsage();
    await releaseClaim(eventId, marketKey, fetchDate);
    return null;
  }

  // From here the call may have been charged, so the row stays whatever happens.
  const raw = (await res.json()) as { bookmakers?: Bookmakers };
  const bookmakers = (Array.isArray(raw.bookmakers) ? raw.bookmakers : [])
    .map((b) => ({ key: b.key, title: b.title, markets: b.markets.filter((m) => m.key === marketKey) }))
    .filter((b) => b.markets.length > 0);

  if (bookmakers.length > 0) {
    await prisma.oddsAltLineFetch.update({ where, data: { bookmakers: bookmakers as unknown as Prisma.InputJsonValue } });
  }
  await logUsage();

  console.log(
    "[alt-line-odds] fetched",
    JSON.stringify({ eventId, sportKey, marketKey, fetchDate, bookmakers: bookmakers.length, cost: credits.lastCost })
  );
  return bookmakers.length > 0 ? bookmakers : null;
}

// The price of a full-game SPREAD or TOTAL pick at its own line, from the
// event's alternate market. `line` is the pick's signed spread or its total.
// Never throws and never waits longer than the timeout: anything that goes
// wrong is null, which the caller already treats as "no feed price".
export async function findAltLinePrice(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  betType: "SPREAD" | "TOTAL",
  side: "home" | "away" | "over" | "under",
  line: number,
  getOdds?: OddsLoader
): Promise<number | null> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const oddsGame = await resolveOddsGame(sportKey, game, getOdds);
    if (!oddsGame) return null;

    const marketKey = ALT_LINE_MARKET_KEYS[betType];
    const fetchDate = easternDateKey(new Date());
    const key = [oddsGame.id, marketKey, fetchDate].join("|");

    let pending = inFlight.get(key);
    if (!pending) {
      // Never rejects: a request that outlives the timeout below has nobody
      // left waiting on it.
      pending = loadAltLineMarket(oddsGame, sportKey, marketKey, fetchDate, apiKey)
        .catch((err): null => {
          console.error(
            "[alt-line-odds] lookup failed",
            JSON.stringify({ eventId: oddsGame.id, marketKey, error: err instanceof Error ? err.message : String(err) })
          );
          return null;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    const timedOut = Symbol("timedOut");
    const waitMs = timeoutMs();
    const result = await Promise.race([
      pending,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), waitMs);
      }),
    ]);
    if (result === timedOut) {
      console.error("[alt-line-odds] timed out - pick keeps its own price", JSON.stringify({ eventId: oddsGame.id, marketKey, waitMs }));
      return null;
    }
    if (!result) return null;

    const outcomeName =
      side === "home" ? oddsGame.homeTeam : side === "away" ? oddsGame.awayTeam : side === "over" ? "Over" : "Under";
    return altLinePriceFromBookmakers(result, marketKey, outcomeName, line);
  } catch (err) {
    console.error("[alt-line-odds] could not resolve the game's odds", JSON.stringify({ sportKey, error: err instanceof Error ? err.message : String(err) }));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
