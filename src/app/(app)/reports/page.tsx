import { requireUser } from "@/server/auth";
import { getReportsData, type ReportBreakdownItem } from "@/server/data/stats";
import { getParlayReportsData, type ParlayOverallStats } from "@/server/data/parlay-stats";
import { WinLossPieChart } from "@/components/dashboard/win-loss-pie-chart";

function BreakdownList({ title, items }: { title: string; items: ReportBreakdownItem[] }) {
  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <div className="mb-3 text-sm font-medium text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No data yet.</p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {items.map((item) => (
            <div key={item.name} className="flex items-center justify-between py-2 text-sm">
              <div>
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-muted-foreground">
                  {item.count} pick{item.count === 1 ? "" : "s"}
                </div>
              </div>
              <div className={"font-medium " + (item.stats.roi >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
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
    <div className="rounded-card bg-card p-4 shadow-soft">
      <div className="text-sm text-muted-foreground">{label}</div>
      {item ? (
        <>
          <div className="mt-1 text-lg font-semibold">{item.name}</div>
          <div className={"text-sm font-medium " + (item.stats.roi >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
            {item.stats.roi >= 0 ? "+" : ""}
            {item.stats.roi}% ROI
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">No data yet</div>
      )}
    </div>
  );
}

// Separate card, separate query (getParlayReportsData, not getReportsData) -
// deliberately never blended into the picks-only breakdowns above. See the
// schema comment on ParlayBet for why a parlay leg must never be counted as
// its own row in any of those.
function ParlayCard({ overall, totalParlays }: { overall: ParlayOverallStats; totalParlays: number }) {
  const decided = overall.wins + overall.losses + overall.pushes;
  if (totalParlays === 0) {
    return (
      <div className="rounded-card bg-white p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-gray-700">Parlay record</div>
        <p className="py-4 text-center text-sm text-gray-400">No parlays logged yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <div className="mb-2 text-sm font-medium text-gray-700">Parlay record</div>
      <div className="flex items-baseline justify-between">
        <div className="text-lg font-semibold">
          {overall.wins}-{overall.losses}
          {overall.pushes > 0 ? "-" + overall.pushes : ""}
        </div>
        <div className={"text-sm font-medium " + (overall.roi >= 0 ? "text-emerald-600" : "text-red-600")}>
          {overall.roi >= 0 ? "+" : ""}
          {overall.roi}% ROI
        </div>
      </div>
      <div className="mt-1 text-xs text-gray-400">
        {decided} decided{" "}
        {overall.netUnits !== 0 && (
          <>
            &middot; {overall.netUnits >= 0 ? "+" : ""}
            {overall.netUnits}u net
          </>
        )}
      </div>
    </div>
  );
}

export default async function ReportsPage() {
  const user = await requireUser();
  const data = await getReportsData(user.id);
  const parlayData = await getParlayReportsData(user.id);

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
        <div className="rounded-card bg-card p-5 shadow-soft lg:col-span-1">
          <div className="mb-2 text-sm font-medium text-muted-foreground">Win / Loss / Push</div>
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

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ParlayCard overall={parlayData.overall} totalParlays={parlayData.totalParlays} />
      </div>
    </div>
  );
}
