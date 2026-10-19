// The SQL-backed per-capper helpers production still uses from what was the
// Cappers-page adapter: getSportCategoryPanelData (the /live category panel),
// statsFromRows and specialistTagsFromCandidateRows (shared with the /cappers page
// bundle, cappers-page-aggregates.ts).
//
// Data flow: the database summarizes, the app receives only the small result.
// capper-list-aggregates.ts runs the GROUP BY / window-function queries and this
// file turns those raw totals into the page's shapes with the SAME rounding/
// derivation functions the JS path uses (recordStatsFromTotals,
// specialistFromCategoryTotals in stats.ts). Nothing here fetches raw Pick rows.
//
// The category panel reads the STORED Pick.category (stamped at insert, backfilled
// once for older picks - see scripts/backfill-pick-category.ts). If
// PICK_CATEGORY_VERSION is ever bumped, run the backfill so stored categories are
// restamped - until then they reflect the old version's classification.
//
// The leaderboard / favorites / most-active functions that used to live here (no
// page calls them) are in pick-aggregates-cappers-adapter-legacy.ts.
import {
  chipSetForLeague,
  recordStatsFromTotals,
  specialistFromCategoryTotals,
  winPctOf,
  PICK_CATEGORY_LABELS,
  type PickCategoryKey,
  type CategoryBreakdownItem,
  type CategoryDecidedTotals,
  type RecordStats,
  type SpecialistTag,
  type SportCategoryPanelData,
  type CategoryLeaderboardEntry,
} from "@/server/data/stats";
import {
  type SpecialistCandidateRow,
  queryCategoryPanel,
  zeroOddsWinUnitsWon,
  type WindowTotals,
  type StreakRow,
} from "@/server/data/capper-list-aggregates";
import { getCappersForUser } from "@/server/data/cappers";

// SportCategoryPanelData / CategoryLeaderboardEntry come from stats.ts, not
// from sport-category-panel-legacy.ts - that file is a parity-test/T2-harness-
// only reference (its getSportCategoryPanelData is unused by any page since
// #128) and production code must not import it. This adapter's own
// getSportCategoryPanelData below reuses the same shared type on purpose
// ("same name, same return shape" is the point of the migration).


// Mirrors cappers.ts's own private CATEGORY_LEADERBOARD_MIN_PICKS /
// CATEGORY_LEADERBOARD_LIMIT constants - kept in sync by hand since they
// aren't exported from there.
const CATEGORY_LEADERBOARD_MIN_PICKS = 3;
const CATEGORY_LEADERBOARD_LIMIT = 5;

const NO_STREAK = { type: "NONE", count: 0 } as const;


// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export function statsFromRows(totals: WindowTotals | undefined, streak: StreakRow | undefined): RecordStats {
  // A WIN at odds = 0 makes the JS unitsWon Infinity/NaN (see
  // zeroOddsWinUnitsWon) - reproduced, not fixed.
  const poisoned = zeroOddsWinUnitsWon(totals?.zeroOddsWinFlags ?? 0);
  return {
    ...recordStatsFromTotals({
      wins: totals?.wins ?? 0,
      losses: totals?.losses ?? 0,
      pushes: totals?.pushes ?? 0,
      unitsWon: poisoned ?? totals?.unitsWon ?? 0,
      unitsLost: totals?.unitsLost ?? 0,
      unitsRisked: totals?.unitsRisked ?? 0,
    }),
    currentStreak: streak ? { type: streak.type, count: streak.count } : { ...NO_STREAK },
  };
}

// ---------------------------------------------------------------------------
// Specialist tags
// ---------------------------------------------------------------------------


// The candidate rows -> tag decision, shared with the /cappers page bundle (which fetches the
// same rows for just its displayed cappers).
export function specialistTagsFromCandidateRows(rows: SpecialistCandidateRow[]): Map<string, SpecialistTag | null> {
  const byCapper = new Map<string, { decidedTotal: number; overall: { wins: number; losses: number }; candidates: typeof rows }>();
  for (const r of rows) {
    const g = byCapper.get(r.capperId) ?? { decidedTotal: r.decidedTotal, overall: { wins: r.totalWins, losses: r.totalLosses }, candidates: [] };
    g.candidates.push(r);
    byCapper.set(r.capperId, g);
  }

  const out = new Map<string, SpecialistTag | null>();
  for (const [capperId, g] of byCapper) {
    // Tie-break order: the category whose first decided pick (createdAt, id)
    // came first is considered first, so it wins an exact 50/50 share tie.
    const ordered = g.candidates
      .slice()
      .sort((a, b) => (a.firstDecidedKey < b.firstDecidedKey ? -1 : a.firstDecidedKey > b.firstDecidedKey ? 1 : 0))
      .map((c) => [c.category as PickCategoryKey, { wins: c.wins, losses: c.losses, pushes: c.pushes }] as [PickCategoryKey, CategoryDecidedTotals]);
    out.set(capperId, specialistFromCategoryTotals(g.decidedTotal, g.overall, ordered));
  }
  return out;
}


// ---------------------------------------------------------------------------
// Category panel ("Best at...")
// ---------------------------------------------------------------------------

export async function getSportCategoryPanelData(userId: string, sportName: string): Promise<SportCategoryPanelData> {
  const [rows, roster] = await Promise.all([
    queryCategoryPanel({ userId, sportName, minPicks: CATEGORY_LEADERBOARD_MIN_PICKS, limit: CATEGORY_LEADERBOARD_LIMIT }),
    getCappersForUser(userId),
  ]);

  // The aggregates carry only the capperId, so the per-category leaderboard
  // must explicitly join it against this separately-fetched roster to recover
  // capper.name - never left implicit.
  const nameByCapperId = new Map(roster.map((c) => [c.id, c.name]));

  const rowsByCategory = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = rowsByCategory.get(r.category);
    if (list) list.push(r);
    else rowsByCategory.set(r.category, [r]);
  }

  const breakdown: CategoryBreakdownItem[] = [];
  for (const key of chipSetForLeague(sportName)) {
    const categoryRows = rowsByCategory.get(key);
    if (!categoryRows) continue;
    // The pooled totals ride on every row of the category.
    const { categoryWins: wins, categoryLosses: losses, categoryPushes: pushes } = categoryRows[0];
    const count = wins + losses + pushes;
    // A category with picks but none decided yet would render as a dead 0-0 tile.
    if (count === 0) continue;
    breakdown.push({ key, label: PICK_CATEGORY_LABELS[key], wins, losses, pushes, winPct: winPctOf(wins, losses), count });
  }

  const leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>> = {};
  for (const item of breakdown) {
    leaderboards[item.key] = (rowsByCategory.get(item.key) ?? [])
      .map((r) => ({
        capperId: r.capperId,
        name: nameByCapperId.get(r.capperId) ?? "Unknown capper",
        wins: r.wins,
        losses: r.losses,
        pushes: r.pushes,
        winPct: winPctOf(r.wins, r.losses),
        firstKey: r.firstAnyKey,
      }))
      .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
      // Equal win% ties: the capper whose first pick in this category (any
      // status) is earlier by createdAt, id ranks first.
      .sort((a, b) => b.winPct - a.winPct || (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0))
      .slice(0, CATEGORY_LEADERBOARD_LIMIT)
      .map(({ firstKey: _firstKey, ...entry }) => entry);
  }

  return { breakdown, leaderboards };
}
