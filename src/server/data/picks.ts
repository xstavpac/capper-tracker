import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { findTeamNickname, teamPhraseRegex } from "@/lib/parse-catalog";
import {
  computeStats,
  computeScorecard,
  computeCategoryBreakdown,
  computeLeagueRecordCards,
  ALL_CATEGORY_KEYS,
  SEGMENT_CATEGORY_PERIODS,
  CATEGORY_RECENT_FORM_MIN_SAMPLE,
  CATEGORY_RECENT_FORM_WINDOW,
  type ScorecardBucket,
  type ScorecardBucketKey,
  type CategoryBreakdownItem,
  type LeagueRecordCard,
  type PickCategoryKey,
} from "@/server/data/stats";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { easternDateRange } from "@/lib/dates";
import { nrfiSide, betScope, periodLabel } from "@/lib/bet-line";
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

// Permanently removes one standalone Pick. Scoped by id + userId ONLY (never
// a name or text match - standing project rule after the production
// delete-by-text incident); the single deleteMany is atomic, so a pick that
// isn't this user's simply matches nothing. count === 0 means "not found or
// not yours" - same opaque message either way, so this never confirms
// another user's pick id exists.
export async function deletePick(userId: string, pickId: string): Promise<void> {
  const { count } = await prisma.pick.deleteMany({ where: { id: pickId, userId } });
  if (count === 0) {
    throw new Error("Pick not found.");
  }
}

export type PendingPickRow = {
  id: string;
  capperName: string;
  homeTeam: string;
  awayTeam: string;
  betType: BetType;
  betDetail: string | null;
  line: number | null;
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
          // Game matched fine but resolveOutcome couldn't produce WIN/LOSS/
          // PUSH. Spell out which of the three reasons it is so this doesn't
          // always read as the generic "no number" case.
          const scope = p.betType === "NRFI" ? "FULL_GAME" : betScope(p.betDetail);
          if (scope === "UNSUPPORTED_SEGMENT") {
            unmatchedReason =
              "matched game, but this bet is scoped to a game segment the grader can't resolve (e.g. a single inning outside MLB) - needs manual grading";
          } else if (scope !== "FULL_GAME" && scope !== p.period) {
            unmatchedReason =
              "matched game, but this " + periodLabel(scope) + " pick predates segment grading - needs manual grading or re-import";
          } else if (scope !== "FULL_GAME") {
            unmatchedReason = "matched game, but the " + periodLabel(scope) + " score isn't posted for this game yet";
          } else {
            unmatchedReason = "matched game, but couldn't parse a gradable number from the bet text";
          }
        }
      }

      return {
        id: p.id,
        capperName: p.capper.name,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        betType: p.betType,
        betDetail: p.betDetail,
        line: p.line,
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
  // Eastern-calendar-day keys ("YYYY-MM-DD"), both inclusive - a single day
  // is startDateKey === endDateKey. Required in practice (the Picks page
  // always resolves a default of "today" before calling this), but optional
  // here so every other caller of this file's PickFilters-shaped filtering
  // isn't forced to thread a date range through for no reason.
  startDateKey?: string;
  endDateKey?: string;
};

// betType/period aren't filtered here anymore - the Picks page's unified bet
// type filter (Spread/F5 Spread/Moneyline/.../NRFI/YRFI) needs betDetail text
// (for the NRFI/YRFI split) that a plain Prisma where-clause can't express, so
// it's applied in-memory after this fetch, the same way favorite/underdog
// filtering already is.
//
// The date range, unlike those two, IS applied here at the query level (on
// `gameTime`, real DB WHERE clause via easternDateRange) rather than fetched-
// then-filtered - this is the actual fix for the Picks page loading its
// entire pick history (2,000+ rows and growing with every sport added) on
// every page load. Every other caller of PickFilters that doesn't pass a
// date range is unaffected (no date clause is added at all), same as before.
export async function getFilteredPicksForUser(userId: string, filters: PickFilters) {
  const dateRange =
    filters.startDateKey && filters.endDateKey
      ? easternDateRange(filters.startDateKey, filters.endDateKey)
      : undefined;

  return prisma.pick.findMany({
    where: {
      userId,
      ...(filters.capperId ? { capperId: filters.capperId } : {}),
      ...(filters.sportId ? { sportId: filters.sportId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(dateRange ? { gameTime: { gte: dateRange.start, lt: dateRange.end } } : {}),
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
export function matchPicksToGame<
  T extends { homeTeam: string; awayTeam: string; betDetail: string | null; gameTime: Date },
>(
  candidates: T[],
  game: { homeTeam: string; awayTeam: string; commenceTime: Date },
  sportName: string
): T[] {
  const withinDrift = (picks: T[]) =>
    picks.filter((p) => Math.abs(p.gameTime.getTime() - game.commenceTime.getTime()) <= MAX_GAME_TIME_DRIFT_MS);

  const exact = withinDrift(candidates.filter((p) => p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam));
  if (exact.length > 0) return exact;

  // Fuzzy fallback for picks whose homeTeam/awayTeam is raw text, or is
  // spelled by a different feed than this board's game (picks resolve against
  // the ESPN score feed, the board is Odds-API-spelled - the two disagree for
  // some teams). Mirrors grading's matchGameResult: BOTH teams' nicknames
  // must appear, not just one. Matching on a single side let a pick latch
  // onto an unrelated game that merely shares one team's name - a Colorado /
  // Georgia Tech pick showed up under "West Georgia @ Kennesaw State" (both
  // contain "georgia") and under "Albany @ Buffalo Bulls" ("buffalo" is a
  // substring of "Buffaloes"). teamPhraseRegex, not includes(), so "buffalo"
  // no longer matches inside "buffaloes". If either side's nickname can't be
  // resolved, the matchup can't be confirmed - skip the fuzzy branch (the
  // exact branch above still applies).
  const homeNickname = findTeamNickname(game.homeTeam, sportName);
  const awayNickname = findTeamNickname(game.awayTeam, sportName);
  if (!homeNickname || !awayNickname) return [];
  const homeRe = teamPhraseRegex(homeNickname);
  const awayRe = teamPhraseRegex(awayNickname);

  return withinDrift(
    candidates.filter((p) => {
      const text = ((p.betDetail ?? "") + " " + p.homeTeam + " " + p.awayTeam).toLowerCase();
      return homeRe.test(text) && awayRe.test(text);
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
  // betDetail is required whenever betType is NRFI - an NRFI-betType pick's
  // bucket depends on which side (NRFI vs YRFI) it's on, the same
  // betDetail-derived split computeScorecard's own bucketKeyForPick uses, so
  // this lookup can't just cast betType straight to a ScorecardBucketKey the
  // way every other bet type still can.
  filter?: { betType: BetType; period: Period; betDetail: string | null }
): Promise<ScorecardBucket[]> {
  const picks = await prisma.pick.findMany({ where: { userId, capperId } });
  const buckets = computeScorecard(picks);
  if (!filter) return buckets;

  // Mirror bucketKeyForPick's precedence exactly: TEAM_TOTAL is
  // period-independent and wins over the FIRST_HALF / SEGMENT checks.
  const key: ScorecardBucketKey =
    filter.betType === "TEAM_TOTAL"
      ? "TEAM_TOTAL"
      : filter.period === "FIRST_HALF"
        ? "F5"
        : (SEGMENT_CATEGORY_PERIODS as readonly string[]).includes(filter.period)
          ? "SEGMENT"
          : filter.betType === "NRFI"
            ? nrfiSide(filter.betDetail) === "YES_RUN"
              ? "YRFI"
              : "NRFI"
            : (filter.betType as ScorecardBucketKey);
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
  const records = await getCapperCategoryRecords(userId, [{ capperId, category }]);
  return records[categoryRecordKey(capperId, category)] ?? null;
}

export function categoryRecordKey(capperId: string, category: PickCategoryKey): string {
  return capperId + "|" + category;
}

// Batched form of getCapperCategoryRecord for callers that need many
// (capper, category) records at once - the Sharp Money board and the /live
// game-card expander. Instead of one "load this capper's whole history"
// query per pair (the same capper's picks reloaded once per category, and a
// full round-trip per pair), this issues ONE query for every capper
// involved and runs computeCategoryBreakdown ONCE per capper (it already
// computes every category in a single pass). N queries + N breakdowns
// collapse to 1 query + (distinct capper count) breakdowns.
//
// ALL_CATEGORY_KEYS, not a sport-scoped set - each pair's `category` is
// whatever that pick's own category is (F5 ML, 1st Half ML, NRFI...),
// independent of any sport the caller is looking at. Safe to query every
// sport's picks together since pickCategory splits F5_ML (MLB) from
// FIRST_HALF_ML.
// Shared by getCapperCategoryRecords and getCapperLeagueRecords: ONE query
// for every capper involved, grouped by capperId. Each capper's full pick
// history (with sport.name, the only relation the breakdowns group by).
async function fetchPicksByCapper(userId: string, capperIds: string[]) {
  const picks = await prisma.pick.findMany({
    where: { userId, capperId: { in: capperIds } },
    include: { sport: { select: { name: true } } },
  });
  const byCapper = new Map<string, typeof picks>();
  for (const pick of picks) {
    const list = byCapper.get(pick.capperId);
    if (list) list.push(pick);
    else byCapper.set(pick.capperId, [pick]);
  }
  return byCapper;
}

export async function getCapperCategoryRecords(
  userId: string,
  pairs: { capperId: string; category: PickCategoryKey }[]
): Promise<Record<string, CategoryBreakdownItem | null>> {
  const capperIds = Array.from(new Set(pairs.map((p) => p.capperId)));
  if (capperIds.length === 0) return {};

  const byCapper = await fetchPicksByCapper(userId, capperIds);

  // One breakdown per capper (every category in one pass), indexed for O(1)
  // lookup. recentForm attaches item.recent (last-20 record by gameTime) for
  // any category with >= 100 decided picks - the /live game-card expander is
  // the one surface that renders it (see game-picks-expander.tsx).
  const breakdownByCapper = new Map<string, Map<PickCategoryKey, CategoryBreakdownItem>>();
  for (const capperId of capperIds) {
    const items = computeCategoryBreakdown(byCapper.get(capperId) ?? [], ALL_CATEGORY_KEYS, {
      window: CATEGORY_RECENT_FORM_WINDOW,
      minSample: CATEGORY_RECENT_FORM_MIN_SAMPLE,
    });
    breakdownByCapper.set(capperId, new Map(items.map((i) => [i.key, i])));
  }

  const out: Record<string, CategoryBreakdownItem | null> = {};
  for (const { capperId, category } of pairs) {
    out[categoryRecordKey(capperId, category)] = breakdownByCapper.get(capperId)?.get(category) ?? null;
  }
  return out;
}

export function leagueRecordKey(capperId: string, leagueSport: string, category: PickCategoryKey): string {
  return capperId + "|" + leagueSport + "|" + category;
}

// The three-way (Overall / league / Last 20) form of getCapperCategoryRecords,
// for the condensed game-card record line. Same one-query-per-batch,
// one-computation-per-capper shape; reuses computeLeagueRecordCards (see
// stats.ts) - no new aggregation. `leagueSport` is the game's sport (the
// /live page has one per tab). Returns null for a (capper, category) the
// capper has never had a pick in.
export async function getCapperLeagueRecords(
  userId: string,
  pairs: { capperId: string; leagueSport: string; category: PickCategoryKey }[]
): Promise<Record<string, LeagueRecordCard | null>> {
  const capperIds = Array.from(new Set(pairs.map((p) => p.capperId)));
  if (capperIds.length === 0) return {};

  const byCapper = await fetchPicksByCapper(userId, capperIds);

  // One computeLeagueRecordCards pass per (capper, leagueSport) - it already
  // produces every category's card in that pass. ALL_CATEGORY_KEYS so a
  // segment-scoped pick on the board still resolves to its own segment
  // category (PR #22); a full-game category's card still excludes segment
  // picks, since they classify under a different key.
  const cardsByCapperLeague = new Map<string, Map<PickCategoryKey, LeagueRecordCard>>();
  const seen = new Set<string>();
  for (const { capperId, leagueSport } of pairs) {
    const k = capperId + "|" + leagueSport;
    if (seen.has(k)) continue;
    seen.add(k);
    const cards = computeLeagueRecordCards(byCapper.get(capperId) ?? [], leagueSport, ALL_CATEGORY_KEYS);
    cardsByCapperLeague.set(k, new Map(cards.map((c) => [c.category, c])));
  }

  const out: Record<string, LeagueRecordCard | null> = {};
  for (const { capperId, leagueSport, category } of pairs) {
    out[leagueRecordKey(capperId, leagueSport, category)] =
      cardsByCapperLeague.get(capperId + "|" + leagueSport)?.get(category) ?? null;
  }
  return out;
}
