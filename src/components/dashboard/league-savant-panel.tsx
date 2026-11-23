"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { SAVANT_COLLAPSED_COUNT, SAVANT_TREND_DAYS, defaultSavantLeague, savantChoiceKey, type LeagueSavant, type SavantRow } from "@/lib/league-savant";
import { AwardIcon, ChevronDownIcon, CrownIcon } from "@/components/dashboard/cappers-icons";
import { CONTROL, FOOTER_LINK, GREEN, Message, PanelShell, RED, type PanelTint } from "@/components/dashboard/panel-shell";

// The card's own blue: a shade cooler than TINTS.blue, with a square icon tile.
const TINT: PanelTint = {
  card: "bg-[#F5F8FF] border-[#DCE5FB] dark:bg-brand-500/[0.06] dark:border-brand-500/30",
  iconWrap: "rounded-lg bg-[#E0E8FF] text-[#2563EB] dark:bg-brand-500/15 dark:text-brand-400",
  subtitleClass: "text-[#64748B] dark:text-muted-foreground",
  control: "border-[#DADDE5] dark:border-border",
  accent: "text-[#1D4ED8] dark:text-brand-400",
};
const MUTED = "text-[#64748B] dark:text-muted-foreground";
const PICKS = "text-[#475569] dark:text-foreground/70";
// The numeric columns, right-aligned; the gap closes with ROW's in the narrow three-column range.
const GRID = "flex items-center gap-2.5 px-1.5 min-[1500px]:max-[1699px]:gap-1.5";
const RANK_COL = "w-5 shrink-0";
const UNITS_COL = "w-[58px] shrink-0 text-right";
const PICKS_COL = "w-9 shrink-0 text-right";
const SCORE_COL = "w-10 shrink-0 text-right";

const units = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";
const unitsClass = (n: number) => (n < 0 ? RED : GREEN);

function Rows({ rows, first }: { rows: SavantRow[]; first: number }) {
  return rows.map((e, i) => {
    const rank = first + i;
    const lead = rank === 1;
    return (
      <li key={e.capperId}>
        <Link
          href={"/cappers/" + e.capperId}
          className={GRID + " rounded-[10px] transition " + (lead ? "h-11 bg-[#FFF7E0] hover:brightness-[0.98] dark:bg-amber-500/10 dark:hover:brightness-110" : "h-[34px] hover:bg-foreground/[0.035]")}
        >
          {lead ? (
            <span className={RANK_COL + " text-[#B7791F] dark:text-amber-400"}>
              <CrownIcon className="h-[17px] w-[17px]" />
              <span className="sr-only">1.</span>
            </span>
          ) : (
            <span className={RANK_COL + " text-[13px] font-semibold tabular-nums " + MUTED}>{rank + "."}</span>
          )}
          <span className="min-w-0 flex-1">
            <span className={"block truncate text-sm leading-tight text-foreground " + (lead ? "font-bold" : "font-medium")}>{e.name}</span>
            {lead && (
              <span className={"block truncate text-[11.5px] font-semibold leading-tight tabular-nums " + (e.last30Units === null ? MUTED : unitsClass(e.last30Units))}>
                {e.last30Units === null ? "No picks last " + SAVANT_TREND_DAYS + " days" : units(e.last30Units) + " last " + SAVANT_TREND_DAYS}
              </span>
            )}
          </span>
          <span className={UNITS_COL + " text-sm font-semibold tabular-nums " + unitsClass(e.units)}>{units(e.units)}</span>
          <span className={PICKS_COL + " text-[13px] font-medium tabular-nums " + PICKS}>{e.picks}</span>
          <span className={SCORE_COL + " text-sm tabular-nums " + (lead ? "font-extrabold text-[#92400E] dark:text-amber-300" : "font-bold text-[#1D4ED8] dark:text-brand-400")}>{e.score}</span>
        </Link>
      </li>
    );
  });
}

// A ranked table of one league's best cappers this season. Every league's rows are already here (the
// page's one panels statement), so the dropdown only swaps what is shown. The league shown by
// default steps through the in-season leagues one per Eastern day (`dateKey`), the same for every
// viewer; a viewer's own pick is remembered until that day ends.
// `filterable`: the leagues the leaderboard's league filter accepts.
export function LeagueSavantPanel({ savant, dateKey, filterable, leaderboardHref }: { savant: LeagueSavant; dateKey: string; filterable: string[]; leaderboardHref: string }) {
  const names = savant.leagues.map((l) => l.league);
  const rotation = defaultSavantLeague(names, dateKey);
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const selectId = useId();
  const moreId = useId();
  const tipId = useId();

  // After hydration, so the server's markup (the day's league) is what the client first renders.
  useEffect(() => {
    try {
      setChosen(window.localStorage.getItem(savantChoiceKey(dateKey)));
    } catch {}
  }, [dateKey]);

  function choose(league: string) {
    setChosen(league);
    try {
      window.localStorage.setItem(savantChoiceKey(dateKey), league);
    } catch {}
  }

  const league = chosen !== null && names.includes(chosen) ? chosen : rotation;
  const rows = savant.leagues.find((l) => l.league === league)?.rows ?? [];
  const more = rows.slice(SAVANT_COLLAPSED_COUNT);
  const tip = "Percentile among tracked " + (league ?? "league") + " cappers this season, adjusted for sample size.";
  const href = league !== null && filterable.includes(league) ? "/cappers?league=" + encodeURIComponent(league) + "#leaderboard" : leaderboardHref;

  return (
    <PanelShell
      theme={{ ...TINT, title: "League Savant", subtitle: league === null ? "Best cappers this season" : "Best " + league + " cappers this season", icon: <AwardIcon className="h-[17px] w-[17px] stroke-[2.2]" /> }}
      control={
        league !== null && (
          <div className="relative shrink-0">
            <label htmlFor={selectId} className="sr-only">
              League Savant league
            </label>
            <select id={selectId} value={league} onChange={(e) => choose(e.target.value)} className={CONTROL + " cursor-pointer appearance-none py-[5px] pl-2.5 pr-7 " + TINT.control}>
              {names.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-[11px] w-[11px] -translate-y-1/2 stroke-[2.6] text-foreground" />
          </div>
        )
      }
      footer={
        rows.length > 0 && (
          <>
            {more.length > 0 && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={moreId} className={FOOTER_LINK + " flex h-full items-center gap-1 " + TINT.accent}>
                {open ? "Show less" : "See more"}
                <ChevronDownIcon className={"h-3.5 w-3.5 stroke-[2.4] transition-transform duration-200 motion-reduce:transition-none " + (open ? "rotate-180" : "")} />
              </button>
            )}
            <Link href={href} className={FOOTER_LINK + " ml-auto " + TINT.accent}>
              View all →
            </Link>
          </>
        )
      }
    >
      {league === null ? (
        <Message>No league is in season right now.</Message>
      ) : rows.length === 0 ? (
        <Message>{"No " + league + " picks this season yet."}</Message>
      ) : (
        <>
          <div className={GRID + " border-b border-[#0F1420]/[0.08] pb-[5px] text-[10px] font-bold uppercase leading-none tracking-[0.08em] dark:border-white/10 " + MUTED}>
            <span aria-hidden className={RANK_COL} />
            <span className="min-w-0 flex-1">Capper</span>
            <span className={UNITS_COL}>Units</span>
            <span className={PICKS_COL}>Picks</span>
            {/* The tip opens on hover and on keyboard focus, above the header and inside the card's right edge. */}
            <span tabIndex={0} aria-describedby={tipId} className={SCORE_COL + " group relative cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-400"}>
              <span className="underline decoration-dotted underline-offset-2">Score</span>
              <span
                id={tipId}
                role="tooltip"
                className="pointer-events-none invisible absolute bottom-full right-0 z-10 mb-1.5 w-[210px] rounded-lg bg-[#0F172A] px-2.5 py-2 text-left text-[11px] font-medium normal-case leading-snug tracking-normal text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 motion-reduce:transition-none dark:bg-[#1E293B]"
              >
                {tip}
              </span>
            </span>
          </div>
          <ol className="mt-1 flex flex-col gap-0.5">
            <Rows rows={rows.slice(0, SAVANT_COLLAPSED_COUNT)} first={1} />
          </ol>
          {more.length > 0 && (
            // The Best / Worst last 20 expand (last20-panel.tsx): 0fr -> 1fr animates the height
            // without measuring it, and the rows are hidden (out of the tab order) once shut.
            <div className={"grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none " + (open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]")}>
              <ol id={moreId} start={SAVANT_COLLAPSED_COUNT + 1} className="flex min-h-0 flex-col gap-0.5 overflow-hidden pt-0.5">
                <Rows rows={more} first={SAVANT_COLLAPSED_COUNT + 1} />
              </ol>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}
