import type { WeeklyLeaderboardEntry } from "@/server/data/cappers";

export function WeeklyLeaderboard({ entries }: { entries: WeeklyLeaderboardEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="mb-6 rounded-card border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-5">
      <div className="mb-1 text-sm font-semibold text-gray-900">Top cappers this week</div>
      <p className="mb-4 text-xs text-gray-500">
        Ranked by ROI - picks graded in the last 7 days, minimum 3 graded picks
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {entries.map((entry, i) => (
          <a
            key={entry.capperId}
            href={"/cappers/" + entry.capperId}
            className="relative rounded-card bg-white p-3 shadow-soft transition hover:shadow-md"
          >
            <span className="absolute right-2 top-2 text-xs font-semibold text-amber-500">#{i + 1}</span>
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-medium text-white"
              style={{ backgroundColor: entry.colorTag ?? "#3B82F6" }}
            >
              {entry.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="mt-2 truncate text-sm font-medium">{entry.name}</div>
            <div className="text-xs text-gray-500">
              {entry.stats.wins}-{entry.stats.losses}-{entry.stats.pushes}
            </div>
            <div className={"text-sm font-medium " + (entry.stats.roi >= 0 ? "text-emerald-600" : "text-red-600")}>
              {entry.stats.roi >= 0 ? "+" : ""}
              {entry.stats.roi}%
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
