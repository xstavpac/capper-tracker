import { requireUser } from "@/server/auth";
import { getDashboardSummary } from "@/server/data/stats";
import { getCapperById } from "@/server/data/cappers";

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass =
    tone === "up" ? "text-emerald-600" : tone === "down" ? "text-red-600" : "text-gray-900";
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const summary = await getDashboardSummary(user.id);
  const { overall } = summary;

  const topCapper = summary.topCapper
    ? await getCapperById(user.id, summary.topCapper.capperId)
    : null;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Overall record" value={`${overall.wins}-${overall.losses}-${overall.pushes}`} />
        <StatCard
          label="ROI"
          value={`${overall.roi >= 0 ? "+" : ""}${overall.roi}%`}
          tone={overall.roi >= 0 ? "up" : "down"}
        />
        <StatCard
          label="Net units"
          value={`${overall.netUnits >= 0 ? "+" : ""}${overall.netUnits}u`}
          tone={overall.netUnits >= 0 ? "up" : "down"}
        />
        <StatCard label="Pending picks" value={String(summary.pendingCount)} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="col-span-2 rounded-card bg-white p-4 shadow-soft">
          <div className="text-sm text-gray-500">Recent picks</div>
          <div className="mt-3 divide-y divide-gray-100">
            {summary.recentPicks.length === 0 && (
              <p className="py-6 text-center text-sm text-gray-400">
                No picks yet — add your first capper to get started.
              </p>
            )}
            {summary.recentPicks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  {pick.awayTeam} @ {pick.homeTeam} · {pick.betDetail ?? pick.betType}
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
                  {pick.status === "PENDING" ? "Pending" : `${pick.status} · ${pick.units}u`}
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
                {summary.topCapper!.stats.netUnits}u · {summary.topCapper!.stats.roi}% ROI
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
