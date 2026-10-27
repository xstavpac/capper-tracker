import type { ReactNode } from "react";
import { groupTotalsBySide } from "@/lib/pick-team-group";

// The Totals group's pick list, shared by Feed Live's expander
// (game-picks-expander.tsx) and Grid Live's panel (team-picks-panel.tsx): one
// column, with the Over picks and the Under picks as two labelled blocks and a
// rule between them, instead of one list with both sides mixed together. Each
// pick is still its own PickCard row - the caller renders it, so the card and
// its Parlay slip checkbox are exactly what the other groups show.
//
// The tag colors are the ones the category icons already give the two sides
// (sharp-money/category-icons.tsx: sky for Over, indigo for Under).
const TAG_COLOR = {
  OVER: "text-sky-600 dark:text-sky-400",
  UNDER: "text-indigo-600 dark:text-indigo-400",
};

export function TotalsSideList<T extends { pickId: string; betDetail: string; rawBetDetail?: string | null }>({
  picks,
  renderPick,
  sideBadge,
}: {
  picks: T[];
  renderPick: (pick: T) => ReactNode;
  // Set above a side's header (the Heavy Consensus pill); null / absent for none.
  sideBadge?: (side: "OVER" | "UNDER") => ReactNode;
}) {
  const groups = groupTotalsBySide(picks);
  return (
    <div className="divide-y divide-border" data-totals-column="">
      {groups.map((group) => (
        <div
          key={group.side ?? "NONE"}
          role="group"
          aria-label={group.label ?? "Other totals"}
          data-total-side={group.side ?? "NONE"}
          className="py-2.5 first:pt-0 last:pb-0"
        >
          {group.side && sideBadge?.(group.side)}
          {group.side && (
            <div className="mb-1.5 flex items-center gap-1.5 px-1">
              <span
                className={"flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-muted text-[10px] font-bold leading-none " + TAG_COLOR[group.side]}
                aria-hidden="true"
              >
                {group.tag}
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">{group.label}</span>
              <span className="text-[11px] text-muted-foreground">
                &mdash; {group.picks.length} pick{group.picks.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
          <div className="space-y-1.5">{group.picks.map((p) => renderPick(p))}</div>
        </div>
      ))}
    </div>
  );
}
