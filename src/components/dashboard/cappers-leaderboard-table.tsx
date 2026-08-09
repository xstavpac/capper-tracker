"use client";

import { useMemo, useState } from "react";
import type { LeaderboardEntry } from "@/server/data/cappers";
import { getRecordColor, RANKING_MIN_SAMPLE } from "@/server/data/stats";
import { Avatar, StreakBadge } from "@/components/dashboard/capper-panels";

type SortKey = "weighted" | "name" | "record" | "winPct" | "roi" | "units";

function decidedCount(stats: LeaderboardEntry["stats"]) {
  return stats.wins + stats.losses + stats.pushes;
}

function windowChipClass(isActive: boolean) {
  return (
    "rounded-full px-3 py-1.5 text-sm font-medium " +
    (isActive ? "bg-brand-600 text-white" : "bg-white text-gray-600 shadow-soft hover:bg-gray-50")
  );
}

// Search lives here (not a separate page-header component) because it only
// ever needs to filter this table - putting it in a genuinely separate
// header component would mean lifting search state into a wrapping client
// component for no other reason than crossing a component boundary.
export function CappersLeaderboardTable({
  weekEntries,
  allTimeEntries,
}: {
  weekEntries: LeaderboardEntry[];
  allTimeEntries: LeaderboardEntry[];
}) {
  const [window, setWindow] = useState<"WEEK" | "ALL">("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("weighted");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  const entries = window === "WEEK" ? weekEntries : allTimeEntries;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  const sorted = useMemo(() => {
    const dir = sortDir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * a.name.localeCompare(b.name);
        case "record":
          return dir * (a.stats.wins - a.stats.losses - (b.stats.wins - b.stats.losses));
        case "winPct":
          return dir * (a.stats.winPct - b.stats.winPct);
        case "roi":
          return dir * (a.stats.roi - b.stats.roi);
        case "units":
          return dir * (a.stats.netUnits - b.stats.netUnits);
        default:
          return dir * (a.weightedScore - b.weightedScore);
      }
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function headerClass(key: SortKey) {
    return (
      "cursor-pointer select-none whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide hover:text-gray-700 " +
      (sortKey === key ? "text-gray-900" : "text-gray-500")
    );
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null;
    return <span className="ml-1">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">Leaderboard</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cappers..."
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 shadow-sm placeholder:text-gray-400 focus:border-brand-400 focus:outline-none"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => setWindow("WEEK")} className={windowChipClass(window === "WEEK")}>
              This week
            </button>
            <button type="button" onClick={() => setWindow("ALL")} className={windowChipClass(window === "ALL")}>
              All time
            </button>
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-400">
          {entries.length === 0 ? "No cappers have picks in this window yet." : "No cappers match your search."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500">#</th>
                <th className={headerClass("name")} onClick={() => toggleSort("name")}>
                  Capper{sortIndicator("name")}
                </th>
                <th className={headerClass("record")} onClick={() => toggleSort("record")}>
                  Record{sortIndicator("record")}
                </th>
                <th className={headerClass("winPct")} onClick={() => toggleSort("winPct")}>
                  Win%{sortIndicator("winPct")}
                </th>
                <th className={headerClass("roi")} onClick={() => toggleSort("roi")}>
                  ROI{sortIndicator("roi")}
                </th>
                <th className={headerClass("units")} onClick={() => toggleSort("units")}>
                  Units{sortIndicator("units")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry, i) => {
                const n = decidedCount(entry.stats);
                const smallSample = n > 0 && n < RANKING_MIN_SAMPLE;
                const color = getRecordColor(entry.stats.winPct);
                return (
                  <tr key={entry.capperId} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-3 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-3">
                      <a href={"/cappers/" + entry.capperId} className="flex flex-wrap items-center gap-2">
                        <Avatar name={entry.name} colorTag={entry.colorTag} size={28} />
                        <span className="font-medium text-gray-900">{entry.name}</span>
                        {entry.specialist && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            {entry.specialist.label}
                          </span>
                        )}
                        {smallSample && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                            {n} pick{n === 1 ? "" : "s"} &middot; small sample
                          </span>
                        )}
                        <StreakBadge streak={entry.stats.currentStreak} compact />
                      </a>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-gray-700">
                      {entry.stats.wins}-{entry.stats.losses}
                      {entry.stats.pushes > 0 ? "-" + entry.stats.pushes : ""}
                    </td>
                    <td className={"px-3 py-3 font-medium " + (color === "green" ? "text-emerald-600" : "text-red-600")}>
                      {Math.round(entry.stats.winPct)}%
                    </td>
                    <td
                      className={
                        "whitespace-nowrap px-3 py-3 font-medium " + (entry.stats.roi >= 0 ? "text-emerald-600" : "text-red-600")
                      }
                    >
                      {entry.stats.roi >= 0 ? "+" : ""}
                      {entry.stats.roi}%
                    </td>
                    <td
                      className={
                        "whitespace-nowrap px-3 py-3 font-medium " +
                        (entry.stats.netUnits >= 0 ? "text-emerald-600" : "text-red-600")
                      }
                    >
                      {entry.stats.netUnits >= 0 ? "+" : ""}
                      {entry.stats.netUnits}u
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
