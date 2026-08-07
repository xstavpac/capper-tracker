import { requireUser } from "@/server/auth";
import { getFilteredPicksForUser, getSportsWithLeagues, getPickPlanStatus } from "@/server/data/picks";
import { getCappersForUser } from "@/server/data/cappers";
import { persistFinalScores, gradePendingPicks } from "@/server/data/grading";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import { PickForm } from "@/components/dashboard/pick-form";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { DropCatalogLink } from "@/components/dashboard/drop-catalog-button";
import { favoriteOrUnderdog } from "@/lib/bet-line";
import type { BetType, PickStatus, Period } from "@prisma/client";

const STATUS_OPTIONS = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];
const BET_TYPE_OPTIONS = ["SPREAD", "MONEYLINE", "TOTAL", "PLAYER_PROP"];
const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "FULL_GAME", label: "Full game" },
  { value: "FIRST_HALF", label: "First half / F5" },
];

export default async function PicksPage({
  searchParams,
}: {
  searchParams: {
    capperId?: string;
    sportId?: string;
    status?: string;
    betType?: string;
    period?: string;
    favoriteDog?: string;
  };
}) {
  const user = await requireUser();

  // Each sport's own persist-then-grade sequence is independent of the
  // others, so run them in parallel - with 3+ sports now (was just MLB),
  // doing this sequentially made every Picks page load wait on the sum of
  // every sport's fetch time instead of just the slowest one.
  await Promise.all(
    RESOLVABLE_SPORT_KEYS.map(async (sportKey) => {
      const sportName = LIVE_SPORTS.find((s) => s.key === sportKey)?.label;
      if (!sportName) return;
      try {
        await persistFinalScores(sportKey);
        await gradePendingPicks(user.id, sportName, sportKey);
      } catch {
        // Live score sources are best-effort - don't block the page on a fetch failure.
      }
    })
  );

  const favoriteDog = (searchParams.favoriteDog as "FAVORITE" | "UNDERDOG") || undefined;

  const filters = {
    capperId: searchParams.capperId || undefined,
    sportId: searchParams.sportId || undefined,
    status: (searchParams.status as PickStatus) || undefined,
    betType: (searchParams.betType as BetType) || undefined,
    period: (searchParams.period as Period) || undefined,
  };

  const [allPicks, cappers, sports, planStatus] = await Promise.all([
    getFilteredPicksForUser(user.id, filters),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
    getPickPlanStatus(user.id),
  ]);

  // Favorite/underdog is derived (odds sign for Moneyline, line sign for Spread),
  // not a stored column, so it's filtered here rather than in the DB query.
  const picks = favoriteDog ? allPicks.filter((p) => favoriteOrUnderdog(p) === favoriteDog) : allPicks;

  const hasActiveFilters = Object.values(filters).some(Boolean) || Boolean(favoriteDog);

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
          <DropCatalogLink href="/picks/import" />
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

        <select
          name="period"
          defaultValue={filters.period ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">Full game + first half</option>
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <select
          name="favoriteDog"
          defaultValue={favoriteDog ?? ""}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">Favorite + underdog</option>
          <option value="FAVORITE">Favorite</option>
          <option value="UNDERDOG">Underdog</option>
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
                    {pick.period === "FIRST_HALF" && (
                      <span className="ml-2 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-600">
                        F5
                      </span>
                    )}
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
