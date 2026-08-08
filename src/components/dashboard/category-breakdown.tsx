import type { CategoryBreakdownItem } from "@/server/data/stats";

const ACCENT_CLASSES: Record<CategoryBreakdownItem["tone"], string> = {
  positive: "border-emerald-500",
  negative: "border-red-500",
  neutral: "border-gray-200",
};

const TONE_TEXT: Record<CategoryBreakdownItem["tone"], string> = {
  positive: "text-emerald-600",
  negative: "text-red-600",
  neutral: "text-gray-400",
};

// All-time record by pick category (favorite/underdog, over/under, spread,
// F5 ML, NRFI) - answers "am I better off following favorites or dogs,
// overs or unders" at a glance. Left-edge accent (same convention as the
// Cappers ranked list) instead of the plain scorecard tile style, since this
// is meant to carry more visual weight on the Dashboard.
export function CategoryBreakdown({ items }: { items: CategoryBreakdownItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.key}
          className={"rounded-card border-l-4 bg-white p-3 shadow-soft " + ACCENT_CLASSES[item.tone]}
        >
          <div className="text-xs text-gray-500">{item.label}</div>
          <div className="mt-1 text-sm font-medium text-gray-900">
            {item.wins}-{item.losses}
            {item.pushes > 0 ? "-" + item.pushes : ""}
          </div>
          <div className={"mt-0.5 text-sm font-semibold " + TONE_TEXT[item.tone]}>{Math.round(item.winPct)}%</div>
        </div>
      ))}
    </div>
  );
}
