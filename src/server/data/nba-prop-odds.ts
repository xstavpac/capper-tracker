// NBA player-prop prices, bought on demand at import.
//
// An NBA prop line with no price of its own used to be stored at the -110 placeholder (DEFAULTED). This prices it
// from the Odds API's per-event player-prop market instead, the same way alt-line-odds.ts prices an off-main spread
// or total:
//   - only the ONE market the pick needs, for its one event (/events/{eventId}/odds?markets=<key>), at 1 credit per
//     market returned per region. Cost is the same whether markets are bundled or not, so one market per request.
//   - bought at most once per event and market per REUSE_WINDOW_MS (2 h): a fetch younger than that is reused.
//     odds_prop_fetches is the claim: its row is created BEFORE the request, with the unique key (event, market,
//     bucket) stopping a second buyer on this instance or another. A request that fails outright bought nothing, so
//     its row is deleted by id.
//   - the lines live in odds_prop_lines, never in odds_snapshots: the day's game-odds row stays the same size, and a
//     pick reads only the rows at its own line plus the fetch's distinct player names (a few KB).
//   - skipped for a game that has started (the feed would return in-play prices), at >=95% credit usage (the same
//     gate as every other lower-priority market), and when there is no API key. A fetch made before tip is still
//     reused for a pick that arrives after it.
//   - the import waits NBA_PROP_ODDS_TIMEOUT_MS at most. A slower request finishes in the background and its result
//     prices the next pick on that game.
//
// Price rule - exact line only, never the nearest one ("Over 19.5" is not priced off a 24.5 line):
//   1. the player is resolved through the two teams' roster with nba-prop-grading.ts's matchByName tiers (exact,
//      accent-folded, suffix-stripped, then a surname unique in the game), and only then matched to the book's own
//      spelling. A name the roster can't tie to exactly one player in this game is left unpriced - a fuzzy match on
//      the book's names alone could price a different player (Jalen vs Jaylin Williams).
//   2. the first bookmaker in feed order with that player, side and exact point wins (bookOrder) - the same rule as
//      game lines (findMarketPricePoint, odds.ts).
//   3. the player is listed but no book hangs the pick's number -> no_exact_line. Not listed, ambiguous, or nothing
//      fetched -> no_market.
//
// Market keys and outcome shape confirmed live 2026-11-11 against Boston Celtics @ Toronto Raptors
// (commence_time 2026-11-12T00:10:00Z) via
//   GET /v4/sports/basketball_nba/events/{eventId}/odds?regions=us&markets=<the ten keys below>&oddsFormat=american
// (x-requests-last: 9 - player_blocks was not returned for that game). 8 books, 1,178 outcomes, every one
// `{ name: "Over"|"Under", description: "<player>", price, point }`. Bovada lists several points per player (a
// ladder inside the main market). Saved verbatim at __fixtures__/odds-api-event-nba-player-props-2026-11-11.json.
// player_blocks was confirmed on FanDuel 2026-10-27 (lib/parlay/fanduel-link.ts NBA_LINE_PROP_KEYS).
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isLikelyDuplicateName, normalizeName } from "@/lib/fuzzy-match";
import { teamNamesMatch } from "@/lib/team-name-match";
import type { NbaPropMarket } from "@/lib/nba-prop";
import { ODDS_API_BASE_URL, readOddsApiCredits, resolveOddsGame, type OddsApiCredits, type OddsGame, type OddsLoader } from "@/server/data/odds";
import { getLatestCreditUsageLevel, persistOddsApiUsage, type CreditUsageLevel } from "@/server/data/odds-api-usage";
import { fold, matchByName, stripSuffix } from "@/server/data/nba-prop-grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export const NBA_SPORT_KEY = "basketball_nba";
export const NBA_PROP_ODDS_CALLER = "nba-prop-odds";
export const REUSE_WINDOW_MS = 2 * 60 * 60 * 1000;

// PropMarket -> the Odds API main-market key. DEFENSIVE_REBOUNDS and DOUBLE_DOUBLE have none: never fetched.
export const NBA_PROP_ODDS_MARKET_KEYS: Partial<Record<NbaPropMarket, string>> = {
  POINTS: "player_points",
  REBOUNDS: "player_rebounds",
  ASSISTS: "player_assists",
  THREES_MADE: "player_threes",
  STEALS: "player_steals",
  BLOCKS: "player_blocks",
  POINTS_REBOUNDS_ASSISTS: "player_points_rebounds_assists",
  POINTS_REBOUNDS: "player_points_rebounds",
  POINTS_ASSISTS: "player_points_assists",
  REBOUNDS_ASSISTS: "player_rebounds_assists",
};

const DEFAULT_TIMEOUT_MS = 4000;
function timeoutMs(): number {
  const n = Number(process.env.NBA_PROP_ODDS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function reuseBucket(nowMs: number): number {
  return Math.floor(nowMs / REUSE_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export type PropLineRow = {
  bookOrder: number;
  bookKey: string;
  playerName: string;
  side: "Over" | "Under";
  point: number;
  price: number;
  bookLastUpdate: Date | null;
};

// Every Over/Under outcome of `marketKey` with a player and a numeric point, in feed order. bookOrder is the book's
// index in the response's bookmakers array.
export function propLinesFromBookmakers(bookmakers: OddsGame["bookmakers"], marketKey: string): PropLineRow[] {
  const rows: PropLineRow[] = [];
  bookmakers.forEach((bookmaker, bookOrder) => {
    for (const market of bookmaker.markets ?? []) {
      if (market.key !== marketKey) continue;
      const lastUpdate = market.last_update ? new Date(market.last_update) : null;
      for (const o of market.outcomes ?? []) {
        if (o.name !== "Over" && o.name !== "Under") continue;
        if (!o.description || typeof o.point !== "number" || typeof o.price !== "number") continue;
        rows.push({
          bookOrder,
          bookKey: bookmaker.key,
          playerName: o.description,
          side: o.name,
          point: o.point,
          price: o.price,
          bookLastUpdate: lastUpdate && !Number.isNaN(lastUpdate.getTime()) ? lastUpdate : null,
        });
      }
    }
  });
  return rows;
}

// One identity per spelling: case, punctuation ("R.J."), accents ("Şengün") and a Jr./III suffix don't count.
export function playerNameKey(name: string): string {
  return normalizeName(stripSuffix(fold(name)));
}

const lastWord = (full: string) => stripSuffix(full).trim().split(/\s+/).pop() ?? full;

export type BookPlayerMatch = { status: "one"; name: string } | { status: "many" } | { status: "none" };

// Which of the book's player names the capper's typed name is. `inGameRoster` is the roster cut to this game's two
// teams. See the header for why identity comes from the roster first.
export function resolveBookPlayerName(typed: string, bookNames: string[], inGameRoster: RosterPlayer[]): BookPlayerMatch {
  const distinctBook = [...new Map(bookNames.map((n) => [playerNameKey(n), n])).values()];
  const r = matchByName(typed, inGameRoster, (p) => p.externalPlayerId, (p) => p.playerName, (p) => p.lastName);
  if (r.status === "many") return { status: "many" };
  if (r.status === "one") {
    const canonical = r.item;
    const key = playerNameKey(canonical.playerName);
    const exact = distinctBook.filter((n) => playerNameKey(n) === key);
    if (exact.length === 1) return { status: "one", name: exact[0] };
    // The book spells this player differently ("Nic" / "Nicolas"): a near spelling counts only when it is not the
    // exact name of someone else in this game.
    const near = distinctBook.filter(
      (n) =>
        isLikelyDuplicateName(stripSuffix(fold(n)), stripSuffix(fold(canonical.playerName))) &&
        !inGameRoster.some((p) => p.externalPlayerId !== canonical.externalPlayerId && playerNameKey(p.playerName) === playerNameKey(n))
    );
    if (near.length === 1) return { status: "one", name: near[0] };
    return near.length > 1 ? { status: "many" } : { status: "none" };
  }
  // The roster has nobody by this name in this game (a new signing, or the roster read failed): only a full name
  // that is exactly one of the book's names.
  if (!/\s/.test(stripSuffix(fold(typed)).trim())) return { status: "none" };
  const exact = distinctBook.filter((n) => playerNameKey(n) === playerNameKey(typed));
  return exact.length === 1 ? { status: "one", name: exact[0] } : { status: "none" };
}

// The first book in feed order that lists this player at the pick's side and exact point. `rows` are already cut to
// that side and point.
export function firstBookAtLine<T extends { bookOrder: number; playerName: string }>(rows: T[], bookName: string): T | null {
  const key = playerNameKey(bookName);
  let best: T | null = null;
  for (const row of rows) {
    if (playerNameKey(row.playerName) !== key) continue;
    if (!best || row.bookOrder < best.bookOrder) best = row;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Storage + fetch
// ---------------------------------------------------------------------------

export type FetchRef = { id: string; fetchedAt: Date };
export type ExactLineRow = { bookOrder: number; bookKey: string; playerName: string; price: number };

export type NbaPropOddsDeps = {
  now: () => number;
  apiKey: () => string | undefined;
  creditLevel: () => Promise<CreditUsageLevel>;
  fetchEvent: (url: string) => Promise<Response>;
  logUsage: (input: { sportKey: string; marketsRequested: string[]; eventsRequested: number; credits: OddsApiCredits; httpStatus: number | null }) => Promise<unknown>;
  getRoster: () => Promise<RosterPlayer[]>;
  store: {
    // The newest completed fetch for (event, market) created at or after `since`.
    findReusable: (eventId: string, marketKey: string, since: Date) => Promise<FetchRef | null>;
    // Creates the claim row; "taken" when another request holds this (event, market, bucket).
    claim: (row: { sportKey: string; eventId: string; marketKey: string; commenceTime: Date; bucket: number }) => Promise<{ id: string } | "taken">;
    findClaim: (eventId: string, marketKey: string, bucket: number) => Promise<{ id: string; fetchedAt: Date | null } | null>;
    saveLines: (fetchId: string, lines: PropLineRow[], fetchedAt: Date) => Promise<void>;
    release: (fetchId: string) => Promise<void>;
    playerNames: (fetchId: string) => Promise<string[]>;
    exactLine: (fetchId: string, side: "Over" | "Under", point: number) => Promise<ExactLineRow[]>;
  };
};

export const prismaNbaPropOddsDeps: NbaPropOddsDeps = {
  now: () => Date.now(),
  apiKey: () => process.env.ODDS_API_KEY,
  creditLevel: getLatestCreditUsageLevel,
  fetchEvent: (url) => fetch(url, { cache: "no-store" }),
  logUsage: (input) => persistOddsApiUsage({ ...input, caller: NBA_PROP_ODDS_CALLER }),
  getRoster: async () => (await import("@/server/data/nba-roster-cache")).getCachedNbaRoster(),
  store: {
    findReusable: async (eventId, marketKey, since) => {
      const row = await prisma.oddsPropFetch.findFirst({
        where: { eventId, marketKey, createdAt: { gte: since }, fetchedAt: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { id: true, fetchedAt: true },
      });
      return row && row.fetchedAt ? { id: row.id, fetchedAt: row.fetchedAt } : null;
    },
    claim: async (data) => {
      try {
        return await prisma.oddsPropFetch.create({ data, select: { id: true } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "taken";
        throw err;
      }
    },
    findClaim: (eventId, marketKey, bucket) =>
      prisma.oddsPropFetch.findUnique({ where: { eventId_marketKey_bucket: { eventId, marketKey, bucket } }, select: { id: true, fetchedAt: true } }),
    saveLines: async (fetchId, lines, fetchedAt) => {
      await prisma.$transaction([
        prisma.oddsPropLine.createMany({ data: lines.map((l) => ({ fetchId, ...l })) }),
        prisma.oddsPropFetch.update({ where: { id: fetchId }, data: { fetchedAt, linesStored: lines.length }, select: { id: true } }),
      ]);
    },
    release: async (fetchId) => {
      await prisma.oddsPropFetch.delete({ where: { id: fetchId }, select: { id: true } });
    },
    // SQL DISTINCT: Prisma's findMany `distinct` de-duplicates after reading every row.
    playerNames: async (fetchId) =>
      (await prisma.$queryRaw<{ playerName: string }[]>`SELECT DISTINCT "playerName" FROM "odds_prop_lines" WHERE "fetchId" = ${fetchId}`).map((r) => r.playerName),
    exactLine: (fetchId, side, point) =>
      prisma.oddsPropLine.findMany({
        where: { fetchId, side, point },
        select: { bookOrder: true, bookKey: true, playerName: true, price: true },
        orderBy: { bookOrder: "asc" },
      }),
  },
};

const LOG_TAG = "[nba-prop-odds]";
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Requests under way on this instance, by event|market. A paste resolves every line at once, so two picks on one
// game reach here together: the second waits on the first's request instead of losing the race for the claim row.
const inFlight = new Map<string, Promise<FetchRef | null>>();

// The fetch to price from: a reusable one, or a new one bought now. null when there is nothing to price from.
async function loadFetch(game: OddsGame, marketKey: string, deps: NbaPropOddsDeps): Promise<FetchRef | null> {
  const nowMs = deps.now();
  const eventId = game.id;
  const reusable = await deps.store.findReusable(eventId, marketKey, new Date(nowMs - REUSE_WINDOW_MS));
  if (reusable) return reusable;

  if (!(Date.parse(game.commenceTime) > nowMs)) return null;
  const apiKey = deps.apiKey();
  if (!apiKey) {
    console.error(LOG_TAG + " no ODDS_API_KEY configured");
    return null;
  }
  if ((await deps.creditLevel()) === "stop_lower_priority") {
    console.error(LOG_TAG + " skipped - credit usage >=95%, lower-priority markets paused", JSON.stringify({ eventId, marketKey }));
    return null;
  }

  const bucket = reuseBucket(nowMs);
  const claimed = await deps.store.claim({ sportKey: NBA_SPORT_KEY, eventId, marketKey, commenceTime: new Date(game.commenceTime), bucket });
  if (claimed === "taken") {
    // Another request owns this window's fetch. Whatever it has stored by now is all there is for this pick.
    const theirs = await deps.store.findClaim(eventId, marketKey, bucket);
    return theirs && theirs.fetchedAt ? { id: theirs.id, fetchedAt: theirs.fetchedAt } : null;
  }
  const fetchId = claimed.id;
  const release = () =>
    deps.store.release(fetchId).catch((err) => {
      console.error(LOG_TAG + " could not release a failed request's row - this event + market waits for the next window", JSON.stringify({ eventId, marketKey, fetchId, error: errMsg(err) }));
    });

  // A preseason game's event URL needs the key its listing came from.
  const requestSportKey = game.sportKey && game.sportKey.startsWith(NBA_SPORT_KEY) ? game.sportKey : NBA_SPORT_KEY;
  const url =
    ODDS_API_BASE_URL + "/sports/" + requestSportKey + "/events/" + encodeURIComponent(eventId) + "/odds?apiKey=" + apiKey + "&regions=us&markets=" + marketKey + "&oddsFormat=american";

  let res: Response;
  try {
    res = await deps.fetchEvent(url);
  } catch (err) {
    console.error(LOG_TAG + " upstream fetch threw", JSON.stringify({ eventId, marketKey, error: errMsg(err) }));
    await release();
    return null;
  }

  const credits = readOddsApiCredits(res, { sportKey: NBA_SPORT_KEY, requestSportKey });
  // One odds_api_usage_log row (caller nba-prop-odds) per call that got a response, failed or not. A failed write
  // there never loses the odds just bought.
  const logUsage = () =>
    deps.logUsage({ sportKey: NBA_SPORT_KEY, marketsRequested: [marketKey], eventsRequested: 1, credits, httpStatus: res.status }).catch((err) => {
      console.error(LOG_TAG + " failed to persist usage log", JSON.stringify({ eventId, marketKey, error: errMsg(err) }));
    });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error(LOG_TAG + " upstream fetch failed", JSON.stringify({ eventId, marketKey, status: res.status, body: body.slice(0, 500) }));
    await logUsage();
    await release();
    return null;
  }

  // From here the call may have been charged, so the row stays whatever happens. An empty answer is free and is
  // remembered for the window like any other.
  let lines: PropLineRow[] = [];
  try {
    const raw = (await res.json()) as { bookmakers?: OddsGame["bookmakers"] };
    lines = propLinesFromBookmakers(Array.isArray(raw.bookmakers) ? raw.bookmakers : [], marketKey);
  } catch (err) {
    console.error(LOG_TAG + " unreadable response body", JSON.stringify({ eventId, marketKey, error: errMsg(err) }));
  }
  const fetchedAt = new Date(deps.now());
  await deps.store.saveLines(fetchId, lines, fetchedAt);
  await logUsage();
  console.log(LOG_TAG + " fetched", JSON.stringify({ eventId, marketKey, lines: lines.length, cost: credits.lastCost }));
  return { id: fetchId, fetchedAt };
}

export type NbaPropPrice =
  | { price: number; book: string; capturedAt: Date }
  // reason null: nothing NBA-specific to say (a market with no Odds API key, a game that has started) - the caller's
  // usual classification applies.
  | { price: null; reason: "no_exact_line" | "no_market" | null };

export type NbaPropQuery = { playerName: string; propMarket: string; side: "Over" | "Under"; point: number };

// The price of an NBA prop pick at its own player, side and line. Never throws and never waits longer than the
// timeout: anything that goes wrong is unpriced, which the caller already treats as "no feed price".
export async function findNbaPropPrice(
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  prop: NbaPropQuery,
  getOdds?: OddsLoader,
  deps: NbaPropOddsDeps = prismaNbaPropOddsDeps
): Promise<NbaPropPrice> {
  const marketKey = NBA_PROP_ODDS_MARKET_KEYS[prop.propMarket as NbaPropMarket];
  if (!marketKey) return { price: null, reason: null };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const oddsGame = await resolveOddsGame(NBA_SPORT_KEY, game, getOdds);
    if (!oddsGame) return { price: null, reason: "no_market" };

    const key = oddsGame.id + "|" + marketKey;
    let pending = inFlight.get(key);
    if (!pending) {
      // Never rejects: a request that outlives the timeout below has nobody left waiting on it.
      pending = loadFetch(oddsGame, marketKey, deps)
        .catch((err): null => {
          console.error(LOG_TAG + " lookup failed", JSON.stringify({ eventId: oddsGame.id, marketKey, error: errMsg(err) }));
          return null;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    const timedOut = Symbol("timedOut");
    const waitMs = timeoutMs();
    const fetched = await Promise.race([pending, new Promise<typeof timedOut>((resolve) => (timer = setTimeout(() => resolve(timedOut), waitMs)))]);
    if (fetched === timedOut) {
      console.error(LOG_TAG + " timed out - pick keeps its own price", JSON.stringify({ eventId: oddsGame.id, marketKey, waitMs }));
      return { price: null, reason: "no_market" };
    }
    if (!fetched) {
      // Nothing to price from. A started game says so through the caller's own game_started rule.
      return { price: null, reason: Date.parse(oddsGame.commenceTime) > deps.now() ? "no_market" : null };
    }

    const bookNames = await deps.store.playerNames(fetched.id);
    if (bookNames.length === 0) return { price: null, reason: "no_market" };

    let roster: RosterPlayer[] = [];
    try {
      roster = await deps.getRoster();
    } catch (err) {
      console.error(LOG_TAG + " NBA roster read failed - full-name matches only", JSON.stringify({ error: errMsg(err) }));
    }
    const inGame = roster.filter(
      (p) => teamNamesMatch(p.team, oddsGame.homeTeam, NBA_SPORT_KEY) || teamNamesMatch(p.team, oddsGame.awayTeam, NBA_SPORT_KEY)
    );
    const who = resolveBookPlayerName(prop.playerName, bookNames, inGame);
    if (who.status !== "one") return { price: null, reason: "no_market" };

    const row = firstBookAtLine(await deps.store.exactLine(fetched.id, prop.side, prop.point), who.name);
    if (!row) return { price: null, reason: "no_exact_line" };
    return { price: row.price, book: row.bookKey, capturedAt: fetched.fetchedAt };
  } catch (err) {
    console.error(LOG_TAG + " could not price the pick", JSON.stringify({ error: errMsg(err) }));
    return { price: null, reason: "no_market" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
