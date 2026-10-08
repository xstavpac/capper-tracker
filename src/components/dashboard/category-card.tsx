import { getRecordColor } from "@/server/data/stats";
import { GREEN, MUTED, RED } from "@/components/dashboard/stat-card";

// One market's all-time record, shared by /dashboard and /live: W-L-P, the win % in the app's win/loss
// color (getRecordColor) and a thin bar of the same number. A market with no win or loss yet (nothing,
// or pushes only) has no win % to show: a neutral dash and an empty bar, never a red "0%".
// `tinted` (/live) also washes the whole card in that color - soft green with a green border at 50%
// and up, soft red with a red border below - and colors the market name to match; without it
// (/dashboard) the card is the neutral white stat-card surface.
// `onToggle` makes the card a button; `active` rings the one that is open.
// `note` (/live) is one more small line under the record.

// The grid a set of tinted cards sits in (/live's panel and the capper page's market breakdown): two
// across on a phone, up to six from 1500px.
export const CATEGORY_GRID = "grid grid-cols-2 gap-2.5 sm:grid-cols-3 min-[1100px]:grid-cols-4 min-[1500px]:grid-cols-6";

const NEUTRAL ="bg-white shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none";
const TINT = {
  green: "border border-[#A9DFBC] bg-[#EEFAF2] dark:border-emerald-500/45 dark:bg-emerald-500/10",
  red: "border border-[#F0BCBC] bg-[#FFF1F1] dark:border-red-500/45 dark:bg-red-500/10",
};

export function CategoryCard({
  label,
  wins,
  losses,
  pushes,
  winPct,
  graded,
  tinted,
  active,
  onToggle,
  note,
}: {
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  // The number of graded picks behind the record: shown as a small "N graded" line under it.
  graded?: number;
  tinted?: boolean;
  active?: boolean;
  onToggle?: () => void;
  note?: string;
}) {
  const decided = wins + losses > 0;
  const good = getRecordColor(winPct) === "green";
  const tone = good ? GREEN : RED;
  return (
    <div
      role={onToggle ? "button" : undefined}
      tabIndex={onToggle ? 0 : undefined}
      aria-pressed={onToggle ? Boolean(active) : undefined}
      onClick={onToggle}
      onKeyDown={
        onToggle
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }
          : undefined
      }
      className={
        "flex h-full flex-col rounded-2xl px-4 py-[13px] " +
        (tinted && decided ? TINT[good ? "green" : "red"] : NEUTRAL + (tinted ? " border border-[#E6E8EF] dark:border-border" : "")) +
        (active ? " ring-2 ring-brand-500 dark:ring-brand-400" : "") +
        (onToggle ? " cursor-pointer select-none outline-none transition hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:brightness-110" : "")
      }
    >
      <p className={"truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] " + (tinted && decided ? tone : MUTED)}>{label}</p>
      {/* The win % drops under a long record rather than crowding it. */}
      <div className={"mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2 " + (graded === undefined ? "mb-2" : "")}>
        <p className="whitespace-nowrap text-lg font-semibold leading-[1.3] tracking-[-0.02em] tabular-nums text-foreground">{wins + "–" + losses + (pushes > 0 ? "–" + pushes : "")}</p>
        {decided ? (
          <p className={"text-sm font-semibold tabular-nums " + tone}>{Math.round(winPct) + "%"}</p>
        ) : (
          <p className={"text-sm font-semibold " + MUTED}>
            <span aria-hidden>—</span>
            <span className="sr-only">No win rate yet</span>
          </p>
        )}
      </div>
      {graded !== undefined && <p className={"-mt-0.5 text-[11px] font-medium leading-4 tabular-nums " + (note === undefined ? "mb-2 " : "") + MUTED}>{graded} graded</p>}
      {note !== undefined && <p className="mb-2 truncate text-[11px] font-semibold leading-4 tabular-nums text-foreground">{note}</p>}
      {/* Pinned to the bottom, so the bars in a row line up when one card wraps and its neighbour does not. */}
      <div aria-hidden className={"mt-auto h-1 shrink-0 overflow-hidden rounded-md " + (tinted && decided ? "bg-[#0F1420]/[0.08] dark:bg-white/10" : "bg-[#E3E8F5] dark:bg-white/10")}>
        {decided && <div className={"h-full rounded-md " + (good ? "bg-[#22C55E]" : "bg-[#EF4444]")} style={{ width: Math.min(100, Math.max(0, winPct)) + "%" }} />}
      </div>
    </div>
  );
}
