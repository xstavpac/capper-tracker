import { getRecordColor, type CategoryBreakdownItem } from "@/server/data/stats";

const CARD_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "bg-emerald-100",
  red: "bg-red-100",
};
const TEXT_CLASSES: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "text-emerald-700",
  red: "text-red-700",
};

// All-time record by pick category (favorite/underdog, over/under, spread,
// F5 ML, NRFI) - answers "am I better off following favorites or dogs,
// overs or unders" at a glance. Filled tint background (not a left-edge
// accent) so the win/loss lean reads at a glance without a legend.
export function CategoryBreakdown({ items }: { items: CategoryBreakdownItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-fr sm:grid-rows-2">
      {items.map((item) => {
        const color = getRecordColor(item.winPct);
        return (
          <div key={item.key} className={"rounded-card p-3 " + CARD_CLASSES[color]}>
            <div className={"text-xs " + TEXT_CLASSES[color]}>{item.label}</div>
            <div className="mt-1 text-sm font-medium text-gray-900">
              {item.wins}-{item.losses}
              {item.pushes > 0 ? "-" + item.pushes : ""}
            </div>
            <div className={"mt-0.5 text-sm font-semibold " + TEXT_CLASSES[color]}>
              {Math.round(item.winPct)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}
