import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { findTeamNickname } from "@/lib/parse-catalog";
import {
  computeStats,
  computeScorecard,
  computeCategoryBreakdown,
  MLB_CHIP_SET,
  type ScorecardBucket,
  type ScorecardBucketKey,
  type CategoryBreakdownItem,
  type PickCategoryKey,
} from "@/server/data/stats";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { findMatchingGameResult } from "@/server/data/grading";

const FREE_PLAN_PICK_LIMIT = 1000;

export async function getPickPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const pickCount = await prisma.pick.count({ where: { userId } });

  return {
    isPro,
    pickCount,
    pickLimit: isPro ? null : FREE_PLAN_PICK_LIMIT,
    atLimit: !isPro && pickCount >= FREE_PLAN_PICK_LIMIT,
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

  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  if (!isPro) {
    const pickCount = await prisma.pick.count({ where: { userId } });
    if (pickCount >= FREE_PLAN_PICK_LIMIT) {
      throw new Error(
        "Free plan is limited to " + FREE_PLAN_PICK_LIMIT + " picks. Upgrade to Pro for unlimited picks."
      );
    }
  }

  return prisma.pick.create({
    data: { ...data, userId, status: "PENDING" },
  });
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
        if (!match) unmatchedReason = "no matching game found";
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
// (manual entries, sports without game resolution yet).
function matchPicksToGame<T extends { homeTeam: string; awayTeam: string; betDetail: string | null }>(
  candidates: T[],
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): T[] {
  const exact = candidates.filter((p) => p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam);
  if (exact.length > 0) return exact;

  const homeNickname = findTeamNickname(game.homeTeam, sportName);
  const awayNickname = findTeamNickname(game.awayTeam, sportName);
  if (!homeNickname && !awayNickname) return [];

  return candidates.filter((p) => {
    const text = ((p.betDetail ?? "") + " " + p.homeTeam + " " + p.awayTeam).toLowerCase();
    return (homeNickname && text.includes(homeNickname)) || (awayNickname && text.includes(awayNickname));
  });
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
  const picks = await prisma.pick.findMany({ where: { userId, capperId } });
  // MLB_CHIP_SET, not a sport-scoped set - `category` here is whatever this
  // one pick's own category is (see pickCategory), which might be F5 ML or
  // NRFI regardless of what sport the caller happens to be looking at.
  const breakdown = computeCategoryBreakdown(picks, MLB_CHIP_SET);
  return breakdown.find((b) => b.key === category) ?? null;
}
