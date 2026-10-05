import { DEFAULT_CHIP_SET, PICK_CATEGORY_LABELS, getRecordColor, type CategoryBreakdownItem } from "@/server/data/stats";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";

// All-time record by market, one stat-style card each: W-L-P, the win % in the app's win/loss color
// (getRecordColor) and a thin bar of the same number. Always the same six markets in the same order
// (DEFAULT_CHIP_SET), so the grid never changes shape: `items` only holds the markets with a decided
// pick, and the rest are drawn at 0-0. A market with no win or loss yet (nothing, or pushes only) has
// no win % to show: a neutral dash and an empty bar, never a red "0%".
// Two across on a phone, three from ~1100px, all six from ~1700px.
export function DashboardCategoryCards({ items }: { items: CategoryBreakdownItem[] }) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return (
    <ul className="grid grid-cols-2 gap-3.5 min-[1100px]:grid-cols-3 min-[1700px]:grid-cols-6">
      {DEFAULT_CHIP_SET.map((key) => {
        const { wins, losses, pushes, winPct } = byKey.get(key) ?? { wins: 0, losses: 0, pushes: 0, winPct: 0 };
        const decided = wins + losses > 0;
        const good = getRecordColor(winPct) === "green";
        return (
          <li key={key} className="rounded-2xl bg-white px-4 py-[13px] shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none">
            <p className={"truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED}>{PICK_CATEGORY_LABELS[key]}</p>
            {/* The win % drops under a long record rather than crowding it. */}
            <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2">
              <p className="whitespace-nowrap text-lg font-semibold leading-[1.3] tracking-[-0.02em] tabular-nums text-foreground">{wins + "–" + losses + (pushes > 0 ? "–" + pushes : "")}</p>
              {decided ? (
                <p className={"text-sm font-semibold tabular-nums " + (good ? GREEN : RED)}>{Math.round(winPct) + "%"}</p>
              ) : (
                <p className={"text-sm font-semibold " + MUTED}>
                  <span aria-hidden>—</span>
                  <span className="sr-only">No win rate yet</span>
                </p>
              )}
            </div>
            <div aria-hidden className="mt-2 h-1 overflow-hidden rounded-md bg-[#E3E8F5] dark:bg-white/10">
              {decided && <div className={"h-full rounded-md " + (good ? "bg-[#22C55E]" : "bg-[#EF4444]")} style={{ width: Math.min(100, Math.max(0, winPct)) + "%" }} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
