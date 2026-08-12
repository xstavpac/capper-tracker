import { requireUser } from "@/server/auth";
import { getSharpMoneyBoard, type SharpMoneyPick } from "@/server/data/sharp-money";
import { getRecordColor } from "@/server/data/stats";
import { Avatar } from "@/components/dashboard/capper-panels";

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-card bg-white p-8 text-center text-sm text-gray-400 shadow-soft">{message}</div>
  );
}

function PickRow({ pick }: { pick: SharpMoneyPick }) {
  const color = getRecordColor(pick.record.winPct);
  return (
    <a
      href={"/cappers/" + pick.capperId}
      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={pick.capperName} colorTag={pick.capperColorTag} size={28} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-900">{pick.capperName}</div>
          <div className="truncate text-xs text-gray-500">
            {pick.betDetail || pick.betType}
            <span className="text-gray-400"> &middot; {pick.awayTeam} @ {pick.homeTeam}</span>
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-gray-900">
          {pick.odds > 0 ? "+" : ""}
          {pick.odds} <span className="font-normal text-gray-400">&middot; {pick.units}u</span>
        </div>
        <div className={"text-xs font-medium " + (color === "green" ? "text-emerald-600" : "text-red-600")}>
          {pick.record.wins}-{pick.record.losses}
          {pick.record.pushes > 0 ? "-" + pick.record.pushes : ""} ({Math.round(pick.record.winPct)}%)
        </div>
      </div>
    </a>
  );
}

export default async function SharpMoneyPage() {
  const user = await requireUser();
  const board = await getSharpMoneyBoard(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Sharp Money</h1>
        <p className="mt-1 text-sm text-gray-500">
          Today&apos;s picks where the capper has a historically strong record (55%+) in that exact bet category.
        </p>
      </div>

      {board.status === "no_picks" && <EmptyState message="No picks posted yet today." />}

      {board.status === "cleared" && (
        <EmptyState message="Today's games have all finished - check back once new picks come in." />
      )}

      {board.status === "active" && board.sports.length === 0 && (
        <EmptyState message="No picks qualify for Sharp Money today yet." />
      )}

      {board.status === "active" && board.sports.length > 0 && (
        <div className="space-y-8">
          {board.sports.map((sport) => (
            <div key={sport.sportName}>
              <h2 className="mb-3 text-base font-semibold text-gray-900">{sport.sportName}</h2>
              <div className="space-y-4">
                {sport.categories.map((category) => (
                  <div key={category.key} className="rounded-card bg-white shadow-soft">
                    <div className="border-b border-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700">
                      {category.label}
                    </div>
                    <div className="divide-y divide-gray-100">
                      {category.picks.map((pick) => (
                        <PickRow key={pick.pickId} pick={pick} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
