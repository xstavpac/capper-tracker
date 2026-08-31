import type { ReactNode } from "react";
import { requireUser } from "@/server/auth";
import { getDashboardSummary } from "@/server/data/stats";
import { getPlanStatus } from "@/server/data/cappers";
import { getCapperPanels } from "@/server/data/capper-panels";
import { UnitsChart } from "@/components/dashboard/units-chart";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";
import { TrendingCappers } from "@/components/dashboard/trending-cappers";
import { EnergyCountUp, EnergyRecordCountUp } from "@/components/dashboard/energy-surge";
import { DropCatalogLink } from "@/components/dashboard/drop-catalog-button";

// Color is now owned by EnergySurge/EnergyCountUp (each value sets its own
// final tone color directly, since the completion effect animates that same
// color property) - this wrapper is layout/label only.
function HeroStat({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const content = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-lg font-semibold">{value}</div>
    </>
  );
  if (href) {
    return (
      <a href={href} className="block rounded-md transition hover:opacity-70">
        {content}
      </a>
    );
  }
  return <div>{content}</div>;
}

const STALE_PENDING_HOURS = 24;

export default async function DashboardPage() {
  const user = await requireUser();
  const [summary, panels, planStatus] = await Promise.all([
    getDashboardSummary(user.id),
    getCapperPanels(user.id),
    getPlanStatus(user.id),
  ]);
  const { overall, chartData, stalePendingCount } = summary;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <DropCatalogLink href="/picks/import" />
      </div>

      <div className="mb-6 rounded-card border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-6 dark:border-brand-500/20 dark:from-brand-500/10 dark:to-card">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-brand-600 dark:text-brand-400">Total picks tracked</div>
              <div className="mt-1 text-4xl font-bold">
                <EnergyCountUp value={summary.totalPicks} commas />
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-brand-600 dark:text-brand-400">Cappers tracked</div>
              <div className="mt-1 text-4xl font-bold">
                <EnergyCountUp value={planStatus.capperCount} commas />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <HeroStat
              label="Record"
              value={<EnergyRecordCountUp wins={overall.wins} losses={overall.losses} pushes={overall.pushes} />}
            />
            <HeroStat
              label="ROI"
              value={
                <EnergyCountUp
                  value={overall.roi}
                  decimals={2}
                  signed
                  suffix="%"
                  tone={overall.roi >= 0 ? "up" : "down"}
                />
              }
            />
            <HeroStat
              label="Net units"
              value={
                <EnergyCountUp
                  value={overall.netUnits}
                  decimals={2}
                  signed
                  suffix="u"
                  tone={overall.netUnits >= 0 ? "up" : "down"}
                />
              }
            />
            <HeroStat label="Pending" value={<EnergyCountUp value={summary.pendingCount} />} href="/picks/pending" />
          </div>
        </div>
      </div>

      {stalePendingCount > 0 && (
        <a
          href="/picks/pending"
          className="mb-6 flex items-center justify-between gap-3 rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 transition hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
        >
          <span>
            {stalePendingCount} pick{stalePendingCount === 1 ? " has" : "s have"} been pending over{" "}
            {STALE_PENDING_HOURS} hours - review them
          </span>
          <span className="font-medium">&rarr;</span>
        </a>
      )}

      {summary.categoryBreakdown.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Record by category</h2>
          <CategoryBreakdown items={summary.categoryBreakdown} animateIn />
        </div>
      )}

      <TrendingCappers panels={panels} />

      <div className="mb-6 rounded-card bg-card p-5 shadow-soft">
        <div className="mb-2 text-sm font-medium text-muted-foreground">Performance</div>
        <UnitsChart data={chartData} />
      </div>

      <div className="rounded-card bg-card p-4 shadow-soft">
        <div className="text-sm text-muted-foreground">Recent picks</div>
        <div className="mt-3 divide-y divide-border-subtle">
          {summary.recentPicks.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No picks yet - add your first capper to get started.
            </p>
          )}
          {summary.recentPicks.map((pick) => (
            <div key={pick.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {pick.awayTeam} @ {pick.homeTeam} - {pick.label}
                <span className="text-muted-foreground"> ({pick.capperName})</span>
              </span>
              <span
                className={
                  pick.status === "WIN"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : pick.status === "LOSS"
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
                }
              >
                {pick.status === "PENDING" ? "Pending" : pick.status + " - " + pick.units + "u"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
