// FROZEN pre-migration reference for the /dashboard summary (docs/design/
// dashboard-capper-detail-egress.md §8 "legacy"). It is the JS path that
// computeDashboardSummary ran until the dashboard egress PR: fetch every pick the
// user ever made, then derive every output from that one array in JS. Kept ONLY so
// dashboard-summary-acceptance-test.ts and scripts/t2-harness/dashboard-parity.ts
// have something to diff the one-statement SQL path against, and deleted after the
// observation period. Nothing under src/ outside a *-acceptance-test.ts file may
// import this module (legacy-reference-import-guard-acceptance-test.ts enforces it).
//
// Two deliberate differences from the code it was copied from, both for a fair
// comparison rather than a behavior change:
//   - `now` is an explicit parameter (the original read Date.now()), so the two
//     paths can be run at the same pinned instant;
//   - the picks are put in the explicit total order (gameTime, createdAt, id) before
//     use - the original relied on `orderBy: { gameTime: "desc" }`, which leaves
//     same-gameTime ties in physical row order. The canonical tie-break is what the
//     JS sorts (pick-order.ts) and the SQL fragments share.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatPickLabel } from "@/lib/bet-line";
import { comparePicksChronologicalDesc } from "@/lib/pick-order";
import { downsampleUnitsChart } from "@/server/data/units-chart-downsample";
import { DEFAULT_CHIP_SET, betTypeLabel, computeCategoryBreakdown, computeStats, computeUnitsChartData } from "@/server/data/stats";

const STALE_PENDING_HOURS = 24;

export type LegacyDashboardPick = Prisma.PickGetPayload<{
  include: { sport: { select: { name: true } }; capper: { select: { id: true; name: true } }; league: { select: { id: true; name: true } } };
}>;

// The original getPickRowsForStats fetch, verbatim apart from the ordering note above.
export async function loadLegacyDashboardPicks(userId: string): Promise<LegacyDashboardPick[]> {
  return prisma.pick.findMany({
    where: { userId },
    orderBy: { gameTime: "desc" },
    include: {
      sport: { select: { name: true } },
      capper: { select: { id: true, name: true } },
      league: { select: { id: true, name: true } },
    },
  });
}

export function computeDashboardSummaryLegacy(rows: LegacyDashboardPick[], now: Date) {
  const picks = [...rows].sort(comparePicksChronologicalDesc);
  const staleCutoff = now.getTime() - STALE_PENDING_HOURS * 3600000;

  return {
    overall: computeStats(picks),
    totalPicks: picks.length,
    categoryBreakdown: computeCategoryBreakdown(picks, DEFAULT_CHIP_SET),
    chartData: downsampleUnitsChart(computeUnitsChartData(picks)),
    pendingCount: picks.filter((p) => p.status === "PENDING").length,
    stalePendingCount: picks.filter((p) => p.status === "PENDING" && p.gameTime.getTime() < staleCutoff).length,
    recentPicks: picks.slice(0, 10).map((p) => ({
      id: p.id,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      label: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
      capperName: p.capper.name,
      status: p.status,
      units: p.units,
    })),
  };
}

// The `overall` fields the new summary keeps (Q4): the only ones /dashboard reads.
export const DASHBOARD_OVERALL_FIELDS = ["wins", "losses", "pushes", "roi", "netUnits"] as const;

// The legacy summary reduced to the shape computeDashboardSummary now returns.
export function narrowLegacySummary(l: ReturnType<typeof computeDashboardSummaryLegacy>) {
  const overall = Object.fromEntries(DASHBOARD_OVERALL_FIELDS.map((k) => [k, l.overall[k]]));
  return { ...l, overall };
}

// First differing path between two JSON-shaped values, or null. `===` on numbers with
// -0 == +0 (design doc §5), NaN == NaN, Dates by instant; key sets must match exactly.
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b)) ? null : `${path}: ${a} !== ${b}`;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? null : `${path}: ${a.toISOString()} !== ${b.toISOString()}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join(",") !== kb.join(",")) return `${path}: keys [${ka}] !== [${kb}]`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
