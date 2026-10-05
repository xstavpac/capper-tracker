"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_PANEL_WINDOW,
  PANEL_WINDOWS,
  PANEL_WINDOW_LABELS,
  consistencyScore,
  consistencyTier,
  type ActiveEntry,
  type ConsistencyTier,
  type ConsistentEntry,
  type FormPanelKey,
  type PanelKey,
  type PanelRows,
  type PanelWindow,
  type RisingEntry,
  type StreakEntry,
  type WinnerEntry,
} from "@/lib/cappers-panels";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CrownIcon,
  FlameIcon,
  SnowflakeIcon,
  TargetIcon,
  TrendingUpIcon,
  TrophyIcon,
  UsersIcon,
} from "@/components/dashboard/cappers-icons";

type AnyPanel = PanelKey | FormPanelKey;

const GREEN = "text-emerald-600 dark:text-emerald-400";
const RED = "text-red-600 dark:text-red-400";
const LINK = "text-brand-600 hover:underline dark:text-brand-400";

// What each window reads in a sentence ("... this week").
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
// Windowless panels say what they read where the others have their window dropdown.
const FORM_SUBLABEL: Record<FormPanelKey, string> = { rising: "Last 10 vs prior 90", consistent: "Last 50 picks" };

// Every panel is the same neutral card; only the small header icon carries a tint.
const ICON = "h-4 w-4 stroke-[1.75]";
const THEME: Record<AnyPanel, { title: string; subtitle: string; icon: ReactNode; iconWrap: string }> = {
  active: { title: "Most Active", subtitle: "Who's putting in the work", icon: <UsersIcon className={ICON} />, iconWrap: "bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400" },
  rising: { title: "Rising Fast", subtitle: "Momentum is building", icon: <TrendingUpIcon className={ICON} />, iconWrap: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" },
  hottest: { title: "Hot Hand", subtitle: "Current win streaks", icon: <FlameIcon className={ICON} />, iconWrap: "bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400" },
  consistent: { title: "Most Consistent", subtitle: "Confidence score", icon: <TargetIcon className={ICON} />, iconWrap: "bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400" },
  winners: { title: "Biggest Winners", subtitle: "Top profit (units won)", icon: <TrophyIcon className={ICON} />, iconWrap: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" },
  coldest: { title: "Coldest", subtitle: "Who's on a cold streak", icon: <SnowflakeIcon className={ICON} />, iconWrap: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400" },
};

const units = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";
const capperHref = (id: string) => "/cappers/" + id;
const LEADERBOARD_HREF = "#leaderboard";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const AVATAR_COLORS = ["#2F54EB", "#0F766E", "#B45309", "#7C3AED", "#BE185D", "#1D4ED8", "#15803D", "#9F1239", "#334155", "#C2410C"];
// A capper with no color tag always gets the same color, picked from its id.
function avatarColor(e: { capperId: string; colorTag: string | null }): string {
  if (e.colorTag) return e.colorTag;
  let h = 0;
  for (let i = 0; i < e.capperId.length; i++) h = (h * 31 + e.capperId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
// Two words -> their initials; one word -> its first two characters.
function initials(name: string): string {
  const parts = name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return name.trim().slice(0, 2).toUpperCase();
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}
function Avatar({ e }: { e: { capperId: string; name: string; colorTag: string | null } }) {
  return (
    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: avatarColor(e) }}>
      {initials(e.name)}
    </span>
  );
}

function Rank({ n }: { n: number }) {
  return <span className="w-3.5 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{n}</span>;
}
function Name({ children }: { children: ReactNode }) {
  return <span className="block truncate text-[13px] font-medium text-foreground">{children}</span>;
}
// `filled` of `total` 6px dots lit, left to right.
function Dots({ filled, total, on }: { filled: number; total: number; on: string }) {
  return (
    <span aria-hidden className="flex shrink-0 gap-[3px]">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={"h-1.5 w-1.5 rounded-full " + (i < filled ? on : "bg-foreground/10")} />
      ))}
    </span>
  );
}

// Rows are separated by hairlines (LIST); a row's numbers are NUM.
const LIST = "flex flex-col divide-y divide-border-subtle";
const ROW = "flex items-center gap-2.5 py-2 transition-colors hover:bg-foreground/[0.025]";
const NUM = "text-[13px] font-semibold tabular-nums";
const FOOTER_TEXT = "min-w-0 flex-1 text-[12.5px] text-muted-foreground";
const FOOTER_LINK = "shrink-0 whitespace-nowrap text-[12.5px] font-medium " + LINK;
const STRONG = "font-medium text-foreground";

function PanelShell({ panel, control, footer, children }: { panel: AnyPanel; control: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const t = THEME[panel];
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className={"flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg " + t.iconWrap}>{t.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold leading-tight text-foreground">{t.title}</h2>
          <p className="truncate text-[12.5px] leading-snug text-muted-foreground">{t.subtitle}</p>
        </div>
        {control}
      </div>
      <div className="mt-2.5 flex flex-1 flex-col">{children}</div>
      {footer && <div className="mt-1 flex items-center gap-2.5 border-t border-border-subtle pt-3">{footer}</div>}
    </section>
  );
}

const CONTROL = "rounded-md border border-border bg-card text-xs font-medium text-foreground";

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={"flex flex-1 items-center justify-center py-6 text-center text-[13px] " + (error ? RED : "text-muted-foreground")}>{children}</p>;
}

// ---------------------------------------------------------------------------
// Windowed panels (Most Active, Hot Hand, Biggest Winners, Coldest)
// ---------------------------------------------------------------------------

// It renders the server-fetched "This week" rows first; changing its window dropdown fetches ONLY this
// panel (GET /api/cappers/panel), never the whole page. Fetched windows are kept in memory so flipping
// back is free. `weekPct` (Most Active only): picks this week against last week, in percent.
export function CapperPanel({ panel, initial, weekPct }: { panel: PanelKey; initial: PanelRows; weekPct?: number | null }) {
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
  const ready = state !== "error" && rows.length > 0;
  return (
    <PanelShell
      panel={panel}
      control={
        <div className="relative shrink-0">
          <label htmlFor={selectId} className="sr-only">
            {THEME[panel].title + " time window"}
          </label>
          <select id={selectId} value={win} onChange={(e) => change(e.target.value as PanelWindow)} className={CONTROL + " cursor-pointer appearance-none py-[5px] pl-2 pr-6"}>
            {PANEL_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {PANEL_WINDOW_LABELS[w]}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        </div>
      }
      footer={
        !ready || panel === "hottest" ? undefined : panel === "active" ? (
          <ActiveFooter rows={rows as ActiveEntry[]} win={win} weekPct={weekPct ?? null} />
        ) : panel === "winners" ? (
          <WinnersFooter rows={rows as WinnerEntry[]} />
        ) : (
          <ColdestFooter rows={rows as StreakEntry[]} />
        )
      }
    >
      <div className={"flex flex-1 flex-col transition-opacity " + (state === "loading" ? "opacity-60" : "")} aria-busy={state === "loading"}>
        {state === "error" ? (
          <Message error>Couldn&apos;t load this panel. Try another window or refresh.</Message>
        ) : rows.length === 0 ? (
          <Message>{EMPTY[panel](win)}</Message>
        ) : panel === "active" ? (
          <ActiveRows rows={rows as ActiveEntry[]} />
        ) : panel === "hottest" ? (
          <HottestRows rows={rows as StreakEntry[]} />
        ) : panel === "winners" ? (
          <WinnerRows rows={rows as WinnerEntry[]} />
        ) : (
          <ColdestRows rows={rows as StreakEntry[]} />
        )}
      </div>
    </PanelShell>
  );
}

function ActiveRows({ rows }: { rows: ActiveEntry[] }) {
  const max = rows[0]?.pickCount ?? 0;
  return (
    <ol className={LIST}>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={capperHref(e.capperId)} className={ROW + " py-[5px]"}>
            <Rank n={i + 1} />
            <Avatar e={e} />
            <span className="w-[108px] shrink-0 min-[400px]:w-[124px]">
              <Name>{e.name}</Name>
              <span className="block text-[11.5px] leading-tight tabular-nums text-muted-foreground">
                {e.pickCount} pick{e.pickCount === 1 ? "" : "s"}
              </span>
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.07]">
              <span className="block h-full rounded-full bg-brand-600 dark:bg-brand-500" style={{ width: (max > 0 ? (e.pickCount / max) * 100 : 0) + "%" }} />
            </span>
            <span aria-hidden className={NUM + " min-w-[26px] shrink-0 text-right text-foreground"}>
              {e.pickCount}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

const TOTAL_LABEL: Record<PanelWindow, string> = { today: "Total picks today", week: "Total picks this week", "30d": "Total picks, last 30 days" };
// The window's picks across the whole roster. The change against the week before exists only for
// "This week" (the page's overview number), so the other windows show the total alone.
function ActiveFooter({ rows, win, weekPct }: { rows: ActiveEntry[]; win: PanelWindow; weekPct: number | null }) {
  const pct = win === "week" ? weekPct : null;
  return (
    <>
      <p className={FOOTER_TEXT}>
        {TOTAL_LABEL[win]}
        <span className="ml-1.5 font-semibold tabular-nums text-foreground">{(rows[0]?.totalPicks ?? 0).toLocaleString("en-US")}</span>
        {pct !== null && pct !== 0 && <span className={"ml-1.5 whitespace-nowrap font-semibold tabular-nums " + (pct < 0 ? RED : GREEN)}>{(pct < 0 ? "↓ " : "↑ ") + Math.abs(pct) + "%"}</span>}
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK}>
        View all →
      </a>
    </>
  );
}

const STREAK_DOTS = 8;
// #1 is a slim dark leader card (the same in both themes); the rest are rows with an 8-dot trail.
function HottestRows({ rows }: { rows: StreakEntry[] }) {
  const [lead, ...rest] = rows;
  const lit = Math.min(lead.streak, STREAK_DOTS);
  return (
    <>
      <Link href={capperHref(lead.capperId)} className="mb-1 flex items-center gap-2.5 rounded-lg border border-white/10 bg-[#15171C] px-3 py-2.5 transition hover:bg-[#1B1E24] dark:bg-black/30 dark:hover:bg-black/40">
        <span className="rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300">#1</span>
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400/10 text-amber-300">
          <CrownIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{lead.name}</span>
          <span className="block whitespace-nowrap text-lg font-semibold leading-tight tabular-nums text-amber-300">{lead.streak} WINS</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-[11px] text-white/50">Current streak</span>
          <span aria-hidden className="flex items-center gap-[3px]">
            {Array.from({ length: lit - 1 }, (_, i) => (
              <span key={i} className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            ))}
            <span className="ml-px h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-emerald-400/30" />
          </span>
        </span>
      </Link>
      {rest.length > 0 && (
        <ol start={2} className={LIST}>
          {rest.map((e, i) => (
            <li key={e.capperId}>
              <Link href={capperHref(e.capperId)} className={ROW}>
                <Rank n={i + 2} />
                <Avatar e={e} />
                <span className="min-w-0 flex-1">
                  <Name>{e.name}</Name>
                </span>
                <span className={NUM + " shrink-0 whitespace-nowrap text-right text-foreground"}>
                  {e.streak}
                  <span className="ml-1 text-[11px] font-medium text-muted-foreground">WINS</span>
                </span>
                <Dots filled={Math.min(e.streak, STREAK_DOTS)} total={STREAK_DOTS} on="bg-emerald-500" />
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[1.75] text-muted-foreground/60" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const TH = "text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
function WinnerRows({ rows }: { rows: WinnerEntry[] }) {
  return (
    <>
      <div aria-hidden className={"flex items-center gap-2.5 border-b border-border-subtle pb-1.5 " + TH}>
        <span className="w-3.5">#</span>
        <span className="flex-1">Capper</span>
        <span className="w-[72px]">Record</span>
        <span className="w-[52px] text-right">Units</span>
        <span className="hidden w-8 min-[400px]:block" />
      </div>
      <ol className={LIST}>
        {rows.map((e, i) => {
          const decided = e.wins + e.losses;
          return (
            <li key={e.capperId} className={ROW}>
              <Rank n={i + 1} />
              <Link href={capperHref(e.capperId)} className="flex min-w-0 flex-1 items-center gap-2.5 hover:underline">
                <Avatar e={e} />
                <Name>{e.name}</Name>
              </Link>
              <span className="w-[72px] shrink-0 whitespace-nowrap text-[13px] font-medium tabular-nums text-foreground">
                {e.wins + "-" + e.losses}
                {decided > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{Math.round((e.wins / decided) * 100) + "%"}</span>}
              </span>
              <span className={"w-[52px] shrink-0 text-right text-sm font-semibold tabular-nums " + GREEN}>{units(e.netUnits)}</span>
              <Link href={capperHref(e.capperId)} aria-label={"View " + e.name} className={"hidden w-8 shrink-0 text-right text-[12.5px] font-medium min-[400px]:block " + LINK}>
                View
              </Link>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function WinnersFooter({ rows }: { rows: WinnerEntry[] }) {
  const total = rows.reduce((sum, e) => sum + e.netUnits, 0);
  return (
    <>
      <p className={FOOTER_TEXT}>
        <span className={"mr-1.5 font-semibold tabular-nums " + GREEN}>{units(total)}</span>
        {rows.length >= 5 ? "total profit from top 5" : "total profit from the top " + rows.length}
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK}>
        View all →
      </a>
    </>
  );
}

const SKID_DOTS = 5;
function ColdestRows({ rows }: { rows: StreakEntry[] }) {
  return (
    <ol className={LIST}>
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={capperHref(e.capperId)} className={ROW}>
            <Rank n={i + 1} />
            <Avatar e={e} />
            <span className="min-w-0 flex-1">
              <Name>{e.name}</Name>
            </span>
            <Dots filled={Math.min(e.streak, SKID_DOTS)} total={SKID_DOTS} on="bg-red-500" />
            <span className="min-w-[30px] shrink-0 rounded-md bg-red-50 px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-red-700 dark:bg-red-500/10 dark:text-red-400">{e.streak}L</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function ColdestFooter({ rows }: { rows: StreakEntry[] }) {
  return (
    <>
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> has the longest skid <span className={"whitespace-nowrap font-semibold tabular-nums " + RED}>({rows[0].streak}L)</span>
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK}>
        View all →
      </a>
    </>
  );
}

// ---------------------------------------------------------------------------
// Windowless panels (Rising Fast, Most Consistent)
// ---------------------------------------------------------------------------

// No dropdown and no fetch: the server renders the rows once.
export function FormPanel({ panel, rows }: { panel: FormPanelKey; rows: RisingEntry[] | ConsistentEntry[] }) {
  const ready = rows.length > 0;
  return (
    <PanelShell
      panel={panel}
      control={<span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{FORM_SUBLABEL[panel]}</span>}
      footer={!ready ? undefined : panel === "rising" ? <RisingFooter rows={rows as RisingEntry[]} /> : <ConsistentFooter rows={rows as ConsistentEntry[]} />}
    >
      {!ready ? <Message>{FORM_EMPTY[panel]}</Message> : panel === "rising" ? <RisingChart rows={rows as RisingEntry[]} /> : <ConsistentRows rows={rows as ConsistentEntry[]} />}
    </PanelShell>
  );
}

// Line colors by rank; the legend dots match.
const LINE_COLORS = ["#16A34A", "#2563EB", "#F59E0B", "#A855F7", "#06B6D4"];
// Four gridlines covering the series: the smallest step (10 / 20 / 30 points) that fits, else thirds of 0-100.
function trendAxis(values: number[]): { lo: number; step: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const step of [10, 20, 30]) {
    const lo = Math.min(Math.floor(min / step) * step, 100 - 3 * step);
    if (lo >= 0 && lo <= min && lo + 3 * step >= max) return { lo, step };
  }
  return { lo: 0, step: 100 / 3 };
}

// Each capper's rolling win % (10-pick window) over their last 10 decided picks, oldest to newest.
// The chart spans the card; the legend sits under it.
function RisingChart({ rows }: { rows: RisingEntry[] }) {
  const W = 340;
  const X0 = 30;
  const X1 = W - 6;
  const Y0 = 8;
  const Y1 = 124;
  const n = Math.max(2, ...rows.map((r) => r.trend.length));
  const { lo, step } = trendAxis(rows.flatMap((r) => r.trend));
  const hi = lo + step * 3;
  const x = (i: number) => X0 + (i / (n - 1)) * (X1 - X0);
  const y = (v: number) => Y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (Y1 - Y0);
  const line = (r: RisingEntry) => r.trend.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const lead = rows[0];
  const ranked = rows.map((r, i) => ({ r, i })).reverse(); // drawn last-to-first so #1 sits on top
  const label =
    "Rolling win rate across the last " + n + " decided picks. " + rows.map((r) => r.name + ": now " + Math.round(r.trend[r.trend.length - 1] ?? 0) + "%, up " + r.pts + " points").join("; ") + ".";
  const TICK = "fill-muted-foreground text-[10px] font-medium tabular-nums";
  return (
    <div className="flex flex-1 flex-col gap-2">
      <svg viewBox={"0 0 " + W + " 142"} role="img" aria-label={label} className="h-auto w-full">
        {[0, 1, 2, 3].map((k) => {
          const gy = Y1 - (k * (Y1 - Y0)) / 3;
          return (
            <g key={k}>
              <line x1={X0} x2={X1} y1={gy} y2={gy} className="stroke-border" strokeDasharray={k === 0 ? undefined : "2 3"} />
              <text x={X0 - 6} y={gy + 3.5} textAnchor="end" className={TICK}>
                {Math.round(lo + k * step) + "%"}
              </text>
            </g>
          );
        })}
        <polygon points={line(lead) + " " + x(lead.trend.length - 1).toFixed(1) + "," + Y1 + " " + X0 + "," + Y1} fill={LINE_COLORS[0]} fillOpacity={0.06} />
        {ranked.map(({ r, i }) => (
          <polyline key={r.capperId} points={line(r)} fill="none" stroke={LINE_COLORS[i]} strokeWidth={i === 0 ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {ranked.map(({ r, i }) => {
          const cx = x(r.trend.length - 1);
          const cy = y(r.trend[r.trend.length - 1] ?? lo);
          return i === 0 ? (
            <circle key={r.capperId} cx={cx} cy={cy} r={3.5} className="fill-card" stroke={LINE_COLORS[0]} strokeWidth={2} />
          ) : (
            <circle key={r.capperId} cx={cx} cy={cy} r={2.5} fill={LINE_COLORS[i]} />
          );
        })}
        {/* Picks back from the newest; the last point is the current rolling win %. */}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % 2 === 0 && n - 1 - i > 1)
          .map((i) => (
            <text key={i} x={x(i)} y={139} textAnchor={i === 0 ? "start" : "middle"} className={TICK}>
              {"−" + (n - 1 - i)}
            </text>
          ))}
        <text x={X1} y={139} textAnchor="end" className={TICK}>
          Latest
        </text>
      </svg>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {rows.map((r, i) => (
          <li key={r.capperId} className="min-w-0">
            <Link href={capperHref(r.capperId)} className="flex items-center gap-1.5 py-[3px] hover:underline">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{r.name}</span>
              <span className={"whitespace-nowrap text-xs font-semibold tabular-nums " + GREEN}>{"+" + r.pts + " pts"}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RisingFooter({ rows }: { rows: RisingEntry[] }) {
  return (
    <>
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> is trending up <span className={"whitespace-nowrap font-semibold tabular-nums " + GREEN}>{"+" + rows[0].pts + " pts"}</span>
      </p>
      <Link href={capperHref(rows[0].capperId)} className={FOOTER_LINK}>
        View trend →
      </Link>
    </>
  );
}

const TIER_CLASS: Record<ConsistencyTier, string> = {
  Elite: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  "Rock Solid": "bg-foreground/[0.06] text-foreground/80",
  Steady: "bg-foreground/[0.06] text-muted-foreground",
};
const RING_R = 12;
const RING_C = 2 * Math.PI * RING_R;
// The block sparkline's fixed band (win %): the same scale on every row, so a steady capper reads flat.
const BAND: [number, number] = [40, 70];

function ConsistentRows({ rows }: { rows: ConsistentEntry[] }) {
  return (
    <ol className={LIST}>
      {rows.map((e, i) => {
        const score = consistencyScore(e.sd);
        const tier = consistencyTier(score);
        const pts = e.blocks
          .map((v, k) => ((k * 56) / Math.max(1, e.blocks.length - 1)).toFixed(1) + "," + (20 - ((Math.min(BAND[1], Math.max(BAND[0], v)) - BAND[0]) / (BAND[1] - BAND[0])) * 16 - 2).toFixed(1))
          .join(" ");
        return (
          <li key={e.capperId}>
            <Link href={capperHref(e.capperId)} className={ROW + " py-[5px]"}>
              <Rank n={i + 1} />
              <Avatar e={e} />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{e.name}</span>
                <span className={"shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium " + TIER_CLASS[tier]}>{tier}</span>
              </span>
              <svg width={56} height={20} viewBox="0 0 56 20" role="img" aria-label={"Win rate per 10-pick block: " + e.blocks.map((v) => Math.round(v) + "%").join(", ")} className="w-11 shrink-0">
                <line x1={0} x2={56} y1={10} y2={10} strokeDasharray="2 3" className="stroke-border" />
                <polyline points={pts} fill="none" stroke="#10B981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="relative h-[30px] w-[30px] shrink-0" role="img" aria-label={"Confidence score " + score + " of 100"}>
                <svg width={30} height={30} viewBox="0 0 30 30" aria-hidden>
                  <circle cx={15} cy={15} r={RING_R} fill="none" strokeWidth={2.5} className="stroke-foreground/10" />
                  <circle cx={15} cy={15} r={RING_R} fill="none" stroke="#8B5CF6" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={((RING_C * score) / 100).toFixed(1) + " " + RING_C.toFixed(1)} transform="rotate(-90 15 15)" />
                </svg>
                <span aria-hidden className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-foreground">
                  {score}
                </span>
              </span>
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[1.75] text-muted-foreground/60" />
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function ConsistentFooter({ rows }: { rows: ConsistentEntry[] }) {
  const score = consistencyScore(rows[0].sd);
  return (
    <>
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> is the most reliable capper right now{" "}
        <span className="whitespace-nowrap font-semibold tabular-nums text-foreground">{"(" + score + " · " + consistencyTier(score) + ")"}</span>
      </p>
      <Link href={capperHref(rows[0].capperId)} className={FOOTER_LINK}>
        Details →
      </Link>
    </>
  );
}
