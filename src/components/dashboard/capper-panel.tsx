"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_PANEL_WINDOW,
  PANEL_WINDOWS,
  PANEL_WINDOW_LABELS,
  type PanelKey,
  type PanelRows,
  type PanelWindow,
} from "@/lib/cappers-panels";
import type { ActivityEntry } from "@/server/data/cappers";
import type { ConsistentEntry, FormPanelKey, RisingEntry, StreakEntry, WinnerEntry } from "@/lib/cappers-panels";
import { ArrowDownIcon, ArrowUpIcon } from "@/components/dashboard/cappers-icons";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";

const TITLES: Record<PanelKey | FormPanelKey, string> = {
  active: "Most active",
  hottest: "Hot Hand",
  winners: "Biggest winners",
  coldest: "Coldest",
  rising: "Rising Fast",
  consistent: "Most Consistent",
};
// What each window reads in the empty-state sentence ("... this week").
const WINDOW_PHRASE: Record<PanelWindow, string> = { today: "today", week: "this week", "30d": "in the last 30 days" };
const EMPTY: Record<PanelKey, (w: PanelWindow) => string> = {
  active: (w) => "No picks logged " + WINDOW_PHRASE[w] + " yet.",
  hottest: (w) => "No cappers on a 3+ game win streak " + WINDOW_PHRASE[w] + ".",
  winners: (w) => "No cappers in the green " + WINDOW_PHRASE[w] + ".",
  coldest: (w) => "No cappers on a 3+ game losing streak " + WINDOW_PHRASE[w] + ".",
};
const FORM_EMPTY: Record<FormPanelKey, string> = {
  rising: "Nobody is outperforming their usual form yet.",
  consistent: "No capper has 50 decided picks with a steady 50%+ record yet.",
};
// Windowless panels say what they read, in words (no numbers per row).
const FORM_SUBLABEL: Record<FormPanelKey, string> = { rising: "Last 10 vs prior 90", consistent: "Last 50 picks" };
const HEADER_ICON_CLASS: Record<PanelKey | FormPanelKey, string> = {
  active: "bg-brand-600/10 text-brand-600",
  hottest: "bg-orange-500/10 text-orange-500",
  winners: "bg-emerald-500/10 " + GREEN,
  coldest: "bg-sky-500/10 text-sky-500",
  rising: "bg-emerald-500/10 " + GREEN,
  consistent: "bg-violet-500/10 text-violet-500",
};

const units = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";

// One panel of the /cappers 2x2 grid. It renders the server-fetched "This week" rows first; changing
// its window dropdown fetches ONLY this panel (GET /api/cappers/panel), never the whole page. Fetched
// windows are kept in memory so flipping back is free.
export function CapperPanel({ panel, icon, initial }: { panel: PanelKey; icon: ReactNode; initial: PanelRows }) {
  const [win, setWin] = useState<PanelWindow>(DEFAULT_PANEL_WINDOW);
  const [rows, setRows] = useState<PanelRows>(initial);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const cache = useRef(new Map<PanelWindow, PanelRows>([[DEFAULT_PANEL_WINDOW, initial]]));
  const abort = useRef<AbortController | null>(null);

  // A new server render (time tab, filter or navigation) hands down fresh "This week" rows.
  useEffect(() => {
    cache.current = new Map([[DEFAULT_PANEL_WINDOW, initial]]);
    setRows(initial);
    setWin(DEFAULT_PANEL_WINDOW);
    setState("idle");
  }, [initial]);

  useEffect(() => () => abort.current?.abort(), []);

  async function change(next: PanelWindow) {
    setWin(next);
    abort.current?.abort();
    const hit = cache.current.get(next);
    if (hit) {
      setRows(hit);
      setState("idle");
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setState("loading");
    try {
      const res = await fetch("/api/cappers/panel?panel=" + panel + "&window=" + next, { signal: ctl.signal });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { rows: PanelRows };
      cache.current.set(next, body.rows);
      setRows(body.rows);
      setState("idle");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState("error");
    }
  }

  const selectId = "panel-window-" + panel;
  return (
    <PanelShell
      panel={panel}
      icon={icon}
      control={
        <div>
          <label htmlFor={selectId} className="sr-only">
            {TITLES[panel] + " time window"}
          </label>
          <select
            id={selectId}
            value={win}
            onChange={(e) => change(e.target.value as PanelWindow)}
            className="rounded-lg border border-border bg-card px-2 py-1 text-xs font-medium text-foreground"
          >
            {PANEL_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {PANEL_WINDOW_LABELS[w]}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <div className={state === "loading" ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={state === "loading"}>
        {state === "error" ? (
          <p className="py-4 text-center text-sm text-red-600 dark:text-red-400">Couldn&apos;t load this panel. Try another window or refresh.</p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{EMPTY[panel](win)}</p>
        ) : (
          <ol className="space-y-2.5">
            {panel === "active" && <ActiveRows rows={rows as ActivityEntry[]} />}
            {panel === "hottest" && <HottestRows rows={rows as StreakEntry[]} />}
            {panel === "winners" && <WinnerRows rows={rows as WinnerEntry[]} />}
            {panel === "coldest" && <ColdestRows rows={rows as StreakEntry[]} />}
          </ol>
        )}
      </div>
    </PanelShell>
  );
}

function PanelShell({ panel, icon, control, children }: { panel: PanelKey | FormPanelKey; icon: ReactNode; control?: ReactNode; children: ReactNode }) {
  const sublabel = panel === "rising" || panel === "consistent" ? FORM_SUBLABEL[panel] : null;
  return (
    <div className="h-full rounded-card border border-border bg-card p-4 sm:p-5">
      <div className={"flex items-center justify-between gap-3 " + (sublabel ? "mb-1" : "mb-3")}>
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-foreground">
          <span className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-lg " + HEADER_ICON_CLASS[panel]}>{icon}</span>
          <span className="truncate">{TITLES[panel]}</span>
        </h2>
        {control}
      </div>
      {sublabel && <p className="mb-3 pl-9 text-xs text-muted-foreground">{sublabel}</p>}
      {children}
    </div>
  );
}

// Rising Fast / Most Consistent: windowless (no dropdown, no fetch) - the server renders the rows once.
export function FormPanel({ panel, icon, rows }: { panel: FormPanelKey; icon: ReactNode; rows: RisingEntry[] | ConsistentEntry[] }) {
  return (
    <PanelShell panel={panel} icon={icon}>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{FORM_EMPTY[panel]}</p>
      ) : (
        <ol className="space-y-2.5">
          {panel === "rising" ? <RisingRows rows={rows as RisingEntry[]} /> : <ConsistentRows rows={rows as ConsistentEntry[]} />}
        </ol>
      )}
    </PanelShell>
  );
}

// Bar rows: rank, name, bar, value. No-bar rows: rank, name, value.
const BAR_ROW = "grid grid-cols-[1.25rem_minmax(0,6rem)_1fr_auto] items-center gap-2 text-sm hover:opacity-80 sm:grid-cols-[1.5rem_minmax(7rem,10rem)_1fr_auto] sm:gap-3";
const PLAIN_ROW = "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 text-sm hover:opacity-80 sm:grid-cols-[1.5rem_minmax(0,1fr)_auto] sm:gap-3";

function Rank({ n }: { n: number }) {
  return <span className="text-right tabular-nums text-muted-foreground">{n + "."}</span>;
}
function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <span className="h-2 overflow-hidden rounded-full bg-muted">
      <span className={"block h-full rounded-full " + className} style={{ width: pct + "%" }} />
    </span>
  );
}

function ActiveRows({ rows }: { rows: ActivityEntry[] }) {
  const max = rows[0]?.pickCount ?? 0;
  return (
    <>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={"/cappers/" + e.capperId} className={BAR_ROW}>
            <Rank n={i + 1} />
            <span className="truncate font-medium text-foreground">{e.name}</span>
            <Bar pct={max > 0 ? (e.pickCount / max) * 100 : 0} className="bg-brand-600" />
            <span className="text-right text-muted-foreground">
              {e.pickCount} pick{e.pickCount === 1 ? "" : "s"}
            </span>
          </Link>
        </li>
      ))}
    </>
  );
}

function HottestRows({ rows }: { rows: StreakEntry[] }) {
  const max = rows[0]?.streak ?? 0;
  return (
    <>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={"/cappers/" + e.capperId} className={BAR_ROW}>
            <Rank n={i + 1} />
            <span className="truncate font-medium text-foreground">{e.name}</span>
            <Bar pct={max > 0 ? (e.streak / max) * 100 : 0} className="bg-emerald-500" />
            <span className={"whitespace-nowrap text-right font-medium " + GREEN}>{e.streak + "-game win streak"}</span>
          </Link>
        </li>
      ))}
    </>
  );
}

function WinnerRows({ rows }: { rows: WinnerEntry[] }) {
  return (
    <>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={"/cappers/" + e.capperId} className={PLAIN_ROW}>
            <Rank n={i + 1} />
            <span className="truncate font-medium text-foreground">{e.name}</span>
            <span className={"flex items-center gap-1 font-medium " + GREEN}>
              <ArrowUpIcon className="h-3.5 w-3.5" />
              {units(e.netUnits)}
            </span>
          </Link>
        </li>
      ))}
    </>
  );
}

function ColdestRows({ rows }: { rows: StreakEntry[] }) {
  return (
    <>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={"/cappers/" + e.capperId} className={PLAIN_ROW}>
            <Rank n={i + 1} />
            <span className="truncate font-medium text-foreground">{e.name}</span>
            <span className={"flex items-center gap-1 whitespace-nowrap font-medium " + RED}>
              <ArrowDownIcon className="h-3.5 w-3.5" />
              {e.streak + "-game losing streak"}
            </span>
          </Link>
        </li>
      ))}
    </>
  );
}

// A plain polyline through real values, left to right. `domain` fixes the vertical scale (Most
// Consistent uses 0-100 on every row so flat vs jagged compares); omit it to fit the series.
function Spark({ values, domain, className, dots, label }: { values: number[]; domain?: [number, number]; className: string; dots?: boolean; label: string }) {
  const W = 100;
  const H = 24;
  const pad = 3;
  const min = domain ? domain[0] : Math.min(...values);
  const max = domain ? domain[1] : Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, max === min ? H / 2 : H - pad - ((v - min) / span) * (H - pad * 2)] as const);
  return (
    <svg viewBox={"0 0 " + W + " " + H} preserveAspectRatio="none" width="100%" height={H} role="img" aria-label={label} className={className}>
      <polyline points={pts.map(([x, y]) => x.toFixed(2) + "," + y.toFixed(2)).join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {dots && pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={1.6} fill="currentColor" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

// Recent form: running (wins - losses) over the last 10 decided picks, oldest first, from 0.
function RisingRows({ rows }: { rows: RisingEntry[] }) {
  return (
    <>
      {rows.map((e, i) => {
        let run = 0;
        const series = [0, ...e.form.map((w) => (run += w ? 1 : -1))];
        return (
          <li key={e.capperId}>
            <Link href={"/cappers/" + e.capperId} className={BAR_ROW}>
              <Rank n={i + 1} />
              <span className="truncate font-medium text-foreground">{e.name}</span>
              <Spark values={series} className={GREEN} label={e.name + " last 10 decided picks"} />
              <span className={"flex items-center " + GREEN}>
                <ArrowUpIcon className="h-3.5 w-3.5" />
              </span>
            </Link>
          </li>
        );
      })}
    </>
  );
}

// One point per 10-pick block (win %), oldest first, on a fixed 0-100% scale.
function ConsistentRows({ rows }: { rows: ConsistentEntry[] }) {
  return (
    <>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={"/cappers/" + e.capperId} className={BAR_ROW}>
            <Rank n={i + 1} />
            <span className="truncate font-medium text-foreground">{e.name}</span>
            <Spark values={e.blocks} domain={[0, 100]} dots className="text-violet-500" label={e.name + " win rate per 10-pick block, last 50 picks"} />
            <span aria-hidden className="w-3.5" />
          </Link>
        </li>
      ))}
    </>
  );
}
