import { DEFAULT_CHIP_SET, PICK_CATEGORY_LABELS, type CategoryBreakdownItem } from "@/server/data/stats";
import { CategoryCard } from "@/components/dashboard/category-card";

// All-time record by market, one neutral card each (see CategoryCard). Always the same six markets in
// the same order (DEFAULT_CHIP_SET), so the grid never changes shape: `items` only holds the markets
// with a decided pick, and the rest are drawn at 0-0.
// Two across on a phone, three from ~1100px, all six from ~1700px.
export function DashboardCategoryCards({ items }: { items: CategoryBreakdownItem[] }) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return (
    <ul className="grid grid-cols-2 gap-3.5 min-[1100px]:grid-cols-3 min-[1700px]:grid-cols-6">
      {DEFAULT_CHIP_SET.map((key) => {
        const { wins, losses, pushes, winPct } = byKey.get(key) ?? { wins: 0, losses: 0, pushes: 0, winPct: 0 };
        return (
          <li key={key}>
            <CategoryCard label={PICK_CATEGORY_LABELS[key]} wins={wins} losses={losses} pushes={pushes} winPct={winPct} />
          </li>
        );
      })}
    </ul>
  );
}
