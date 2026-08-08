import { requireUser } from "@/server/auth";
import { getReportsData, type ReportBreakdownItem } from "@/server/data/stats";
import { WinLossPieChart } from "@/components/dashboard/win-loss-pie-chart";

function BreakdownList({ title, items }: { title: string; items: ReportBreakdownItem[] }) {
  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <div className="mb-3 text-sm font-medium text-gray-700">{title}</div>
      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400">No data yet.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {items.map((item) => (
            <div key={item.name} className="flex items-center justify-between py-2 text-sm">
              <div>
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-gray-400">
                  {item.count} pick{item.count === 1 ? "" : "s"}
                </div>
              </div>
              <div className={"font-medium " + (item.stats.roi >= 0 ? "text-emerald-600" : "text-red-600")}>
                {item.stats.roi >= 0 ? "+" : ""}
                {item.stats.roi}%
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HighlightCard({ label, item }: { label: string; item: ReportBreakdownItem | null }) {
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="text-sm text-gray-500">{label}</div>
      {item ? (
        <>
          <div className="mt-1 text-lg font-semibold">{item.name}</div>
          <div className={"text-sm font-medium " + (item.stats.roi >= 0 ? "text-emerald-600" : "text-red-600")}>
            {item.stats.roi >= 0 ? "+" : ""}
            {item.stats.roi}% ROI
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-gray-400">No data yet</div>
      )}
    </div>
  );
}

export default async function ReportsPage() {
  const user = await requireUser();
  const data = await getReportsData(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-xl font-semibold">Reports</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HighlightCard label="Best capper" item={data.bestCapper} />
        <HighlightCard label="Worst capper" item={data.worstCapper} />
        <HighlightCard label="Most profitable sport" item={data.bestSport} />
        <HighlightCard label="Most profitable bet type" item={data.bestBetType} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-card bg-white p-5 shadow-soft lg:col-span-1">
          <div className="mb-2 text-sm font-medium text-gray-700">Win / Loss / Push</div>
          <WinLossPieChart wins={data.overall.wins} losses={data.overall.losses} pushes={data.overall.pushes} />
        </div>
        <div className="lg:col-span-2">
          <BreakdownList title="Profit by capper" items={data.byCapper} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <BreakdownList title="Profit by sport" items={data.bySport} />
        <BreakdownList title="Profit by league" items={data.byLeague} />
        <BreakdownList title="Profit by bet type" items={data.byBetType} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BreakdownList title="Profit by period" items={data.byPeriod} />
        <BreakdownList title="Profit by favorite / underdog" items={data.byFavoriteDog} />
      </div>
    </div>
  );
}
