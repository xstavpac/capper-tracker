import type { RankedCapperEntry } from "@/server/data/cappers";

function FlameIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z" />
    </svg>
  );
}

function SnowflakeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M12 2v20M4 7l16 10M20 7 4 17M2 12h20" />
    </svg>
  );
}

function StreakBadge({ streak }: { streak: RankedCapperEntry["stats"]["currentStreak"] }) {
  if (streak.count < 2) return null;
  const isWin = streak.type === "WIN";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
        (isWin ? "bg-orange-50 text-orange-600" : "bg-sky-50 text-sky-600")
      }
    >
      {isWin ? <FlameIcon /> : <SnowflakeIcon />}
      {streak.count}
    </span>
  );
}

export function CapperRankedList({ entries }: { entries: RankedCapperEntry[] }) {
  return (
    <div className="overflow-hidden rounded-card bg-white shadow-soft">
      <div className="divide-y divide-gray-100">
        {entries.map((entry) => {
          const isRanked = entry.rank !== null;
          const roiPositive = entry.stats.roi >= 0;
          const accentClass = !isRanked ? "border-gray-100" : roiPositive ? "border-emerald-500" : "border-red-500";

          return (
            <a
              key={entry.capperId}
              href={"/cappers/" + entry.capperId}
              className={
                "flex items-center gap-3 border-l-4 px-4 py-3 transition hover:bg-gray-50 " +
                accentClass +
                (isRanked ? "" : " opacity-50")
              }
            >
              <div className="w-7 shrink-0 text-sm font-semibold text-gray-400">
                {isRanked ? "#" + entry.rank : ""}
              </div>

              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
                style={{ backgroundColor: entry.colorTag ?? "#3B82F6" }}
              >
                {entry.name.slice(0, 2).toUpperCase()}
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{entry.name}</div>
                <div className="text-xs text-gray-500">
                  {entry.totalPicks} pick{entry.totalPicks === 1 ? "" : "s"}
                </div>
              </div>

              {isRanked && <StreakBadge streak={entry.stats.currentStreak} />}

              <div className="w-24 shrink-0 text-right">
                {isRanked ? (
                  <>
                    <div className="text-xs text-gray-500">
                      {entry.stats.wins}-{entry.stats.losses}-{entry.stats.pushes}
                    </div>
                    <div className={"text-sm font-medium " + (roiPositive ? "text-emerald-600" : "text-red-600")}>
                      {roiPositive ? "+" : ""}
                      {entry.stats.roi}%
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-gray-400">Not enough picks yet</div>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
