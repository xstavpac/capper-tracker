// Frozen copy of cappers.ts's original raw-pick getSportCategoryPanelData -
// moved out (not deleted) because it's still the parity reference
// capper-list-aggregates-acceptance-test.ts and live-category-panel-parity-acceptance-test.ts
// compare the SQL adapter (pick-aggregates-cappers-adapter.ts) against, and
// the T2 harness's `old` registry entry (capture-output.ts) still needs a
// working getSportCategoryPanelData for every implementation it captures.
//
// NO production code calls anything in this file: /cappers and /live both
// import getSportCategoryPanelData from pick-aggregates-cappers-adapter.ts
// (the SQL version, same name, same return shape - #128). This file is
// deleted together with those two tests' legacy comparisons and the T2
// harness's `old` entry once the SQL version has had its own observation
// period, same convention as picks-by-capper-legacy.ts.
//
// Deliberately unchanged from the original cappers.ts implementation - a
// diff against it is a diff against exactly what production used to run.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeCategoryBreakdown,
  pickCategory,
  chipSetForLeague,
  type PickCategoryKey,
  type CategoryLeaderboardEntry,
  type SportCategoryPanelData,
} from "@/server/data/stats";

// Re-exported for this file's own importers (the parity tests, the T2
// harness) - the type definitions themselves live in stats.ts (shared with
// the production SQL implementation - see that file's own comment).
export type { CategoryLeaderboardEntry, SportCategoryPanelData };

const CATEGORY_LEADERBOARD_MIN_PICKS = 3;
const CATEGORY_LEADERBOARD_LIMIT = 5;

// Powers the Live page's category breakdown tiles AND their expandable "top
// cappers in this category" leaderboards, both off one picks query - a tile
// grid with N categories would otherwise mean either N separate queries or
// (worse) a fresh one per click. Scoped by sportName via chipSetForLeague
// rather than hardcoded to MLB, so the same tile+leaderboard pattern is
// ready for another sport's own category set later without any changes
// here - only chipSetForLeague itself would need a new case.
export async function getSportCategoryPanelData(userId: string, sportName: string): Promise<SportCategoryPanelData> {
  const picks = await prisma.pick.findMany({
    where: { userId, sport: { name: sportName } },
    include: { capper: true },
  });
  // The query above already scopes every pick to this exact sportName, so
  // it's safe to attach as a constant here rather than also including the
  // sport relation just to read back what's already known.
  const picksWithSport = picks.map((p) => ({ ...p, sport: { name: sportName } }));

  const breakdown = computeCategoryBreakdown(picksWithSport, chipSetForLeague(sportName));

  const leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>> = {};
  for (const item of breakdown) {
    const scoped = picksWithSport.filter((p) => pickCategory({ ...p, sportName }) === item.key);

    const byCapper = new Map<string, { name: string; picks: typeof scoped }>();
    for (const pick of scoped) {
      const existing = byCapper.get(pick.capperId);
      if (existing) existing.picks.push(pick);
      else byCapper.set(pick.capperId, { name: pick.capper.name, picks: [pick] });
    }

    leaderboards[item.key] = Array.from(byCapper.entries())
      .map(([capperId, g]) => {
        const stats = computeStats(g.picks);
        return { capperId, name: g.name, wins: stats.wins, losses: stats.losses, pushes: stats.pushes, winPct: stats.winPct };
      })
      .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
      .sort((a, b) => b.winPct - a.winPct)
      .slice(0, CATEGORY_LEADERBOARD_LIMIT);
  }

  return { breakdown, leaderboards };
}
