import { prisma } from "@/lib/prisma";
import type { BetType, PickStatus, Period } from "@prisma/client";
import { findTeamNickname, teamPhraseRegex } from "@/lib/parse-catalog";
import {
  winPctOf,
  ALL_CATEGORY_KEYS,
  LEAGUE_RECORD_LAST_N,
  PICK_CATEGORY_LABELS,
  type CategoryBreakdownItem,
  type LeagueRecordCard,
  type LeagueRecordColumn,
  type PickCategoryKey,
} from "@/server/data/stats";
import { queryCapperRecordBundle, type CardRequest, type CategoryRequest } from "@/server/data/picks-by-capper-aggregates";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import type { GameCardStreak } from "@/lib/game-card-record-line";
import { easternDateRange } from "@/lib/dates";
import { nrfiSide, betScope, periodLabel } from "@/lib/bet-line";
import { findMatchingGameResult, resolveOutcome, resolvePlayerProp, MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
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
          // Player props resolve differently (player-level box-score data,
          // not resolveOutcome/gradePick's team-score path) - reuses the same
          // resolvePlayerProp dispatcher the real grader calls (which routes
          // to resolveTouchdownProp for TD props and resolveYardageOrReceptionsProp
          // for the 4 structured markets), so this reason always reflects the
          // actual reason grading is stuck for THIS pick's market, not a
          // stale TD-specific guess.
          const propResult = await resolvePlayerProp(p, match.game.externalId, p.sport.name);
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

// A capper's all-time record within one specific pickCategory (favorite/
// underdog moneyline, favorite/underdog spread, over/under, etc - the same
// finer-grained split the Dashboard's "Record by category" breakdown and the
// Cappers-page filter chips already use). Splits by SIDE (which way the
// capper's pick actually leaned), not just raw bet type - "8-2 on underdog
// moneyline picks" needs to know which side of the moneyline they were on.
// Returns null if this capper has no picks in that category.
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

export function leagueRecordKey(capperId: string, leagueSport: string, category: PickCategoryKey): string {
  return capperId + "|" + leagueSport + "|" + category;
}

export type CapperLeagueRecords = {
  // keyed by leagueRecordKey(capperId, leagueSport, category)
  records: Record<string, LeagueRecordCard | null>;
  // keyed by capperId - the capper's CURRENT OVERALL streak (every sport,
  // every bet type), the exact same currentStreak() value (via computeStats)
  // that powers the Leaderboard / Favorites flame badge. One entry per capper
  // in the request; { type: "NONE", count: 0 } when they have no decided pick.
  streaks: Record<string, GameCardStreak>;
  // keyed by capperId - the capper's record over their most recent
  // LEAGUE_RECORD_LAST_N graded picks across EVERY category and league,
  // segment (Q1-Q4 / half / period) picks included - the same full per-capper
  // history the streak above is derived from, NOT scoped to any card's
  // category or league. null when the capper has fewer than
  // LEAGUE_RECORD_LAST_N graded picks total; the /live card then omits the
  // "Last 20 Picks" row rather than showing a partial count.
  last20: Record<string, LeagueRecordColumn | null>;
};

function toLeagueRecordColumn(wins: number, losses: number, pushes: number): LeagueRecordColumn {
  return { wins, losses, pushes, winPct: winPctOf(wins, losses), count: wins + losses + pushes };
}

export type CapperRecordBundleRequest = {
  // Every pick on a card (or set of cards) - see getCapperLeagueRecords. A
  // null-category entry still puts its capper in the streak/last20 maps but
  // requests no card.
  leagueEntries: { capperId: string; leagueSport: string; category: PickCategoryKey | null }[];
  // Every (capper, category) pair getCapperCategoryRecords needs a record for.
  categoryPairs: { capperId: string; category: PickCategoryKey }[];
};

export type CapperRecordBundle = {
  leagueRecords: CapperLeagueRecords;
  categoryRecords: Record<string, CategoryBreakdownItem | null>;
};

const EMPTY_BUNDLE: CapperRecordBundle = { leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords: {} };

// The one query behind getCapperLeagueRecords / getCapperCategoryRecords (see
// docs/design/picks-by-capper-egress.md) - a single database round trip (via
// queryCapperRecordBundle) scans every requested capper's decided picks ONCE
// and returns only the small aggregated result, instead of fetching each
// capper's entire pick history into the app to summarize in JS (the old
// fetchPicksByCapper path, kept only as picks-by-capper-legacy.ts's parity
// reference). Both card requests and category-pair requests can be sent in
// one call (parlay-pool-generator's Hedge/Contrarian build does exactly this,
// collapsing 2 of its 3 sequential calls into 1 - design doc §6); a caller
// that only needs one shape passes [] for the other.
//
// winPct / label / the "count > 0 -> card, else null" collapse are applied
// here in JS with the SAME shared functions the old path used (winPctOf,
// PICK_CATEGORY_LABELS), so there is one implementation of each rule - the
// SQL layer (picks-by-capper-aggregates.ts) returns only raw win/loss/push
// totals.
export async function getCapperRecordBundle(userId: string, req: CapperRecordBundleRequest): Promise<CapperRecordBundle> {
  // streaks/last20 are keyed by leagueEntries' cappers only (matching the old
  // getCapperLeagueRecords, which never saw categoryPairs-only cappers) - a
  // categoryPairs-only capper still gets scanned (it's in the SQL `ids` set
  // below) but never appears in the exposed streaks/last20 maps.
  const leagueCapperIds = Array.from(new Set(req.leagueEntries.map((e) => e.capperId)));
  const capperIds = Array.from(new Set([...leagueCapperIds, ...req.categoryPairs.map((p) => p.capperId)]));
  if (capperIds.length === 0) return EMPTY_BUNDLE;

  // Output keys: every non-null-category leagueEntries triple / every
  // categoryPairs pair, deduped - matching the old wrapper, which always set
  // records[key] / categoryRecords[key] (falling back to null) for every
  // entry it was given, INCLUDING a category outside ALL_CATEGORY_KEYS (the
  // old computeLeagueRecordCards/computeCategoryBreakdown simply never
  // produced a card for it, so the final `?? null` fallback still ran - it
  // did not drop the key). A null-category leagueEntries item gets no output
  // key at all, same as before (it only contributes its capperId to the
  // streak/last20 maps).
  const cardOutputKeys = new Map<string, { capperId: string; leagueSport: string; category: PickCategoryKey }>();
  for (const e of req.leagueEntries) {
    if (e.category === null) continue;
    cardOutputKeys.set(leagueRecordKey(e.capperId, e.leagueSport, e.category), {
      capperId: e.capperId,
      leagueSport: e.leagueSport,
      category: e.category,
    });
  }
  const catOutputKeys = new Map<string, { capperId: string; category: PickCategoryKey }>();
  for (const p of req.categoryPairs) {
    catOutputKeys.set(categoryRecordKey(p.capperId, p.category), { capperId: p.capperId, category: p.category });
  }

  // SQL request: the same triples/pairs, restricted to real categories
  // (ALL_CATEGORY_KEYS) - an unrecognized category can never have a card
  // (nothing is ever stamped with it), so it's resolved to null in JS below
  // without a wasted SQL round trip, exactly like the old `order` filter did.
  const allCategoryKeySet = new Set<string>(ALL_CATEGORY_KEYS);
  const cardReq: CardRequest[] = Array.from(cardOutputKeys.values())
    .filter((c) => allCategoryKeySet.has(c.category))
    .map((c) => ({ capperId: c.capperId, leagueSport: c.leagueSport, category: c.category }));
  const catReq: CategoryRequest[] = Array.from(catOutputKeys.values())
    .filter((c) => allCategoryKeySet.has(c.category))
    .map((c) => ({ capperId: c.capperId, category: c.category }));

  const sql = await queryCapperRecordBundle({
    userId,
    capperIds,
    cardReq,
    catReq,
    last20Window: LEAGUE_RECORD_LAST_N,
  });

  // Cards -> LeagueRecordCard | null, keyed leagueRecordKey (matches the
  // caller-facing `records` map). A card exists iff the overall count > 0
  // (design doc §4.2); the SQL LEFT JOIN always returns a zero row for a
  // requested triple with no decided picks, so a missing row here only ever
  // means "category outside ALL_CATEGORY_KEYS, never sent to SQL".
  const cardRowByKey = new Map(sql.cards.map((c) => [leagueRecordKey(c.cid, c.sport, c.cat as PickCategoryKey), c]));
  const records: Record<string, LeagueRecordCard | null> = {};
  for (const [key, { category }] of cardOutputKeys) {
    const row = cardRowByKey.get(key);
    const overall = toLeagueRecordColumn(row?.oWins ?? 0, row?.oLosses ?? 0, row?.oPushes ?? 0);
    records[key] =
      overall.count > 0
        ? { category, label: PICK_CATEGORY_LABELS[category], overall, league: toLeagueRecordColumn(row?.lWins ?? 0, row?.lLosses ?? 0, row?.lPushes ?? 0) }
        : null;
  }

  // Category records -> CategoryBreakdownItem | null, keyed categoryRecordKey.
  // item.recent is NOT populated (design doc Q3 - removed; nothing reads it,
  // confirmed by a full grep of src/ for a production reader before this
  // change shipped). `recent` stays undefined, matching CategoryBreakdownItem's
  // own type (optional, present only when a caller asks computeCategoryBreakdown
  // for it - this bundle never does).
  const catRowByKey = new Map(sql.catrec.map((c) => [categoryRecordKey(c.cid, c.cat as PickCategoryKey), c]));
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  for (const [key, { category }] of catOutputKeys) {
    const row = catRowByKey.get(key);
    const wins = row?.wins ?? 0;
    const losses = row?.losses ?? 0;
    const pushes = row?.pushes ?? 0;
    const count = wins + losses + pushes;
    categoryRecords[key] =
      count > 0
        ? { key: category, label: PICK_CATEGORY_LABELS[category], wins, losses, pushes, winPct: winPctOf(wins, losses), count }
        : null;
  }

  // Streaks / last20, restricted to leagueEntries' cappers (see the comment
  // above capperIds).
  const streakRowByCid = new Map(sql.streaks.map((s) => [s.cid, s]));
  const last20RowByCid = new Map(sql.last20.map((l) => [l.cid, l]));
  const streaks: Record<string, GameCardStreak> = {};
  const last20: Record<string, LeagueRecordColumn | null> = {};
  for (const capperId of leagueCapperIds) {
    const s = streakRowByCid.get(capperId);
    streaks[capperId] = s ? { type: s.type, count: s.count } : { type: "NONE", count: 0 };

    const l = last20RowByCid.get(capperId);
    last20[capperId] = l && l.decided >= LEAGUE_RECORD_LAST_N ? toLeagueRecordColumn(l.wins, l.losses, l.pushes) : null;
  }

  return { leagueRecords: { records, streaks, last20 }, categoryRecords };
}

// Batched form of getCapperCategoryRecord for callers that need many
// (capper, category) records at once - the Sharp Money board and the /live
// game-card expander. Thin wrapper over getCapperRecordBundle (Q6).
//
// ALL_CATEGORY_KEYS, not a sport-scoped set - each pair's `category` is
// whatever that pick's own category is (F5 ML, 1st Half ML, NRFI...),
// independent of any sport the caller is looking at. Safe to query every
// sport's picks together since pickCategory splits F5_ML (MLB) from
// FIRST_HALF_ML.
export async function getCapperCategoryRecords(
  userId: string,
  pairs: { capperId: string; category: PickCategoryKey }[]
): Promise<Record<string, CategoryBreakdownItem | null>> {
  const { categoryRecords } = await getCapperRecordBundle(userId, { leagueEntries: [], categoryPairs: pairs });
  return categoryRecords;
}

// The game-card record block's data: per (capper, category) the Overall /
// League columns, plus two capper-wide values keyed by capperId alone - the
// current overall streak for the trailing 🔥/🧊 indicator, and `last20`, the
// record over the capper's most recent LEAGUE_RECORD_LAST_N graded picks
// across every category and league. `leagueSport` is the game's sport (the
// /live page has one per tab). Thin wrapper over getCapperRecordBundle (Q6).
//
// `entries` is every pick on the card. A null-category entry still puts its
// capper in the streak map (the indicator shows on every pick card) but gets
// no record card. records is null for a (capper, category) the capper has
// never had a pick in.
export async function getCapperLeagueRecords(
  userId: string,
  entries: { capperId: string; leagueSport: string; category: PickCategoryKey | null }[]
): Promise<CapperLeagueRecords> {
  const { leagueRecords } = await getCapperRecordBundle(userId, { leagueEntries: entries, categoryPairs: [] });
  return leagueRecords;
}
