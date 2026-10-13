"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { GlanceCapper } from "@/server/data/picks-glance";
import { TrendingDownIcon, TrophyFilledIcon } from "@/components/dashboard/cappers-icons";
import { FOOTER_TEXT, GREEN, Message, Name, PanelShell, RED, RankChip, TINTS } from "@/components/dashboard/panel-shell";

// The /picks "at a glance" row: the day's cards side by side under a label and a Hide / Show toggle.
// The choice is kept in this browser; a blocked or cleared store just means the row starts open.
const STORE_KEY = "picks:glance-collapsed";

const MUTED = "text-[#5B6275] dark:text-muted-foreground";
// A card row: taller than the panels' ROW, for the second line under the name.
const GLANCE_ROW = "flex min-h-[42px] items-center gap-2.5 rounded-[10px] px-1.5 py-1 transition-colors hover:bg-foreground/[0.035]";

// `columns`: how many cards share the row from 1100px (the cards are always equal columns there).
// Two across from 640px, stacked on a phone.
export function AtAGlance({ label, columns, children }: { label: string; columns: 2 | 3; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORE_KEY) === "1") setCollapsed(true);
    } catch {
      // No storage: stay open.
    }
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORE_KEY, next ? "1" : "0");
    } catch {
      // Not remembered, still toggled.
    }
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{label}</h2>
        <button type="button" aria-expanded={!collapsed} aria-controls="picks-glance" onClick={toggle} className={"shrink-0 whitespace-nowrap text-xs font-semibold hover:text-foreground " + MUTED}>
          {collapsed ? "Show ▼" : "Hide ▲"}
        </button>
      </div>
      {!collapsed && (
        <div id="picks-glance" className={"grid grid-cols-1 gap-3.5 sm:grid-cols-2 " + (columns === 3 ? "min-[1100px]:grid-cols-3" : "")}>
          {children}
        </div>
      )}
    </section>
  );
}

// "+2.0u" / "−2.0u" (a true minus) / "0.0u".
const units = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + "u";

const CAPPER_CARD = {
  winners: { tint: TINTS.green, tone: GREEN, icon: <TrophyFilledIcon className="h-[17px] w-[17px]" />, name: "Winners", subtitle: "Net units on graded picks", empty: "No graded winners yet", from: "top" },
  losers: { tint: TINTS.red, tone: RED, icon: <TrendingDownIcon className="h-[17px] w-[17px] stroke-[2.2]" />, name: "Losers", subtitle: "Biggest net-unit losses", empty: "No losing cappers yet", from: "bottom" },
};

// Winners / Losers: the rows arrive ranked and cut to five (picks-glance.ts). `today`: the card is
// "Today's Winners"; on any other day it is just "Winners".
export function GlanceCapperCard({ kind, rows, today }: { kind: "winners" | "losers"; rows: GlanceCapper[]; today: boolean }) {
  const c = CAPPER_CARD[kind];
  const total = rows.reduce((sum, e) => sum + e.netUnits, 0);
  return (
    <PanelShell
      theme={{ ...c.tint, title: (today ? "Today's " : "") + c.name, subtitle: c.subtitle, icon: c.icon }}
      footer={
        <>
          <span className={"text-[15px] font-semibold leading-none tabular-nums " + c.tone}>{units(total)}</span>
          <p className={FOOTER_TEXT}>{"from " + c.from + " 5"}</p>
        </>
      }
    >
      {rows.length === 0 ? (
        <Message>{c.empty}</Message>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {rows.map((e, i) => (
            <li key={e.capperId} className={GLANCE_ROW}>
              <RankChip n={i + 1} />
              <Link href={"/cappers/" + e.capperId} className="min-w-0 flex-1 hover:underline">
                <Name>{e.name}</Name>
                <span className={"block truncate text-[11px] font-medium leading-tight " + MUTED}>{e.sports.join(" · ")}</span>
              </Link>
              <span className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-foreground">{e.wins + "–" + e.losses + (e.pushes > 0 ? "–" + e.pushes : "")}</span>
              <span className={"w-[58px] shrink-0 text-right text-sm font-semibold tracking-[-0.01em] tabular-nums " + c.tone}>{units(e.netUnits)}</span>
            </li>
          ))}
        </ol>
      )}
    </PanelShell>
  );
}
