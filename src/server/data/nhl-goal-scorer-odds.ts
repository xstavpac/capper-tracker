// NHL anytime-goal-scorer odds: the one NHL player-prop market the Odds API is
// asked for. Same event-level endpoint and the same fetch/merge/usage-log loop
// as the NFL props (fetchAndMergeEventPropOdds in nfl-prop-odds.ts), with two
// differences that keep it cheap:
//   - one market per call (player_goal_scorer_anytime), so a call costs at
//     most 1 credit (cost = markets returned x regions);
//   - only today's games starting within NHL_GOAL_SCORER_LOOKAHEAD_MS that
//     don't already carry the market are requested, so a game is bought once,
//     on the day it is played, not on every day it sits on the upcoming slate.
//
// Two runs a day call seedNhlGoalScorerOddsForToday: the refresh-odds cron just
// after midnight ET, and /api/cron/nhl-goal-scorer-odds at 16:30 UTC for games
// whose market wasn't posted yet at midnight. A call that returns no market
// costs nothing, and a game that already has it is never asked for again.
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

// The refresh-odds cron runs just after midnight ET, so 24 hours covers that
// day's whole slate (the latest West Coast start is about 22.5 hours out) and
// none of the next day's.
export const NHL_GOAL_SCORER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

const NHL_GOAL_SCORER_TARGET: EventPropFetchTarget = {
  sportKey: NHL_SPORT_KEY,
  // A preseason game is listed under "icehockey_nhl_preseason" and its event
  // URL needs that same key; OddsGame.sportKey is the key the listing came from.
  requestSportKey: (game) => (game.sportKey.startsWith(NHL_SPORT_KEY) ? game.sportKey : NHL_SPORT_KEY),
  marketKeys: [NHL_ANYTIME_GOAL_MARKET_KEY],
  logTag: "[nhl-goal-scorer-odds]",
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

// Which games to buy the market for: played today (Eastern), not started,
// starting within the lookahead, and not already carrying it (so a later run
// the same day spends nothing on them). "Today" matters for the afternoon run:
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
    return !g.bookmakers.some((b) => b.markets.some((m) => m.key === NHL_ANYTIME_GOAL_MARKET_KEY));
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
