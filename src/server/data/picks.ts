import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { findTeamNickname } from "@/lib/parse-catalog";
import {
  computeStats,
  computeScorecard,
  computeCategoryBreakdown,
  ALL_CATEGORY_KEYS,
  type ScorecardBucket,
  type ScorecardBucketKey,
  type CategoryBreakdownItem,
  type PickCategoryKey,
} from "@/server/data/stats";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { findMatchingGameResult, resolveOutcome, resolveTouchdownProp, MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { FREE_PICK_LIMIT } from "@/lib/entitlements";
import { getEntitlementsForUser, createPicksWithEntitlementCheck } from "@/server/data/subscriptions";

// Kept for compatibility with the one existing call site's naming
// (picks/page.tsx expects pickCount/pickLimit/atLimit) - `unlimited` covers
// both BASIC and PRO, not just PRO, now that BASIC exists.
export async function getPickPlanStatus(userId: string) {
  const entitlements = await getEntitlementsForUser(userId);
  const unlimited = entitlements.tier !== "FREE";
  const pickCount = await prisma.pick.count({ where: { userId } });

  return {
    tier: entitlements.tier,
    unlimited,
    pickCount,
    pickLimit: unlimited ? null : FREE_PICK_LIMIT,
    atLimit: !unlimited && pickCount >= FREE_PICK_LIMIT,
  };
}

export async function getSportsWithLeagues() {
  return prisma.sport.findMany({
    include: { leagues: true },
    orderBy: { name: "asc" },
  });
}

export async function createPick(
  userId: string,
  data: {
    capperId: string;
    sportId: string;
    leagueId?: string;
    homeTeam: string;
    awayTeam: string;
    betType: BetType;
    betDetail?: string;
    odds: number;
    line?: number | null;
    period?: Period;
    sportsbook?: string;
    units: number;
    gameTime: Date;
    notes?: string;
  }
) {
  const capper = await prisma.capper.findFirst({
    where: { id: data.capperId, userId },
  });
  if (!capper) {
    throw new Error("Capper not found.");
  }

  // The actual authorization gate - locks this user's Subscription row and
  // checks the Free-plan limit atomically with the insert itself, so two
  // concurrent creates for the same user can't both slip past the check
  // (see createPicksWithEntitlementCheck for why a plain count-then-create
  // isn't safe here). Single-pick creation is just the N=1 case of the same
  // batch path bulk import uses.
  const result = await createPicksWithEntitlementCheck(userId, [data]);
  if (!result.allowed) {
    throw new Error(result.message);
  }
  return result.created[0];
}

export async function updatePickStatus(userId: string, pickId: string, status: PickStatus) {
  const pick = await prisma.pick.findFirst({ where: { id: pickId, userId } });
  if (!pick) {
    throw new Error("Pick not found.");
  }

  const wasPending = pick.status === "PENDING";

  return prisma.pick.update({
    where: { id: pickId },
    data: { status, ...(wasPending && status !== "PENDING" ? { gradedAt: new Date() } : {}) },
  });
}

export type PendingPickRow = {
  id: string;
  capperName: string;
  homeTeam: string;
  awayTeam: string;
  betType: BetType;
  betDetail: string | null;
  odds: number;
  units: number;
  gameTime: Date;
  ageHours: number; // now - gameTime; can be negative for a game that hasn't started yet
  unmatchedReason: string | null;
};

// A game with no free score source wired up (see RESOLVABLE_SPORT_KEYS) will
// never auto-grade at all - flag that immediately, it's not worth waiting on.
// For resolvable sports, only flag "no matching game found" once the game
// itself is well past over (6h past its start time) - before that, a null
// match just means the game hasn't finished and posted a final yet, which is
// normal, not a problem.
const UNMATCHED_CHECK_DELAY_HOURS = 6;

export async function getPendingPicksForUser(userId: string): Promise<PendingPickRow[]> {
  const picks = await prisma.pick.findMany({
    where: { userId, status: "PENDING" },
    include: { capper: true, sport: true },
    orderBy: { gameTime: "asc" },
  });

  const now = Date.now();

  return Promise.all(
    picks.map(async (p) => {
      const ageHours = (now - p.gameTime.getTime()) / 3600000;
      const sportKey = LIVE_SPORTS.find((s) => s.label === p.sport.name)?.key;
      const resolvable = sportKey ? RESOLVABLE_SPORT_KEYS.includes(sportKey) : false;

      let unmatchedReason: string | null = null;
      if (!resolvable) {
        unmatchedReason = "sport not tracked";
      } else if (ageHours > UNMATCHED_CHECK_DELAY_HOURS) {
        const match = await findMatchingGameResult(sportKey!, p);
        if (!match) {
          unmatchedReason = "no matching game found";
        } else if (p.betType === "PLAYER_PROP") {
          // Touchdown props resolve differently (player-level box-score data,
          // not resolveOutcome/gradePick's team-score path) - reuses the same
          // resolveTouchdownProp the real grader calls, so this reason always
          // reflects the actual reason grading is stuck, not a generic guess.
          const propResult = await resolveTouchdownProp(p, match.game.externalId, p.sport.name);
          if (propResult.outcome === null) {
            unmatchedReason = "matched game, but " + propResult.reason;
          }
        } else if (!resolveOutcome(p, match.game)) {
          // Game matched fine - the score data is there, but gradePick still
          // couldn't produce WIN/LOSS/PUSH from this pick's own fields (most
          // often a TOTAL/SPREAD pick with no parseable number anywhere in its
          // betDetail). Without this, a pick like this stays PENDING forever
          // with no visible reason at all, since findMatchingGameResult alone
          // has nothing to complain about.
          unmatchedReason = "matched game, but couldn't parse a gradable number from the bet text";
        }
      }

      return {
        id: p.id,
        capperName: p.capper.name,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        betType: p.betType,
        betDetail: p.betDetail,
        odds: p.odds,
        units: p.units,
        gameTime: p.gameTime,
        ageHours,
        unmatchedReason,
      };
    })
  );
}

export async function getPicksForCapper(userId: string, capperId: string) {
  return prisma.pick.findMany({
    where: { userId, capperId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "asc" },
  });
}

export type PickFilters = {
  capperId?: string;
  sportId?: string;
  status?: PickStatus;
  betType?: BetType;
  period?: Period;
};

export async function getFilteredPicksForUser(userId: string, filters: PickFilters) {
  return prisma.pick.findMany({
    where: {
      userId,
      ...(filters.capperId ? { capperId: filters.capperId } : {}),
      ...(filters.sportId ? { sportId: filters.sportId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.betType ? { betType: filters.betType } : {}),
      ...(filters.period ? { period: filters.period } : {}),
    },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

export async function getPicksForUser(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

// Shared by getPicksForGame and getPicksForGames - tries an exact home/away
// team-name match first (reliable for picks resolved to a real schedule game
// - see resolveGameForNickname), then falls back to a nickname text search
// against betDetail/homeTeam/awayTeam for picks with free-text team data
// (manual entries, sports without game resolution yet). Both branches are
// narrowed to MAX_GAME_TIME_DRIFT_MS of the game's own commenceTime - the
// same matchup can recur within the ±2-day candidate window a caller queries
// (an MLB series plays the same two teams several days running), so team
// name alone isn't enough to tell "this specific game" from "the same
// matchup two days ago." Same reasoning as findMatchingGameResult's
// withinDrift, just picks-to-a-game instead of a-pick-to-its-game-result.
function matchPicksToGame<T extends { homeTeam: string; awayTeam: string; betDetail: string | null; gameTime: Date }>(
  candidates: T[],
  game: { homeTeam: string; awayTeam: string; commenceTime: Date },
  sportName: string
): T[] {
  const withinDrift = (picks: T[]) =>
    picks.filter((p) => Math.abs(p.gameTime.getTime() - game.commenceTime.getTime()) <= MAX_GAME_TIME_DRIFT_MS);

  const exact = withinDrift(candidates.filter((p) => p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam));
  if (exact.length > 0) return exact;

  const homeNickname = findTeamNickname(game.homeTeam, sportName);
  const awayNickname = findTeamNickname(game.awayTeam, sportName);
  if (!homeNickname && !awayNickname) return [];

  return withinDrift(
    candidates.filter((p) => {
      const text = ((p.betDetail ?? "") + " " + p.homeTeam + " " + p.awayTeam).toLowerCase();
      return (homeNickname && text.includes(homeNickname)) || (awayNickname && text.includes(awayNickname));
    })
  );
}

// Finds this user's logged picks for one specific game.
export async function getPicksForGame(
  userId: string,
  params: { sportName: string; homeTeam: string; awayTeam: string; commenceTime: Date }
) {
  const sport = await prisma.sport.findFirst({
    where: { name: { equals: params.sportName, mode: "insensitive" } },
  });
  if (!sport) return [];

  const windowStart = new Date(params.commenceTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(params.commenceTime.getTime() + 2 * 86400000);

  const candidates = await prisma.pick.findMany({
    where: { userId, sportId: sport.id, gameTime: { gte: windowStart, lt: windowEnd } },
    include: { capper: true },
  });
  if (candidates.length === 0) return [];

  return matchPicksToGame(candidates, params, params.sportName);
}

// Same matching as getPicksForGame, batched across every game on a page in a
// single query instead of one round-trip per game. A list page like /live
// can show a dozen-plus games at once - calling getPicksForGame per game (as
// this used to) fires that many separate sport-lookup + pick queries
// concurrently, which is enough to exhaust the DB connection pool on its
// own. Returns picks in the same order as `games`.
export async function getPicksForGames(
  userId: string,
  sportName: string,
  games: { homeTeam: string; awayTeam: string; commenceTime: Date }[]
) {
  if (games.length === 0) return [];

  const sport = await prisma.sport.findFirst({
    where: { name: { equals: sportName, mode: "insensitive" } },
  });
  if (!sport) return games.map(() => []);

  const times = games.map((g) => g.commenceTime.getTime());
  const windowStart = new Date(Math.min(...times) - 2 * 86400000);
  const windowEnd = new Date(Math.max(...times) + 2 * 86400000);

  const allPicks = await prisma.pick.findMany({
    where: { userId, sportId: sport.id, gameTime: { gte: windowStart, lt: windowEnd } },
    include: { capper: true },
  });
  if (allPicks.length === 0) return games.map(() => []);

  return games.map((game) => {
    const gameWindowStart = new Date(game.commenceTime.getTime() - 2 * 86400000);
    const gameWindowEnd = new Date(game.commenceTime.getTime() + 2 * 86400000);
    const candidates = allPicks.filter((p) => p.gameTime >= gameWindowStart && p.gameTime < gameWindowEnd);
    return matchPicksToGame(candidates, game, sportName);
  });
}

// A capper's record broken down by bet category (see computeScorecard), or
// narrowed to a single category when `filter` is given - e.g. "8-3 on
// Moneyline picks" for context on how much weight to give their pick on a
// specific game, independent of their overall record across every category.
export async function getCapperScorecard(
  userId: string,
  capperId: string,
  filter?: { betType: BetType; period: Period }
): Promise<ScorecardBucket[]> {
  const picks = await prisma.pick.findMany({ where: { userId, capperId } });
  const buckets = computeScorecard(picks);
  if (!filter) return buckets;

  const key: ScorecardBucketKey = filter.period === "FIRST_HALF" ? "F5" : (filter.betType as ScorecardBucketKey);
  return buckets.filter((b) => b.key === key);
}

// A capper's all-time record within one specific pickCategory (favorite/
// underdog moneyline, favorite/underdog spread, over/under, etc - the same
// finer-grained split the Dashboard's "Record by category" breakdown and the
// Cappers-page filter chips already use). Narrower than getCapperScorecard,
// which only splits by raw bet type - "8-2 on underdog moneyline picks" needs
// to know which SIDE of the moneyline they were on, not just that it was a
// moneyline pick. Returns null if this capper has no picks in that category.
export async function getCapperCategoryRecord(
  userId: string,
  capperId: string,
  category: PickCategoryKey
): Promise<CategoryBreakdownItem | null> {
  const picks = await prisma.pick.findMany({ where: { userId, capperId }, include: { sport: true } });
  // ALL_CATEGORY_KEYS, not a sport-scoped set - `category` here is whatever
  // this one pick's own category is (see pickCategory), which might be F5
  // ML, 1st Half ML, or NRFI regardless of what sport the caller happens to
  // be looking at. Querying every sport's picks together is safe now that
  // pickCategory itself splits F5_ML (MLB) from FIRST_HALF_ML (everything
  // else) - a capper who bets both no longer gets those two blended.
  const breakdown = computeCategoryBreakdown(picks, ALL_CATEGORY_KEYS);
  return breakdown.find((b) => b.key === category) ?? null;
}
