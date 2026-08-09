import type { PickCategoryKey } from "@/server/data/stats";

export type BestAtEntry = {
  category: PickCategoryKey;
  label: string;
  capperId: string;
  capperName: string;
  winPct: number;
};

// Top-1 slice of getSportCategoryPanelData's per-category leaderboards (top
// 5, min 3 decided picks) - same underlying data/threshold the Live page's
// clickable category tiles already use, just narrowed to a single name here.
export function BestAtPanel({ entries }: { entries: BestAtEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-card bg-white p-5 shadow-soft">
      <h2 className="mb-3 text-base font-semibold text-gray-900">Best at...</h2>
      <div className="divide-y divide-gray-100">
        {entries.map((entry) => (
          <div key={entry.category} className="flex items-center justify-between py-2 text-sm">
            <span className="text-gray-500">{entry.label}</span>
            <a href={"/cappers/" + entry.capperId} className="font-medium text-gray-900 hover:underline">
              {entry.capperName} &middot; {Math.round(entry.winPct)}%
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
