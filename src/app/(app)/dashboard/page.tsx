import { requireUser } from "@/server/auth";
import { getDashboardSummary, getUserPicks, computeUnitsChartData } from "@/server/data/stats";
import { getCapperById } from "@/server/data/cappers";
import { getCapperPanels } from "@/server/data/capper-panels";
import { UnitsChart } from "@/components/dashboard/units-chart";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { TrendingCappers } from "@/components/dashboard/trending-cappers";

function HeroStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass = tone === "up" ? "text-emerald-600" : tone === "down" ? "text-red-600" : "text-gray-900";
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={"mt-0.5 text-lg font-semibold " + toneClass}>{value}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const [summary, panels] = await Promise.all([getDashboardSummary(user.id), getCapperPanels(user.id)]);
  const { overall } = summary;

  const topCapper = summary.topCapper
    ? await getCapperById(user.id, summary.topCapper.capperId)
    : null;

  const allPicks = await getUserPicks(user.id);
  const chartData = computeUnitsChartData(allPicks);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Dashboard</h1>

      <div className="mb-6 rounded-card border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-brand-600">Total picks tracked</div>
            <div className="mt-1 text-4xl font-bold text-gray-900">{summary.totalPicks.toLocaleString()}</div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <HeroStat label="Record" value={overall.wins + "-" + overall.losses + "-" + overall.pushes} />
            <HeroStat
              label="ROI"
              value={(overall.roi >= 0 ? "+" : "") + overall.roi + "%"}
              tone={overall.roi >= 0 ? "up" : "down"}
            />
            <HeroStat
              label="Net units"
              value={(overall.netUnits >= 0 ? "+" : "") + overall.netUnits + "u"}
              tone={overall.netUnits >= 0 ? "up" : "down"}
            />
            <HeroStat label="Pending" value={String(summary.pendingCount)} />
          </div>
        </div>
      </div>

      {summary.categoryBreakdown.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">Record by category</h2>
          <CategoryBreakdown items={summary.categoryBreakdown} />
        </div>
      )}

      <TrendingCappers panels={panels} />

      <div className="mb-6 rounded-card bg-white p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-gray-700">Performance</div>
        <UnitsChart data={chartData} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-card bg-white p-4 shadow-soft lg:col-span-2">
          <div className="text-sm text-gray-500">Recent picks</div>
          <div className="mt-3 divide-y divide-gray-100">
            {summary.recentPicks.length === 0 && (
              <p className="py-6 text-center text-sm text-gray-400">
                No picks yet - add your first capper to get started.
              </p>
            )}
            {summary.recentPicks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  {pick.awayTeam} @ {pick.homeTeam} - {pick.betDetail ?? pick.betType}
                </span>
                <span
                  className={
                    pick.status === "WIN"
                      ? "text-emerald-600"
                      : pick.status === "LOSS"
                        ? "text-red-600"
                        : "text-gray-400"
                  }
                >
                  {pick.status === "PENDING" ? "Pending" : pick.status + " - " + pick.units + "u"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-card bg-white p-4 shadow-soft">
          <div className="text-sm text-gray-500">Top capper</div>
          {topCapper ? (
            <div className="mt-3">
              <div className="font-medium">{topCapper.name}</div>
              <div className="mt-1 text-sm text-emerald-600">
                {summary.topCapper!.stats.netUnits >= 0 ? "+" : ""}
                {summary.topCapper!.stats.netUnits}u - {summary.topCapper!.stats.roi}% ROI
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-400">Add picks to see your top capper.</p>
          )}
        </div>
      </div>
    </div>
  );
}
