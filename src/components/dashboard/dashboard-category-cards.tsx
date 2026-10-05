import type { CSSProperties } from "react";
import { getRecordColor, type CategoryBreakdownItem } from "@/server/data/stats";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";

// All-time record by market, one stat-style card each: W-L-P, the win % in the app's win/loss color
// (getRecordColor) and a thin bar of the same number. Only markets with a decided pick come in, so the
// row is as many across as there are cards (four of them sit 2 x 2 in the middle range).
export function DashboardCategoryCards({ items }: { items: CategoryBreakdownItem[] }) {
  const columns = { "--mid": items.length === 4 ? 2 : Math.min(3, items.length), "--wide": items.length } as CSSProperties;
  return (
    <ul
      style={columns}
      className="grid grid-cols-2 gap-3.5 min-[1100px]:[grid-template-columns:repeat(var(--mid),minmax(0,1fr))] min-[1500px]:[grid-template-columns:repeat(var(--wide),minmax(0,1fr))]"
    >
      {items.map((item) => {
        const good = getRecordColor(item.winPct) === "green";
        return (
          <li key={item.key} className="rounded-2xl bg-white px-4 py-[13px] shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none">
            <p className={"truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED}>{item.label}</p>
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <p className="whitespace-nowrap text-lg font-semibold leading-[1.3] tracking-[-0.02em] tabular-nums text-foreground">
                {item.wins + "–" + item.losses + (item.pushes > 0 ? "–" + item.pushes : "")}
              </p>
              <p className={"text-sm font-semibold tabular-nums " + (good ? GREEN : RED)}>{Math.round(item.winPct) + "%"}</p>
            </div>
            <div aria-hidden className="mt-2 h-1 overflow-hidden rounded-md bg-[#E3E8F5] dark:bg-white/10">
              <div className={"h-full rounded-md " + (good ? "bg-[#22C55E]" : "bg-[#EF4444]")} style={{ width: Math.min(100, Math.max(0, item.winPct)) + "%" }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
