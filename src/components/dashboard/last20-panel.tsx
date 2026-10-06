"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { LAST20_COLLAPSED_COUNT } from "@/lib/cappers-panels";
import { AlertTriangleIcon, ChevronDownIcon, TargetIcon } from "@/components/dashboard/cappers-icons";
import { CONTROL, FOOTER_LINK, Message, Name, PanelShell, ROW, Rank, TINTS, type PanelTheme } from "@/components/dashboard/panel-shell";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";

const LAST20: Record<"best" | "worst", PanelTheme & { empty: string }> = {
  best: {
    ...TINTS.green,
    title: "Best last 20",
    subtitle: "Strongest recent records",
    icon: <TargetIcon className={ICON} />,
    empty: "No active capper is at 50% or better over their last 20.",
  },
  worst: {
    ...TINTS.red,
    title: "Worst last 20",
    subtitle: "Weakest recent records",
    icon: <AlertTriangleIcon className={ICON} />,
    empty: "No active capper is under 50% over their last 20.",
  },
};

// A row as it is drawn: the record and win % already formatted, the win % in its win / loss color.
export type Last20Row = { capperId: string; name: string; record: string; pct: string; pctClass: string };

function Rows({ rows, first }: { rows: Last20Row[]; first: number }) {
  return rows.map((e, i) => (
    <li key={e.capperId}>
      <Link href={"/cappers/" + e.capperId} className={ROW}>
        <Rank n={first + i} />
        <span className="min-w-0 flex-1">
          <Name>{e.name}</Name>
        </span>
        <span className="shrink-0 whitespace-nowrap text-right text-xs font-medium tabular-nums text-foreground">{e.record}</span>
        <span className={"w-10 shrink-0 text-right text-sm font-semibold tabular-nums " + e.pctClass}>{e.pct}</span>
      </Link>
    </li>
  ));
}

// A ranked list: each capper's record over their last 20 graded picks and its win %. The first
// LAST20_COLLAPSED_COUNT rows always show; "See more" opens the rest in place (they are already here:
// the page's one panels statement returns them all).
export function Last20Panel({ panel, rows, leaderboardHref }: { panel: "best" | "worst"; rows: Last20Row[]; leaderboardHref: string }) {
  const t = LAST20[panel];
  const [open, setOpen] = useState(false);
  // True while the rows are still sliding shut, so the panels grid (dashboard-panels.tsx) keeps its
  // cards at their own heights until this one is back to its collapsed height.
  const [closing, setClosing] = useState(false);
  const moreId = useId();
  const more = rows.slice(LAST20_COLLAPSED_COUNT);

  function toggle() {
    // No transition runs under reduced motion, so no transitionend would ever clear `closing`.
    if (open && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setClosing(true);
    setOpen(!open);
  }

  return (
    <PanelShell
      theme={t}
      control={<span className={CONTROL + " shrink-0 whitespace-nowrap px-2.5 py-[5px] " + t.control}>Last 20 picks</span>}
      footer={
        rows.length > 0 && (
          <>
            {more.length > 0 && (
              <button type="button" onClick={toggle} aria-expanded={open} aria-controls={moreId} className={FOOTER_LINK + " flex h-full items-center gap-1 " + t.accent}>
                {open ? "Show less" : "See more"}
                <ChevronDownIcon className={"h-3.5 w-3.5 stroke-[2.4] transition-transform duration-200 motion-reduce:transition-none " + (open ? "rotate-180" : "")} />
              </button>
            )}
            <Link href={leaderboardHref} className={FOOTER_LINK + " ml-auto " + t.accent}>
              View all →
            </Link>
          </>
        )
      }
    >
      {rows.length === 0 ? (
        <Message>{t.empty}</Message>
      ) : (
        <>
          <ol className="flex flex-col gap-0.5">
            <Rows rows={rows.slice(0, LAST20_COLLAPSED_COUNT)} first={1} />
          </ol>
          {more.length > 0 && (
            // 0fr -> 1fr animates the height without measuring it. Hidden (and so out of the tab
            // order) once shut: `visibility` flips at the start of opening and the end of closing.
            <div
              data-expanded={open || closing}
              onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === "grid-template-rows" && setClosing(false)}
              className={"grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none " + (open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]")}
            >
              <ol id={moreId} start={LAST20_COLLAPSED_COUNT + 1} className="flex min-h-0 flex-col gap-0.5 overflow-hidden pt-0.5">
                <Rows rows={more} first={LAST20_COLLAPSED_COUNT + 1} />
              </ol>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}
