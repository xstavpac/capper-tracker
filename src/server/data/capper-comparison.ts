import type { Pick } from "@prisma/client";
import { getPicksForCapper } from "@/server/data/picks";
import { getCapperById } from "@/server/data/cappers";
import {
  computeStats,
  computeUnitsChartByPickNumber,
  computeMaxDrawdown,
  currentStreak,
  type OverallStats,
  type PickNumberChartPoint,
} from "@/server/data/stats";
import { favoriteOrUnderdog } from "@/lib/bet-line";
import { betTypeFilterCategory, type BetTypeFilterKey } from "@/lib/bet-type-filter";
import { easternDateRange } from "@/lib/dates";

// Everything the capper comparison tool's shared filter bar can narrow by.
// Applied entirely in-memory (see applyComparisonFilters below), the same
// architectural pattern the Picks page already uses for its own bet-type
// filter (fetch broadly, filter derived/computed fields in JS) - not a
// second DB-query-building abstraction, and not worth one: a capper's full
// pick history is a bounded, small dataset (getPicksForCapper has no
// pagination), so there's no performance reason to push any of this down
// into SQL.
export type ComparisonFilters = {
  sportId: string | null;
  betType: BetTypeFilterKey | null;
  favDog: "FAVORITE" | "UNDERDOG" | null;
  dayOfWeek: number | null; // 0 (Sunday) - 6 (Saturday), matches Date#getDay()
  month: number | null; // 1-12
  streak: { type: "WIN" | "LOSS"; length: 1 | 2 | 3 | 4 } | null; // 4 means "4+", matching Momentum's own bucketing convention
  dateRange: { start: string; end: string } | null; // "YYYY-MM-DD", Eastern - same shape as Charts' DateRange
  oddsMin: number | null;
  oddsMax: number | null;
  unitsMin: number | null;
  unitsMax: number | null;
};

export const EMPTY_COMPARISON_FILTERS: ComparisonFilters = {
  sportId: null,
  betType: null,
  favDog: null,
  dayOfWeek: null,
  month: null,
  streak: null,
  dateRange: null,
  oddsMin: null,
  oddsMax: null,
  unitsMin: null,
  unitsMax: null,
};

// The streak filter needs each pick's OWN preceding-streak state, which is a
// running/positional property (depends on every earlier pick), not a
// per-pick field - computed once up front (same currentStreak-over-a-
// growing-prefix approach computeMomentum already uses in stats.ts, reused
// directly rather than re-derived) so the actual filter pass below is a
// plain O(1) lookup per pick, not an O(n) rescan per pick.
function precedingStreakByPickId(picks: Pick[]): Map<string, { type: "WIN" | "LOSS"; count: number }> {
  const decided = [...picks]
    .filter((p) => p.status === "WIN" || p.status === "LOSS")
    .sort((a, b) => a.gameTime.getTime() - b.gameTime.getTime());

  const byId = new Map<string, { type: "WIN" | "LOSS"; count: number }>();
  for (let i = 1; i < decided.length; i++) {
    const preceding = currentStreak(decided.slice(0, i));
    if (preceding.type === "NONE") continue;
    byId.set(decided[i].id, { type: preceding.type, count: preceding.count });
  }
  return byId;
}

// Applies every selected filter dimension as one combined in-memory pass.
// Each dimension reuses existing classification logic where it already
// existed elsewhere in the app (favoriteOrUnderdog, betTypeFilterCategory,
// currentStreak) rather than re-deriving it - day/month/units-range have no
// existing precedent anywhere in the codebase (confirmed during
// investigation), so those are new, deliberately small (one line each)
// derivations straight off fields already on Pick.
export function applyComparisonFilters(picks: Pick[], filters: ComparisonFilters): Pick[] {
  const streakByPickId = filters.streak ? precedingStreakByPickId(picks) : null;
  const dateRange = filters.dateRange ? easternDateRange(filters.dateRange.start, filters.dateRange.end) : null;

  return picks.filter((p) => {
    if (filters.sportId && p.sportId !== filters.sportId) return false;
    if (filters.betType && betTypeFilterCategory(p) !== filters.betType) return false;
    if (filters.favDog && favoriteOrUnderdog(p) !== filters.favDog) return false;
    if (filters.dayOfWeek !== null && p.gameTime.getDay() !== filters.dayOfWeek) return false;
    if (filters.month !== null && p.gameTime.getMonth() + 1 !== filters.month) return false;
    if (dateRange && (p.gameTime < dateRange.start || p.gameTime >= dateRange.end)) return false;
    if (filters.oddsMin !== null && p.odds < filters.oddsMin) return false;
    if (filters.oddsMax !== null && p.odds > filters.oddsMax) return false;
    if (filters.unitsMin !== null && p.units < filters.unitsMin) return false;
    if (filters.unitsMax !== null && p.units > filters.unitsMax) return false;
    if (filters.streak) {
      const preceding = streakByPickId!.get(p.id);
      if (!preceding) return false;
      if (preceding.type !== filters.streak.type) return false;
      const matchesLength = filters.streak.length === 4 ? preceding.count >= 4 : preceding.count === filters.streak.length;
      if (!matchesLength) return false;
    }
    return true;
  });
}

export type CapperComparisonProfile = {
  capperId: string;
  capperName: string;
  stats: OverallStats;
  chartData: PickNumberChartPoint[];
  maxDrawdown: number;
  betCount: number; // decided (win+loss) picks after filtering - what "sample size" means for this comparison
};

async function buildProfile(userId: string, capperId: string, filters: ComparisonFilters): Promise<CapperComparisonProfile> {
  const capper = await getCapperById(userId, capperId);
  if (!capper) throw new Error("Capper not found.");

  const allPicks = await getPicksForCapper(userId, capperId);
  const filtered = applyComparisonFilters(allPicks, filters);

  return {
    capperId,
    capperName: capper.name,
    stats: computeStats(filtered),
    chartData: computeUnitsChartByPickNumber(filtered),
    maxDrawdown: computeMaxDrawdown(filtered),
    betCount: filtered.filter((p) => p.status === "WIN" || p.status === "LOSS").length,
  };
}

// Both cappers built independently and in parallel - deliberately NOT a
// single combined query, since ownership (getCapperById/getPicksForCapper,
// both userId-scoped) and filtering are identical work per capper regardless
// of whether they're fetched together or apart, and comparing two capperIds
// says nothing about whether they belong to the same sport/league/anything
// else that could be pushed into one query.
export async function getCapperComparison(
  userId: string,
  capperAId: string,
  capperBId: string,
  filters: ComparisonFilters
): Promise<{ a: CapperComparisonProfile; b: CapperComparisonProfile }> {
  const [a, b] = await Promise.all([buildProfile(userId, capperAId, filters), buildProfile(userId, capperBId, filters)]);
  return { a, b };
}
