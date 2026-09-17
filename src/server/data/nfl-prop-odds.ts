// NFL player-prop odds: event-level fetch + normalization, deliberately
// narrower than the Odds API's full NFL player-prop catalog - every market
// key here has a confirmed extraction path this codebase can already
// resolve a real stat line against (passing: getNflPlayerTdStats's passing
// fields + selectQbPasserRow; rushing/receiving/receptions: extractRushingRows
// / extractReceivingRows in nfl-rushing-receiving-rows.ts), so ingesting a
// line is never pure wasted credit spend on something nothing can ever
// check. Grading itself (turning a stored line + the matching extracted stat
// into a win/loss) is separate, later work for each market - not done here
// for rushing/receiving/receptions, same as it wasn't done in the PR that
// first added the passing markets.
//
// Two shapes are confirmed live (not from docs, not guessed - see the header
// on PLAYER_ANYTIME_TD_MARKET_KEY below for the exact verification):
//   - player_pass_tds / player_pass_yds / player_pass_attempts /
//     player_pass_completions / player_rush_yds / player_reception_yds /
//     player_receptions: two-sided (Over/Under), always carries a `point`
//     (the line). The three rushing/receiving markets were confirmed live
//     2026-09-14 the same way as player_anytime_td - see their own note
//     below.
//   - player_anytime_td: ONE-SIDED ("Yes" only - there is no "No" outcome
//     at all, from any of the 9 bookmakers observed), NEVER carries a
//     `point`. Also carries two kinds of non-player outcomes that must be
//     excluded rather than mis-normalized as a player: a team-defense
//     scoring entry (e.g. "Kansas City Chiefs D/ST", "Denver Broncos
//     Defense" - the suffix isn't consistent across books) and, on at
//     least one book (Fanatics), a literal "No Scorer" outcome (the price
//     on nobody scoring a TD in the game at all).
import { revalidateTag } from "next/cache";
import type { OddsGame, OddsApiCredits } from "@/server/data/odds";
import { ODDS_API_BASE_URL, readOddsApiCredits, resolveOddsGame } from "@/server/data/odds";
import { getLatestCreditUsageLevel, persistOddsApiUsage } from "@/server/data/odds-api-usage";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { cacheKeys } from "@/lib/cache-keys";
import type { PlayerPropMarket } from "@/lib/bet-line";
import { isLikelyDuplicateName } from "@/lib/fuzzy-match";

const NFL_SPORT_KEY = "americanfootball_nfl";

export const NFL_PROP_MARKET_KEYS = [
  "player_pass_tds",
  "player_pass_yds",
  "player_pass_attempts",
  "player_pass_completions",
  "player_anytime_td",
  "player_rush_yds",
  "player_reception_yds",
  "player_receptions",
  "player_rush_reception_yds",
  "player_pass_rush_yds",
] as const;

export type NflPropMarketKey = (typeof NFL_PROP_MARKET_KEYS)[number];

// Confirmed live 2026-09-14 against a real, current NFL event (Denver
// Broncos @ Kansas City Chiefs, commence_time 2026-09-15T00:15:00Z) via
// GET /v4/sports/americanfootball_nfl/events/{eventId}/odds
//   ?regions=us&markets=player_anytime_td&oddsFormat=american
// using the production $30/20K key (confirmed via x-requests-remaining
// dropping 20000 -> 19999 on this exact call, i.e. this call cost exactly 1
// credit - matches the documented cost=markets×regions formula). Real
// response saved verbatim at
// __fixtures__/odds-api-event-anytime-td-response.json. Every one of the 9
// bookmakers present (draftkings, williamhill_us, fanatics, fanduel,
// betonlineag, betmgm, bovada, betrivers) returned outcomes shaped
// `{ name: "Yes", description: "<player or team-defense name>", price }` -
// no bookmaker sent a "No" outcome or a `point` field anywhere in this
// market. This is the only market confirmed one-sided this way; the four
// passing markets are two-sided/point-bearing per the Odds API's own
// published docs example (David Blough, player_pass_tds: Over/Under with
// point 0.5) - see __fixtures__/odds-api-event-pass-tds-doc-example.json,
// which is doc-derived, not independently live-verified the way
// player_anytime_td is.
//
// player_rush_yds / player_reception_yds / player_receptions were separately
// confirmed live 2026-09-14 against the same event (Denver Broncos @ Kansas
// City Chiefs) via one bundled call:
//   GET /v4/sports/americanfootball_nfl/events/{eventId}/odds
//     ?regions=us&markets=player_rush_yds,player_reception_yds,player_receptions&oddsFormat=american
// (confirmed via x-requests-remaining dropping 19980 -> 19977, i.e. exactly 3
// credits for 3 markets × 1 region - matches the documented cost formula).
// All 346 outcomes across 6 bookmakers (draftkings, fanatics, fanduel,
// betonlineag, bovada, betrivers) were two-sided Over/Under, every one
// carrying a `point`, same shape as the passing markets - no
// player_anytime_td-style surprises (no one-sided market, no missing
// `point`, no non-player sentinel outcomes observed). Real response saved
// verbatim at __fixtures__/odds-api-event-rush-rec-response.json.
//
// player_rush_reception_yds / player_pass_rush_yds (combined-category
// markets - a single Over/Under line on the SUM of two stat categories, the
// NFL analog of NBA's points+rebounds+assists) were separately confirmed
// live 2026-09-17 against a real, current NFL event (Detroit Lions @ Buffalo
// Bills, commence_time 2026-09-18T00:15:00Z) via:
//   GET /v4/sports/americanfootball_nfl/events/{eventId}/odds
//     ?regions=us&markets=player_rush_reception_yds,player_pass_rush_yds,player_pass_rush_reception_yds,player_rush_reception_tds,player_pass_rush_reception_tds&oddsFormat=american
// (confirmed via x-requests-remaining dropping 19395 -> 19392, i.e. 3
// credits - only 3 of the 5 requested markets were actually returned by any
// bookmaker for this game/date, matching the documented "cost = markets
// RETURNED × regions" formula, not markets requested). Both confirmed
// markets were two-sided Over/Under with a `point`, same shape as every
// other market in this file:
//   - player_rush_reception_yds: Jahmyr Gibbs (DET) Over/Under 123.5-124.5,
//     James Cook (BUF) 99.5-103.5, on draftkings/fanduel/betmgm/betrivers.
//   - player_pass_rush_yds: Josh Allen (BUF) Over/Under 290.5-291.5, on
//     draftkings/betmgm/betrivers.
// Real response saved verbatim at
// __fixtures__/odds-api-event-combined-props-response.json.
//
// Two markets requested in the same call were NOT added to
// NFL_PROP_MARKET_KEYS above, deliberately withheld pending stronger
// confirmation:
//   - player_pass_rush_reception_yds (the 3-way pass+rush+rec combo, the
//     true PRA equivalent): DID come back, but only on Fanatics and only for
//     Gibbs (a non-passer) at 120.5 - suspiciously close to his rush+rec
//     line, not proof this market behaves sensibly when offered on an actual
//     QB. Hold until confirmed live on a real passer.
//   - player_rush_reception_tds / player_pass_rush_reception_tds (combined
//     TD variants): documented by the provider (see betting-markets.html)
//     but NOT returned by any bookmaker in this call at all - unconfirmed
//     live, same bar every other market in this file had to clear.
export const PLAYER_ANYTIME_TD_MARKET_KEY: NflPropMarketKey = "player_anytime_td";

// Sentinel non-player outcomes observed on real player_anytime_td responses.
// "No Scorer" (Fanatics) prices the field "nobody scores a TD" - not a
// player prop line at all, and would otherwise land in storage looking like
// a player named "No Scorer".
const ANYTIME_TD_NON_PLAYER_SENTINELS = new Set(["No Scorer"]);

export type PlayerPropLine = {
  eventId: string;
  marketKey: NflPropMarketKey;
  bookmakerKey: string;
  bookmakerTitle: string;
  playerName: string;
  // "Over" | "Under" for the four numeric props; always "Yes" for
  // player_anytime_td (see header - there is no "No" side in real data).
  side: string;
  // The line (e.g. 1.5 for "Over 1.5 Passing TDs"). Always null for
  // player_anytime_td - confirmed live, not defaulted defensively.
  point: number | null;
  price: number;
  lastUpdate: string | null;
  // Single string identity for map keys / dedupe - equivalent to the tuple
  // (eventId, marketKey, playerName, side, point), so "Josh Allen Anytime
  // TD" (player_anytime_td|Josh Allen|Yes|null) and "Josh Allen Over 1.5
  // Passing TDs" (player_pass_tds|Josh Allen|Over|1.5) can never collide -
  // marketKey alone already guarantees that, this just makes it explicit
  // and greppable rather than relying on callers to remember to include it.
  lineKey: string;
};

function isTeamName(description: string, game: OddsGame): boolean {
  // Team-defense scoring outcomes are labeled inconsistently across books
  // ("Kansas City Chiefs D/ST" on DraftKings/BetMGM, "Denver Broncos
  // Defense" on FanDuel - both confirmed live on the same event) - rather
  // than enumerate every suffix a book might use, this checks whether the
  // outcome is about one of THIS game's two teams at all, which every
  // observed defense-outcome spelling satisfies and no real player name
  // ever does (no NFL player is named after their team's city+nickname).
  return description.startsWith(game.homeTeam) || description.startsWith(game.awayTeam);
}

// Pure normalization over an already-fetched/cached OddsGame (the same
// shape getOddsForSport already returns/stores) - does not fetch anything
// itself. Restricted to bookmakers/markets whose key is one of
// NFL_PROP_MARKET_KEYS; every other market on the game (h2h, spreads,
// totals, any prop beyond these five) is ignored here, not stripped from
// storage - this function only picks out what it normalizes, the raw
// OddsGame blob keeps everything the API returned.
export function normalizePlayerPropLines(game: OddsGame): PlayerPropLine[] {
  const lines: PlayerPropLine[] = [];

  for (const bookmaker of game.bookmakers) {
    for (const market of bookmaker.markets) {
      if (!(NFL_PROP_MARKET_KEYS as readonly string[]).includes(market.key)) continue;
      const marketKey = market.key as NflPropMarketKey;

      for (const outcome of market.outcomes) {
        const playerName = outcome.description;
        if (!playerName) continue; // can't identify the subject - skip rather than store an anonymous line

        if (marketKey === PLAYER_ANYTIME_TD_MARKET_KEY) {
          if (ANYTIME_TD_NON_PLAYER_SENTINELS.has(playerName)) continue;
          if (isTeamName(playerName, game)) continue;
        }

        const point = marketKey === PLAYER_ANYTIME_TD_MARKET_KEY ? null : outcome.point ?? null;
        const side = outcome.name;

        lines.push({
          eventId: game.id,
          marketKey,
          bookmakerKey: bookmaker.key,
          bookmakerTitle: bookmaker.title,
          playerName,
          side,
          point,
          price: outcome.price,
          lastUpdate: market.last_update ?? null,
          lineKey: [game.id, marketKey, playerName, side, point ?? "null"].join("|"),
        });
      }
    }
  }

  return lines;
}

// One HTTP request per event, all eight markets bundled into one `markets`
// param (the Odds API's own documented pattern for this endpoint - see this
// file's header) rather than eight separate per-market requests. Per the
// Odds API's documented cost formula (cost = markets returned × regions),
// bundling doesn't reduce credit cost vs. eight separate 1-market calls, but
// it does mean one round-trip instead of eight, and matches how the
// provider's own docs show this endpoint used.
const PROP_MARKETS_PARAM = NFL_PROP_MARKET_KEYS.join(",");

async function fetchOneEventPropOdds(
  eventId: string,
  apiKey: string
): Promise<{ bookmakers: OddsGame["bookmakers"] | null; credits: OddsApiCredits | null; ok: boolean }> {
  const url =
    ODDS_API_BASE_URL +
    "/sports/americanfootball_nfl/events/" +
    eventId +
    "/odds?apiKey=" +
    apiKey +
    "&regions=us&markets=" +
    PROP_MARKETS_PARAM +
    "&oddsFormat=american";

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    console.error(
      "[nfl-prop-odds] upstream fetch threw",
      JSON.stringify({ eventId, error: err instanceof Error ? err.message : String(err) })
    );
    return { bookmakers: null, credits: null, ok: false };
  }

  const credits = readOddsApiCredits(res, { sportKey: "americanfootball_nfl", requestSportKey: "americanfootball_nfl" });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable body>");
    console.error(
      "[nfl-prop-odds] upstream fetch failed",
      JSON.stringify({ eventId, status: res.status, statusText: res.statusText, body: bodyText.slice(0, 500) })
    );
    return { bookmakers: null, credits, ok: false };
  }

  const raw = await res.json();
  return { bookmakers: Array.isArray(raw.bookmakers) ? raw.bookmakers : [], credits, ok: true };
}

// PlayerPropMarket (bet-line.ts, mirrors schema.prisma's PropMarket enum) ->
// the Odds API market key that carries its Over/Under+point line. TD
// deliberately has no entry: player_anytime_td is one-sided ("Yes" only,
// never a `point` - see this file's header) and has no Over/Under+line
// concept to match a pick's parsed side/point against, so a TD prop with no
// explicit odds simply keeps the -110 default, same as before this resolver
// existed - resolvePropOddsFromGame returns null for it below rather than
// guessing at a price from a differently-shaped market.
const PLAYER_PROP_ODDS_MARKET_KEYS: Partial<Record<PlayerPropMarket, NflPropMarketKey>> = {
  PASS_YDS: "player_pass_yds",
  RUSH_YDS: "player_rush_yds",
  REC_YDS: "player_reception_yds",
  RECEPTIONS: "player_receptions",
  RUSH_REC_YDS: "player_rush_reception_yds",
  PASS_RUSH_YDS: "player_pass_rush_yds",
};

export type PlayerPropOddsQuery = {
  playerName: string;
  propMarket: PlayerPropMarket;
  side: "Over" | "Under";
  point: number;
};

// Pure - matches a bulk-imported player-prop pick's parsed playerName/
// propMarket/side/point against an already-fetched/cached OddsGame's prop
// lines (via normalizePlayerPropLines above), so it's directly testable
// against real captured fixtures with no DB/network. Same "first bookmaker
// that has it wins" policy as findMarketPrice (odds.ts): normalizePlayerPropLines
// iterates game.bookmakers in the game's own array order, so the first line
// in its output that matches marketKey+side+point+player is exactly the
// first bookmaker that carries this exact line - no separate sort needed.
// Player-name matching reuses isLikelyDuplicateName (fuzzy-match.ts), the
// same fuzzy match resolveTouchdownProp (grading.ts) already uses to pair a
// capper's typed name against a real box-score/roster name, rather than a
// new matching strategy. Returns null - same as findMarketPrice - when the
// market has no Over/Under+point concept (TD), or no bookmaker has this
// exact player+market+side+point combination (the player isn't offered this
// market, or every offered line is at a different point than the pick's).
export function resolvePropOddsFromGame(game: OddsGame, prop: PlayerPropOddsQuery): number | null {
  const marketKey = PLAYER_PROP_ODDS_MARKET_KEYS[prop.propMarket];
  if (!marketKey) return null;

  const lines = normalizePlayerPropLines(game);
  const match = lines.find(
    (l) =>
      l.marketKey === marketKey &&
      l.side === prop.side &&
      l.point === prop.point &&
      isLikelyDuplicateName(l.playerName, prop.playerName)
  );
  return match ? match.price : null;
}

// Async wrapper - resolves the schedule-sourced game to its cached OddsGame
// first (same resolveOddsGame team-pair + closest-commenceTime match
// findMarketPrice uses, exported from odds.ts for exactly this caller), then
// delegates to the pure matcher above. Mirrors findFavoredSide/
// favoredSideFromOddsGame's own resolveOddsGame + pure-function split
// (odds.ts). The entry point bulk-picks.ts's resolveGameAndOdds calls for a
// PLAYER_PROP pick with no explicit odds in its text.
export async function resolvePropOdds(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  prop: PlayerPropOddsQuery
): Promise<number | null> {
  const oddsGame = await resolveOddsGame(sportKey, game);
  if (!oddsGame) return null;
  return resolvePropOddsFromGame(oddsGame, prop);
}

// Merges freshly-fetched prop-market bookmakers into an existing OddsGame's
// bookmakers array - additive, per bookmaker: a book already present (the
// common case, since the same sportsbooks post game-lines and props) gets
// its prop markets appended; a book that only appears in the props response
// (rare, but not assumed impossible) is added as a new bookmaker entry. A
// market key collision within one bookmaker (shouldn't happen - this is
// only ever called once per event per day) replaces rather than duplicates,
// as a defensive backstop, not the expected path.
export function mergePropBookmakersIntoGame(game: OddsGame, propBookmakers: OddsGame["bookmakers"]): OddsGame {
  const bookmakers = game.bookmakers.map((b) => ({ ...b, markets: [...b.markets] }));

  for (const propBook of propBookmakers) {
    const existing = bookmakers.find((b) => b.key === propBook.key);
    if (!existing) {
      bookmakers.push({ ...propBook, markets: [...propBook.markets] });
      continue;
    }
    for (const propMarket of propBook.markets) {
      const existingIndex = existing.markets.findIndex((m) => m.key === propMarket.key);
      if (existingIndex === -1) existing.markets.push(propMarket);
      else existing.markets[existingIndex] = propMarket;
    }
  }

  return { ...game, bookmakers };
}

export type NflPropFetchSummary = {
  games: OddsGame[];
  eventsFetched: number;
  eventsSkippedCreditGate: number;
  eventsFailed: number;
};

// Orchestrates the whole "fetch + merge props for every not-yet-started NFL
// game" step - called once from getOddsForSportUncached's NFL seed path
// (odds.ts), never a separate poll cycle. `games` must already be filtered
// to not-yet-started events by the caller (same commenceTime > fetchedAt
// filter getOddsForSportUncached already applies to the bulk game-lines
// fetch) - this function does not re-check that itself.
//
// Cost shape worth knowing operationally: unlike the bulk game-lines fetch
// (one flat-cost call per sport regardless of game count), this is metered
// PER EVENT, up to 10 markets × 1 region = up to 10 credits/event - actual
// cost is markets RETURNED, not requested (confirmed live both for the
// original 8-market bundle and again for the 2 combined-category markets
// added 2026-09-17 - see PLAYER_ANYTIME_TD_MARKET_KEY's header), so a game
// where a bookmaker hasn't posted every one of these 10 markets costs less
// than the ceiling. Because OddsSnapshot locks in a
// fresh snapshot every day and NFL slates are often posted a full week
// ahead, a game that hasn't started yet gets its props re-fetched on every
// day's run until kickoff - there is no cross-day "already fetched props
// for this event" memory here. A full week's slate (~16 games) requested
// daily for up to a week before kickoff could cost meaningfully more than
// a single day's worth; this was a deliberate scope decision (building
// that dedup needs real consumption data this table now provides, per the
// reconciled plan's "measure, don't pre-model" principle - see
// docs/odds-expansion-reconciled-plan.md §1) rather than an oversight, but
// it's exactly what the 95% stop-lower-priority gate below exists to catch
// if it runs hotter than expected.
export async function fetchAndMergeNflPropOdds(games: OddsGame[], apiKey: string): Promise<NflPropFetchSummary> {
  let result = [...games];
  let eventsFetched = 0;
  let eventsSkippedCreditGate = 0;
  let eventsFailed = 0;

  // Freshest known level, re-checked from each call's own returned credits
  // as the loop proceeds (not re-queried from the DB every iteration) so a
  // threshold crossed mid-batch stops the REST of the batch immediately,
  // not just the next cron run.
  let level = await getLatestCreditUsageLevel();

  for (const game of games) {
    if (level === "stop_lower_priority") {
      eventsSkippedCreditGate++;
      continue;
    }

    const { bookmakers, credits, ok } = await fetchOneEventPropOdds(game.id, apiKey);
    if (!ok || !bookmakers) {
      eventsFailed++;
      continue;
    }

    result = result.map((g) => (g.id === game.id ? mergePropBookmakersIntoGame(g, bookmakers) : g));
    eventsFetched++;

    if (credits) {
      const { level: newLevel } = await persistOddsApiUsage({
        sportKey: "americanfootball_nfl",
        marketsRequested: [...NFL_PROP_MARKET_KEYS],
        eventsRequested: 1,
        credits,
      });
      level = newLevel;
    }
  }

  if (eventsSkippedCreditGate > 0) {
    console.error(
      "[nfl-prop-odds] skipped events - credit usage >=95%, lower-priority markets paused",
      JSON.stringify({ eventsSkippedCreditGate, eventsFetched, eventsFailed })
    );
  }

  return { games: result, eventsFetched, eventsSkippedCreditGate, eventsFailed };
}

export type NflPropSeedStatus = "seeded" | "no_api_key" | "no_snapshot" | "no_games_to_fetch";

// True only for the one NflPropSeedStatus where the update below actually
// ran - "no_api_key"/"no_snapshot"/"no_games_to_fetch" all leave the row
// untouched, same reasoning as odds.ts's oddsWriteInvalidatesCache /
// backfillWriteInvalidatesCache for the other two OddsSnapshot write paths.
export function nflPropWriteInvalidatesCache(status: NflPropSeedStatus): boolean {
  return status === "seeded";
}

// The entry point the refresh-odds cron calls, once, right after its
// existing Promise.all(LIVE_SPORTS.map(seedOddsSnapshot)) bulk seed - same
// cron invocation, not a new poll cycle (see route.ts). Reads today's
// OddsSnapshot row directly (already written by the bulk seed step earlier
// in the SAME cron run, via getOddsForSportUncached/odds.ts) rather than
// making a fresh call, so this never re-fetches game-lines, only adds
// event-level prop markets on top of what's already cached today.
export async function seedNflPropOddsForToday(): Promise<NflPropFetchSummary & { status: NflPropSeedStatus }> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("[nfl-prop-odds] no ODDS_API_KEY configured");
    return { games: [], eventsFetched: 0, eventsSkippedCreditGate: 0, eventsFailed: 0, status: "no_api_key" };
  }

  const fetchDate = easternDateKey(new Date());
  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey: NFL_SPORT_KEY, fetchDate } },
  });
  if (!existing) {
    // The bulk seed step hasn't written today's row yet (off-season, no API
    // key, or its own fetch failed) - nothing to attach props to. Not an
    // error here specifically; the bulk step already reported its own
    // status.
    return { games: [], eventsFetched: 0, eventsSkippedCreditGate: 0, eventsFailed: 0, status: "no_snapshot" };
  }

  const games = existing.data as unknown as OddsGame[];
  const now = new Date();
  // Same "never fetch odds for an already-started game" guarantee as the
  // bulk fetch (odds.ts) - a game that kicked off between the bulk seed and
  // this step (both run in the same cron invocation, so this window is
  // seconds, not minutes, but the guard costs nothing and matches the rest
  // of this file's behavior exactly).
  const notStarted = games.filter((g) => new Date(g.commenceTime) > now);
  if (notStarted.length === 0) {
    return { games, eventsFetched: 0, eventsSkippedCreditGate: 0, eventsFailed: 0, status: "no_games_to_fetch" };
  }

  const summary = await fetchAndMergeNflPropOdds(notStarted, apiKey);

  // Re-merge the (possibly enriched) not-started subset back into the full
  // day's game list - `games` can also include already-started games from
  // earlier today (an early-window game already kicked off while a late-
  // window game hasn't), which fetchAndMergeNflPropOdds never saw and must
  // pass through untouched.
  const enrichedById = new Map(summary.games.map((g) => [g.id, g]));
  const merged = games.map((g) => enrichedById.get(g.id) ?? g);

  await prisma.oddsSnapshot.update({
    where: { sportKey_fetchDate: { sportKey: NFL_SPORT_KEY, fetchDate } },
    data: { data: merged as any },
  });

  // Independent invalidation, not a reuse of seedOddsSnapshot's - this
  // function runs right after seedOddsSnapshot in the SAME refresh-odds cron
  // request (see route.ts) and writes to the SAME NFL row a second time,
  // enriching it with prop markets. Without this call, any read landing
  // between the two writes would repopulate the cache from the pre-
  // enrichment data with nothing left to invalidate it again - the prop-
  // enriched row would then stay masked until the TTL backstop or the next
  // day's cron. Same try/catch/log-and-continue treatment as the other two
  // write paths, and this call's own local fetchDate (already matches the
  // WHERE clause above), never a second new Date() computation.
  if (nflPropWriteInvalidatesCache("seeded")) {
    try {
      revalidateTag(cacheKeys.odds(NFL_SPORT_KEY, fetchDate));
    } catch (err) {
      console.error(
        "[seedNflPropOddsForToday] revalidateTag failed - odds write succeeded, cache invalidation did not; TTL backstop will catch up",
        JSON.stringify({ sportKey: NFL_SPORT_KEY, error: err instanceof Error ? err.message : String(err) })
      );
    }
  }

  console.log(
    "[nfl-prop-odds] seeded",
    JSON.stringify({
      fetchDate,
      eventsConsidered: notStarted.length,
      eventsFetched: summary.eventsFetched,
      eventsSkippedCreditGate: summary.eventsSkippedCreditGate,
      eventsFailed: summary.eventsFailed,
    })
  );

  return { ...summary, games: merged, status: "seeded" };
}
