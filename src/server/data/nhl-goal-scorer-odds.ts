// NHL event-level odds: the two NHL markets the Odds API's per-event endpoint
// is asked for - player_goal_scorer_anytime (anytime goal scorer) and h2h_3_way
// (the 3-way, regulation-time moneyline). Same endpoint and the same
// fetch/merge/usage-log loop as the NFL props (fetchAndMergeEventPropOdds in
// nfl-prop-odds.ts), kept cheap two ways:
//   - both markets go in ONE request per game, and a game is only asked for
//     the markets it doesn't carry yet. Cost = markets returned x regions, so
//     at most 2 credits per game, however many runs it takes to get both;
//   - only today's games starting within NHL_GOAL_SCORER_LOOKAHEAD_MS are
//     requested, so a game is bought on the day it is played, not on every
//     day it sits on the upcoming slate.
//
// Two runs a day call seedNhlGoalScorerOddsForToday: the refresh-odds cron just
// after midnight ET, and /api/cron/nhl-goal-scorer-odds at 16:30 UTC for games
// still missing a market. A market that isn't returned costs nothing, and one
// a game already has is never asked for again.
//
// h2h_3_way confirmed live 2026-10-12 against a real event (Vegas Golden
// Knights @ Minnesota Wild, commence_time 2026-10-13T00:10:00Z) via
// GET /v4/sports/icehockey_nhl/events/{eventId}/odds
//   ?regions=us&markets=h2h_3_way&oddsFormat=american
// (x-requests-last: 1). All 7 bookmakers returned exactly three outcomes:
// `{ name: "<home team>", price }`, `{ name: "<away team>", price }`,
// `{ name: "Draw", price }` - full team names as in the h2h market, no
// `point`, no `description`. Trimmed capture saved at
// __fixtures__/odds-api-event-nhl-3way-response.json.
//
// Outcome shape confirmed live 2026-10-12 against a real event (Ottawa Senators
// @ New Jersey Devils, commence_time 2026-10-12T23:10:00Z) via
// GET /v4/sports/icehockey_nhl/events/{eventId}/odds
//   ?regions=us&markets=player_goal_scorer_anytime&oddsFormat=american
// (x-requests-last: 1, i.e. exactly 1 credit). All 7 bookmakers (draftkings,
// fanatics, fanduel, williamhill_us, betrivers, bovada, betmgm) returned 32-34
// outcomes shaped `{ name: "Yes", description: "<player>", price }` - the same
// shape as player_anytime_td (see nfl-prop-odds.ts's header): no "No" outcome,
// no `point`, and no team or "no scorer" entries. Trimmed capture saved at
// __fixtures__/odds-api-event-nhl-goal-scorer-response.json.
import { revalidateTag } from "next/cache";
import type { OddsGame } from "@/server/data/odds";
import { resolveOddsGame, type OddsLoader } from "@/server/data/odds";
import {
  fetchAndMergeEventPropOdds,
  type EventPropFetchTarget,
  type NflPropFetchSummary,
  type NflPropSeedStatus,
} from "@/server/data/nfl-prop-odds";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { cacheKeys } from "@/lib/cache-keys";
import { isLikelyDuplicateName } from "@/lib/fuzzy-match";

const NHL_SPORT_KEY = "icehockey_nhl";

export const NHL_ANYTIME_GOAL_MARKET_KEY = "player_goal_scorer_anytime";
export const NHL_THREE_WAY_MARKET_KEY = "h2h_3_way";
export const NHL_EVENT_MARKET_KEYS = [NHL_ANYTIME_GOAL_MARKET_KEY, NHL_THREE_WAY_MARKET_KEY] as const;

// The event-level markets no bookmaker on this game carries yet.
export function missingNhlEventMarkets(game: OddsGame): string[] {
  return NHL_EVENT_MARKET_KEYS.filter((key) => !game.bookmakers.some((b) => b.markets.some((m) => m.key === key)));
}

// The refresh-odds cron runs just after midnight ET, so 24 hours covers that
// day's whole slate (the latest West Coast start is about 22.5 hours out) and
// none of the next day's.
export const NHL_GOAL_SCORER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

const NHL_GOAL_SCORER_TARGET: EventPropFetchTarget = {
  sportKey: NHL_SPORT_KEY,
  // A preseason game is listed under "icehockey_nhl_preseason" and its event
  // URL needs that same key; OddsGame.sportKey is the key the listing came from.
  requestSportKey: (game) => (game.sportKey.startsWith(NHL_SPORT_KEY) ? game.sportKey : NHL_SPORT_KEY),
  marketKeys: missingNhlEventMarkets,
  logTag: "[nhl-goal-scorer-odds]",
  caller: "nhl-goal-scorer-odds",
};

// Anytime-goal price: player + "Yes", first bookmaker that has it wins, same
// fuzzy name match as resolveAnytimeTdOddsFromGame. A "No" outcome is never
// read - callers only ask for a pick on the Yes side.
export function resolveAnytimeGoalOddsFromGame(game: OddsGame, playerName: string): number | null {
  for (const bookmaker of game.bookmakers) {
    for (const market of bookmaker.markets) {
      if (market.key !== NHL_ANYTIME_GOAL_MARKET_KEY) continue;
      const match = market.outcomes.find(
        (o) => o.name === "Yes" && !!o.description && isLikelyDuplicateName(o.description, playerName)
      );
      if (match) return match.price;
    }
  }
  return null;
}

// Async wrapper, the NHL twin of resolvePropOdds: resolves the schedule-sourced
// game to its cached OddsGame, then delegates to the pure matcher above.
export async function resolveAnytimeGoalOdds(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  playerName: string,
  getOdds?: OddsLoader
): Promise<number | null> {
  const oddsGame = await resolveOddsGame(sportKey, game, getOdds);
  if (!oddsGame) return null;
  return resolveAnytimeGoalOddsFromGame(oddsGame, playerName);
}

// 3-way moneyline price for one outcome: the home team, the away team, or the
// draw. First bookmaker with a complete 3-way market (one that lists a "Draw")
// wins. Read from h2h_3_way ONLY - the 2-way h2h price includes overtime and
// the shootout and is never a substitute.
export function resolveThreeWayOddsFromGame(game: OddsGame, side: "HOME" | "AWAY" | "DRAW"): number | null {
  const outcomeName = side === "HOME" ? game.homeTeam : side === "AWAY" ? game.awayTeam : "Draw";
  for (const bookmaker of game.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === NHL_THREE_WAY_MARKET_KEY);
    if (!market || !market.outcomes.some((o) => o.name === "Draw")) continue;
    const outcome = market.outcomes.find((o) => o.name === outcomeName);
    if (outcome) return outcome.price;
  }
  return null;
}

export async function resolveThreeWayOdds(
  sportKey: string,
  game: { homeTeam: string; awayTeam: string; commenceTime: string },
  side: "HOME" | "AWAY" | "DRAW",
  getOdds?: OddsLoader
): Promise<number | null> {
  if (sportKey !== NHL_SPORT_KEY) return null;
  const oddsGame = await resolveOddsGame(sportKey, game, getOdds);
  if (!oddsGame) return null;
  return resolveThreeWayOddsFromGame(oddsGame, side);
}

// Which games to make a request for: played today (Eastern), not started,
// starting within the lookahead, and still missing at least one of the two
// markets (so a later run the same day spends nothing on a complete game). "Today" matters for the afternoon run:
// 24 hours from then reaches tomorrow's matinees, which tomorrow's own row
// would buy again.
export function nhlGamesNeedingGoalScorerOdds(games: OddsGame[], now: Date): OddsGame[] {
  const nowMs = now.getTime();
  const today = easternDateKey(now);
  return games.filter((g) => {
    const start = new Date(g.commenceTime);
    const startMs = start.getTime();
    if (!(startMs > nowMs) || startMs - nowMs > NHL_GOAL_SCORER_LOOKAHEAD_MS) return false;
    if (easternDateKey(start) !== today) return false;
    return missingNhlEventMarkets(g).length > 0;
  });
}

// "nothing_fetched": games qualified but no call succeeded (credit gate, or
// every request failed) - the row is left as it was.
export type NhlGoalScorerSeedStatus = NflPropSeedStatus | "nothing_fetched";

// Called by the refresh-odds cron right after the NFL prop step, and again by
// /api/cron/nhl-goal-scorer-odds in the afternoon. Reads today's NHL
// OddsSnapshot row (written by the bulk seed) and adds the goal-scorer market
// to the games that qualify.
export async function seedNhlGoalScorerOddsForToday(): Promise<NflPropFetchSummary & { status: NhlGoalScorerSeedStatus }> {
  const none = { games: [] as OddsGame[], eventsFetched: 0, eventsSkippedCreditGate: 0, eventsFailed: 0 };
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("[nhl-goal-scorer-odds] no ODDS_API_KEY configured");
    return { ...none, status: "no_api_key" };
  }

  const fetchDate = easternDateKey(new Date());
  const existing = await prisma.oddsSnapshot.findUnique({
    where: { sportKey_fetchDate: { sportKey: NHL_SPORT_KEY, fetchDate } },
  });
  if (!existing) return { ...none, status: "no_snapshot" };

  const games = existing.data as unknown as OddsGame[];
  const toFetch = nhlGamesNeedingGoalScorerOdds(games, new Date());
  if (toFetch.length === 0) return { ...none, games, status: "no_games_to_fetch" };

  const summary = await fetchAndMergeEventPropOdds(toFetch, apiKey, NHL_GOAL_SCORER_TARGET);
  if (summary.eventsFetched === 0) return { ...summary, games, status: "nothing_fetched" };

  const enrichedById = new Map(summary.games.map((g) => [g.id, g]));
  const merged = games.map((g) => enrichedById.get(g.id) ?? g);

  await prisma.oddsSnapshot.update({
    where: { sportKey_fetchDate: { sportKey: NHL_SPORT_KEY, fetchDate } },
    data: { data: merged as any },
  });

  // Same reason as seedNflPropOddsForToday: a read between the bulk seed and
  // this write would otherwise leave the pre-enrichment row cached.
  try {
    revalidateTag(cacheKeys.odds(NHL_SPORT_KEY, fetchDate));
  } catch (err) {
    console.error(
      "[seedNhlGoalScorerOddsForToday] revalidateTag failed - odds write succeeded, cache invalidation did not; TTL backstop will catch up",
      JSON.stringify({ sportKey: NHL_SPORT_KEY, error: err instanceof Error ? err.message : String(err) })
    );
  }

  console.log(
    "[nhl-goal-scorer-odds] seeded",
    JSON.stringify({
      fetchDate,
      eventsConsidered: toFetch.length,
      eventsFetched: summary.eventsFetched,
      eventsSkippedCreditGate: summary.eventsSkippedCreditGate,
      eventsFailed: summary.eventsFailed,
    })
  );

  return { ...summary, games: merged, status: "seeded" };
}
