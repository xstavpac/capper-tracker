import { requireUser } from "@/server/auth";
import { getPicksForUser, getSportsWithLeagues } from "@/server/data/picks";
import { getCappersForUser } from "@/server/data/cappers";
import { PickForm } from "@/components/dashboard/pick-form";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";

export default async function PicksPage() {
  const user = await requireUser();
  const [picks, cappers, sports] = await Promise.all([
    getPicksForUser(user.id),
    getCappersForUser(user.id),
    getSportsWithLeagues(),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Picks</h1>
          <p className="mt-1 text-sm text-gray-500">
            {picks.length} pick{picks.length === 1 ? "" : "s"} logged
          </p>
        </div>
        <PickForm cappers={cappers} sports={sports} />
      </div>

      {picks.length === 0 ? (
        <div className="rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">
            No picks logged yet - log your first pick above.
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
