import { requireUser } from "@/server/auth";
import { getFilteredPicksForUser, getSportsWithLeagues, getPickPlanStatus } from "@/server/data/picks";
import { getCappersForUser } from "@/server/data/cappers";
import { persistMlbFinalScores, gradePendingPicks } from "@/server/data/grading";
import { PickForm } from "@/components/dashboard/pick-form";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import type { BetType, PickStatus } from "@prisma/client";

const STATUS_OPTIONS = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];
const BET_TYPE_OPTIONS = ["SPREAD", "MONEYLINE", "TOTAL", "PLAYER_PROP"];

export default async function PicksPage({
  searchParams,
}: {
  searchParams: { capperId?: string; sportId?: string; status?: string; betType?: string };
}) {
  const user = await requireUser();

  try {
    await persistMlbFinalScores();
    await gradePendingPicks(user.id);
  } catch {
    // Live score sources are best-effort - don't block the page on a fetch failure.
  }

  const filters = {
    capperId: searchParams.capperId || undefined,
    sportId: searchParams.sportId || undefined,
    status: (searchParams.status as PickStatus) || undefined,
    betType: (searchParams.betType as BetType) || undefined,
  };

  const [picks, cappers, sports, planStatus] = await Promise.all([
    getFilteredPicksForUser(user.id, filters),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
  ]);

  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Picks</h1>
          <p className="mt-1 text-sm text-gray-500">
            {planStatus.isPro
              ? planStatus.pickCount + " pick" + (planStatus.pickCount === 1 ? "" : "s")
              : planStatus.pickCount + " of " + planStatus.pickLimit + " picks (Free plan)"}
            {hasActiveFilters ? " - " + picks.length + " match filters" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/picks/import"
            className="rounded-full border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:border-gray-300"
          >
            Bulk import
          </a>
          <PickForm cappers={cappers} sports={sports} atLimit={planStatus.atLimit} />
        </div>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-center gap-2 rounded-card bg-white p-3 shadow-soft">
        <select
          name="capperId"
          defaultValue={filters.capperId ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">All cappers</option>
          {cappers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          name="sportId"
          defaultValue={filters.sportId ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          name="betType"
          defaultValue={filters.betType ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">All bet types</option>
          {BET_TYPE_OPTIONS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        <select
          name="status"
          defaultValue={filters.status ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">All results</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <button
          type="submit"
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Filter
        </button>

        {hasActiveFilters && (
          <a href="/picks" className="text-sm text-gray-500 hover:text-gray-700">
            Clear
          </a>
        )}
      </form>

      {picks.length === 0 ? (
        <div className="rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">
            {hasActiveFilters
              ? "No picks match these filters."
              : "No picks logged yet - log your first pick above."}
          </p>
        </div>
      ) : (
        <div className="rounded-card bg-white shadow-soft">
          <div className="divide-y divide-gray-100">
            {picks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {pick.awayTeam} @ {pick.homeTeam}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    {pick.capper.name} - {pick.betDetail || pick.betType} - {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u
                  </div>
                </div>
                <PickStatusButtons pickId={pick.id} status={pick.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
