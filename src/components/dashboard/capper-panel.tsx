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
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CrownIcon,
  FlameFilledIcon,
  ListIcon,
  ShieldCheckIcon,
  SnowflakeIcon,
  TargetIcon,
  TrendingUpIcon,
  TrophyFilledIcon,
  UsersIcon,
} from "@/components/dashboard/cappers-icons";

type AnyPanel = PanelKey | FormPanelKey;

const GREEN = "text-emerald-700 dark:text-emerald-400";
const RED = "text-red-700 dark:text-red-400";

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

// Each panel's own tint: card surface + border, header icon, the dropdown's border, and the footer strip.
const THEME: Record<AnyPanel, { title: string; subtitle: string; card: string; icon: ReactNode; iconWrap: string; subtitleClass: string; control: string; footer: string }> = {
  active: {
    title: "Most Active",
    subtitle: "Who's putting in the work",
    card: "bg-card border-[#DCE3F7] dark:border-brand-500/30",
    icon: <UsersIcon className="h-[22px] w-[22px]" />,
    iconWrap: "rounded-full bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400",
    subtitleClass: "text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    footer: "bg-[#F3F6FF] dark:bg-brand-500/10",
  },
  rising: {
    title: "Rising Fast",
    subtitle: "Momentum is building",
    card: "bg-card border-[#CDEFD9] dark:border-emerald-500/30",
    icon: <TrendingUpIcon className="h-6 w-6" />,
    iconWrap: "rounded-xl bg-[#DCF7E6] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
    subtitleClass: "text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    footer: "bg-[#ECFBF2] dark:bg-emerald-500/10",
  },
  hottest: {
    title: "Hot Hand",
    subtitle: "Current win streaks lighting up",
    card: "bg-[#FFF8F1] border-[#FBD9B8] dark:bg-orange-500/[0.06] dark:border-orange-500/30",
    icon: <FlameFilledIcon className="h-6 w-6" />,
    iconWrap: "rounded-full bg-[#FFE3CC] dark:bg-orange-500/15",
    subtitleClass: "text-[#6B4A2E] dark:text-muted-foreground",
    control: "border-[#F1D3B6] dark:border-border",
    footer: "",
  },
  consistent: {
    title: "Most Consistent",
    subtitle: "Confidence score · last 50 picks",
    card: "bg-[#FBF8FF] border-[#E2D4FB] dark:bg-violet-500/[0.06] dark:border-violet-500/30",
    icon: <TargetIcon className="h-6 w-6" />,
    iconWrap: "rounded-full bg-[#EDE2FF] text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
    subtitleClass: "text-[#5B4E75] dark:text-muted-foreground",
    control: "border-[#E2D4FB] dark:border-border",
    footer: "bg-[#F0E8FF] dark:bg-violet-500/10",
  },
  winners: {
    title: "Biggest Winners",
    subtitle: "Top profit (units won)",
    card: "bg-card border-[#C9EED5] dark:border-emerald-500/30",
    icon: <TrophyFilledIcon className="h-6 w-6" />,
    iconWrap: "rounded-full bg-[#DCF7E6] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
    subtitleClass: "text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    footer: "bg-[#ECFBF2] dark:bg-emerald-500/10",
  },
  coldest: {
    title: "Coldest",
    subtitle: "Who's on a cold streak",
    card: "bg-[#FFF6F6] border-[#F8CFCF] dark:bg-red-500/[0.06] dark:border-red-500/30",
    icon: <SnowflakeIcon className="h-6 w-6" />,
    iconWrap: "rounded-full bg-[#FFE0E0] text-red-600 dark:bg-red-500/15 dark:text-red-400",
    subtitleClass: "text-[#7A3A3A] dark:text-muted-foreground",
    control: "border-[#F3CACA] dark:border-border",
    footer: "bg-[#FFE9E9] dark:bg-red-500/10",
  },
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
function Avatar({ e, size }: { e: { capperId: string; name: string; colorTag: string | null }; size: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-extrabold text-white"
      style={{ backgroundColor: avatarColor(e), width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(e.name)}
    </span>
  );
}

function Rank({ n }: { n: number }) {
  return <span className="w-4 shrink-0 text-[13px] font-extrabold tabular-nums text-foreground">{n + "."}</span>;
}
function Name({ children }: { children: ReactNode }) {
  return <span className="block truncate text-[12.5px] font-extrabold text-foreground">{children}</span>;
}
// `filled` of `total` dots lit, left to right.
function Dots({ filled, total, size, on, off, gap }: { filled: number; total: number; size: number; on: string; off: string; gap: string }) {
  return (
    <span aria-hidden className={"flex shrink-0 " + gap}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={"rounded-full " + (i < filled ? on : off)} style={{ width: size, height: size }} />
      ))}
    </span>
  );
}

const ROW = "flex items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-foreground/[0.04]";
const FOOTER_TEXT = "min-w-0 flex-1 text-[12.5px] font-semibold text-foreground/75";
const FOOTER_LINK = "shrink-0 whitespace-nowrap text-[12.5px] font-bold hover:underline";

function PanelShell({ panel, control, footer, children }: { panel: AnyPanel; control: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const t = THEME[panel];
  return (
    <section className={"flex h-full flex-col rounded-[18px] border p-[18px] shadow-soft " + t.card}>
      <div className="flex items-start gap-3">
        <span className={"flex h-11 w-11 shrink-0 items-center justify-center " + t.iconWrap}>{t.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold leading-snug tracking-tight text-foreground">{t.title}</h2>
          <p className={"text-xs font-semibold " + t.subtitleClass}>{t.subtitle}</p>
        </div>
        {control}
      </div>
      <div className="mt-3.5 flex flex-1 flex-col">{children}</div>
      {footer && <div className={"mt-3 flex items-center gap-2.5 rounded-xl px-3.5 py-[11px] " + t.footer}>{footer}</div>}
    </section>
  );
}

const CONTROL = "rounded-[9px] border bg-card text-xs font-bold text-foreground";

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={"flex flex-1 items-center justify-center py-6 text-center text-sm " + (error ? RED : "text-muted-foreground")}>{children}</p>;
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
          <select
            id={selectId}
            value={win}
            onChange={(e) => change(e.target.value as PanelWindow)}
            className={CONTROL + " cursor-pointer appearance-none py-[7px] pl-2.5 pr-7 " + THEME[panel].control}
          >
            {PANEL_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {PANEL_WINDOW_LABELS[w]}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-[11px] w-[11px] -translate-y-1/2 stroke-[2.6] text-foreground" />
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
    <ol className="flex flex-col gap-0.5">
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link href={capperHref(e.capperId)} className={ROW + " py-[7px]"}>
            <Rank n={i + 1} />
            <Avatar e={e} size={30} />
            <span className="w-[104px] shrink-0 min-[400px]:w-28">
              <Name>{e.name}</Name>
              <span className="block text-[11px] font-semibold tabular-nums text-muted-foreground">
                {e.pickCount} pick{e.pickCount === 1 ? "" : "s"}
              </span>
            </span>
            <span className="h-[9px] min-w-0 flex-1 overflow-hidden rounded-md bg-[#EDF0F6] dark:bg-muted">
              <span className="block h-full rounded-md bg-brand-600" style={{ width: (max > 0 ? (e.pickCount / max) * 100 : 0) + "%" }} />
            </span>
            <span aria-hidden className="min-w-[26px] shrink-0 text-right text-sm font-extrabold tabular-nums text-foreground">
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
      <ListIcon className="h-4 w-4 shrink-0 stroke-[2.2] text-brand-600 dark:text-brand-400" />
      <p className={FOOTER_TEXT}>
        {TOTAL_LABEL[win]}
        <span className="ml-1.5 font-extrabold tabular-nums text-foreground">{(rows[0]?.totalPicks ?? 0).toLocaleString("en-US")}</span>
        {pct !== null && pct !== 0 && <span className={"ml-1.5 whitespace-nowrap font-extrabold " + (pct < 0 ? RED : GREEN)}>{(pct < 0 ? "↓ " : "↑ ") + Math.abs(pct) + "%"}</span>}
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " text-brand-600 dark:text-brand-400"}>
        View all →
      </a>
    </>
  );
}

const STREAK_DOTS = 8;
// #1 is a dark leader card (the same in both themes); the rest are rows with an 8-dot trail.
function HottestRows({ rows }: { rows: StreakEntry[] }) {
  const [lead, ...rest] = rows;
  const lit = Math.min(lead.streak, STREAK_DOTS);
  return (
    <>
      <Link
        href={capperHref(lead.capperId)}
        className="flex items-center gap-2.5 rounded-[14px] border-[1.5px] border-[#E8A33A] bg-[#17130E] px-3 py-3 transition hover:brightness-110 min-[1700px]:gap-3 min-[1700px]:px-3.5"
      >
        <span className="rounded-[9px] border border-[#E8A33A] bg-[#3A2A12] px-2 py-1.5 text-[15px] font-extrabold leading-none text-[#FFC65C]">#1</span>
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-[#FFC65C] bg-[#2A2013] text-[#FFC65C] min-[1700px]:h-12 min-[1700px]:w-12">
          <CrownIcon className="h-[26px] w-[26px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-extrabold tracking-wide text-white">{lead.name}</span>
          <span className="block whitespace-nowrap text-xl font-extrabold leading-[1.1] tabular-nums text-[#FFC65C] min-[1700px]:text-[22px]">{lead.streak} WINS</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="flex items-center gap-1 text-[10px] font-bold text-[#D9CBB4]">
            Current streak
            <FlameFilledIcon className="h-[11px] w-[11px]" />
          </span>
          <span aria-hidden className="flex items-center gap-[3px] min-[1700px]:gap-1">
            {Array.from({ length: lit - 1 }, (_, i) => (
              <span key={i} className="h-2 w-2 rounded-full bg-[#22C55E] min-[1700px]:h-[11px] min-[1700px]:w-[11px]" />
            ))}
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 border-[#22C55E]">
              <span className="h-[7px] w-[7px] rounded-full bg-[#FFC65C]" />
            </span>
          </span>
        </span>
      </Link>
      {rest.length > 0 && (
        <ol start={2} className="mt-2 flex flex-col gap-0.5">
          {rest.map((e, i) => (
            <li key={e.capperId}>
              <Link href={capperHref(e.capperId)} className={ROW + " py-[7px]"}>
                <Rank n={i + 2} />
                <Avatar e={e} size={26} />
                <span className="min-w-0 flex-1">
                  <Name>{e.name}</Name>
                </span>
                <span className="shrink-0 whitespace-nowrap text-right text-xs font-extrabold tabular-nums text-foreground">{e.streak} WINS</span>
                <Dots filled={Math.min(e.streak, STREAK_DOTS)} total={STREAK_DOTS} size={8} gap="gap-[3px]" on="bg-[#22C55E]" off="bg-[#E7D9CB] dark:bg-white/15" />
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-[#8A6A4E] dark:text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

// Rank badge: gold, silver, bronze, then plain.
// Record column: W-L over win % where the panel is narrow, side by side where there is room.
const RECORD_COL = "w-10 min-[1700px]:w-[74px]";
const MEDAL = ["bg-[#F5B301] text-[#3A2A00]", "bg-[#C5CBD6] text-[#1F2633]", "bg-[#D08A4E] text-white"];
function WinnerRows({ rows }: { rows: WinnerEntry[] }) {
  return (
    <>
      <div aria-hidden className="flex items-center gap-2.5 border-b border-border px-1.5 pb-1.5 text-[10px] font-extrabold uppercase tracking-[0.07em] text-muted-foreground">
        <span className="w-[26px]">#</span>
        <span className="flex-1">Capper</span>
        <span className={RECORD_COL}>Record</span>
        <span className="w-[60px] text-right">Units</span>
        <span className="hidden w-11 min-[400px]:block" />
      </div>
      <ol className="mt-1 flex flex-col gap-0.5">
        {rows.map((e, i) => {
          const decided = e.wins + e.losses;
          return (
            <li key={e.capperId} className={ROW + " py-1.5 " + (i === 0 ? "bg-[#F2FBF5] dark:bg-emerald-500/10" : "")}>
              <span className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-extrabold tabular-nums " + (MEDAL[i] ?? "bg-[#EEF0F4] text-foreground dark:bg-muted")}>
                {i + 1}
              </span>
              <Link href={capperHref(e.capperId)} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                <Avatar e={e} size={28} />
                <Name>{e.name}</Name>
              </Link>
              <span className={RECORD_COL + " shrink-0 text-xs font-bold leading-tight tabular-nums text-foreground"}>
                <span className="block min-[1700px]:inline">{e.wins + "-" + e.losses}</span>
                {decided > 0 && <span className="block font-semibold text-muted-foreground min-[1700px]:ml-1 min-[1700px]:inline">{Math.round((e.wins / decided) * 100) + "%"}</span>}
              </span>
              <span className={"w-[60px] shrink-0 text-right text-[17px] font-extrabold tracking-tight tabular-nums " + GREEN}>{units(e.netUnits)}</span>
              <Link
                href={capperHref(e.capperId)}
                aria-label={"View " + e.name}
                className="hidden w-11 shrink-0 rounded-lg bg-[#E3F8EA] py-1.5 text-center text-[11.5px] font-bold text-emerald-700 hover:brightness-95 dark:bg-emerald-500/15 dark:text-emerald-400 min-[400px]:block"
              >
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
      <TrendingUpIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.6] " + GREEN} />
      <span className={"text-[19px] font-extrabold leading-none tabular-nums " + GREEN}>{units(total)}</span>
      <p className={FOOTER_TEXT}>{rows.length >= 5 ? "total profit from top 5" : "total profit from the top " + rows.length}</p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + GREEN}>
        View all →
      </a>
    </>
  );
}

const SKID_DOTS = 5;
function ColdestRows({ rows }: { rows: StreakEntry[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link
            href={capperHref(e.capperId)}
            className={
              "flex items-center gap-2.5 rounded-xl border px-2 py-[7px] transition-colors hover:bg-foreground/[0.04] " +
              (i === 0 ? "border-[#F3B4B4] bg-card dark:border-red-500/40" : "border-transparent")
            }
          >
            <Rank n={i + 1} />
            <Avatar e={e} size={32} />
            <span className="min-w-0 flex-1">
              <Name>{e.name}</Name>
            </span>
            <Dots filled={Math.min(e.streak, SKID_DOTS)} total={SKID_DOTS} size={9} gap="gap-1" on="bg-[#EF4444]" off="bg-[#F6D4D4] dark:bg-white/15" />
            <span className={"min-w-[44px] shrink-0 rounded-lg px-2 py-1 text-center text-[15px] font-extrabold leading-tight tabular-nums text-white " + (i === 0 ? "bg-[#B91C1C]" : "bg-[#DC2626]")}>
              {e.streak}L
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function ColdestFooter({ rows }: { rows: StreakEntry[] }) {
  return (
    <>
      <AlertTriangleIcon className="h-[18px] w-[18px] shrink-0 stroke-[2.2] text-red-700 dark:text-red-400" />
      <p className={FOOTER_TEXT}>
        <b className="font-extrabold text-foreground">{rows[0].name}</b> has the longest skid <b className={"whitespace-nowrap font-extrabold " + RED}>({rows[0].streak}L)</b>
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + RED}>
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
      control={<span className={CONTROL + " shrink-0 whitespace-nowrap px-2.5 py-[7px] " + THEME[panel].control}>{FORM_SUBLABEL[panel]}</span>}
      footer={!ready ? undefined : panel === "rising" ? <RisingFooter rows={rows as RisingEntry[]} /> : <ConsistentFooter rows={rows as ConsistentEntry[]} />}
    >
      {!ready ? <Message>{FORM_EMPTY[panel]}</Message> : panel === "rising" ? <RisingChart rows={rows as RisingEntry[]} /> : <ConsistentRows rows={rows as ConsistentEntry[]} />}
    </PanelShell>
  );
}

// Line colors by rank; the legend dots match.
const LINE_COLORS = ["#16A34A", "#2F54EB", "#F59E0B", "#A855F7", "#06B6D4"];
// Four gridlines covering the series: the smallest step (10 / 20 / 30 / 40 points) that fits.
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
function RisingChart({ rows }: { rows: RisingEntry[] }) {
  const X0 = 30;
  const X1 = 214;
  const Y0 = 12;
  const Y1 = 160;
  const n = Math.max(2, ...rows.map((r) => r.trend.length));
  const { lo, step } = trendAxis(rows.flatMap((r) => r.trend));
  const hi = lo + step * 3;
  const x = (i: number) => X0 + (i / (n - 1)) * (X1 - X0);
  const y = (v: number) => Y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (Y1 - Y0);
  const line = (r: RisingEntry) => r.trend.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
  const lead = rows[0];
  const label =
    "Rolling win rate across the last " + n + " decided picks. " + rows.map((r) => r.name + ": now " + Math.round(r.trend[r.trend.length - 1] ?? 0) + "%, up " + r.pts + " points").join("; ") + ".";
  return (
    <div className="flex flex-1 flex-col items-center gap-2.5 min-[400px]:flex-row">
      <svg viewBox="0 0 220 184" role="img" aria-label={label} className="h-auto w-full min-w-0 flex-1">
        {[0, 1, 2].map((k) => (
          <line key={k} x1={X0} x2={216} y1={Y0 + (k * (Y1 - Y0)) / 3} y2={Y0 + (k * (Y1 - Y0)) / 3} className="stroke-border" strokeDasharray="3 4" />
        ))}
        <line x1={X0} x2={216} y1={Y1} y2={Y1} className="stroke-muted-foreground/50" />
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % 2 === 0)
          .map((i) => (
            <line key={i} x1={x(i)} x2={x(i)} y1={Y0} y2={Y1} className="stroke-border/60" />
          ))}
        {[0, 1, 2, 3].map((k) => (
          <text key={k} x={X0 - 5} y={Y1 - (k * (Y1 - Y0)) / 3 + 3} textAnchor="end" fontSize={9} fontWeight={700} className="fill-muted-foreground">
            {Math.round(lo + k * step) + "%"}
          </text>
        ))}
        <polygon points={line(lead) + " " + x(lead.trend.length - 1).toFixed(1) + "," + Y1 + " " + X0 + "," + Y1} fill={LINE_COLORS[0]} fillOpacity={0.1} />
        {/* Drawn last-to-first so #1 sits on top. */}
        {rows
          .map((r, i) => ({ r, i }))
          .reverse()
          .map(({ r, i }) => (
            <polyline key={r.capperId} points={line(r)} fill="none" stroke={LINE_COLORS[i]} strokeWidth={i === 0 ? 2.6 : 2.4} strokeLinejoin="round" strokeLinecap="round" />
          ))}
        {rows
          .map((r, i) => ({ r, i }))
          .reverse()
          .map(({ r, i }) => {
            const cx = x(r.trend.length - 1);
            const cy = y(r.trend[r.trend.length - 1] ?? lo);
            return i === 0 ? (
              <circle key={r.capperId} cx={cx} cy={cy} r={5} className="fill-card" stroke={LINE_COLORS[0]} strokeWidth={2.6} />
            ) : (
              <circle key={r.capperId} cx={cx} cy={cy} r={3.5} fill={LINE_COLORS[i]} />
            );
          })}
        {/* Picks back from the newest; the last point is the current rolling win %. */}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % 2 === 0 && n - 1 - i > 1)
          .map((i) => (
            <text key={i} x={x(i)} y={Y1 + 18} textAnchor="middle" fontSize={9} fontWeight={700} className="fill-muted-foreground">
              {"−" + (n - 1 - i)}
            </text>
          ))}
        <text x={216} y={Y1 + 18} textAnchor="end" fontSize={9} fontWeight={800} className="fill-foreground">
          Latest
        </text>
      </svg>
      <ol className="flex w-full shrink-0 flex-col justify-center gap-1 min-[400px]:w-[150px]">
        {rows.map((r, i) => (
          <li key={r.capperId}>
            <Link href={capperHref(r.capperId)} className="flex items-center gap-[7px] rounded-lg px-1 py-[5px] transition-colors hover:bg-foreground/[0.04]">
              <span aria-hidden className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
              <span className="min-w-0 flex-1 truncate text-xs font-extrabold text-foreground">{r.name}</span>
              <span className={"whitespace-nowrap text-[12.5px] font-extrabold tabular-nums " + GREEN}>{"+" + r.pts + " pts"}</span>
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
      <TrendingUpIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.6] " + GREEN} />
      <p className={FOOTER_TEXT}>
        <b className="font-extrabold text-foreground">{rows[0].name}</b> is trending up <b className={"whitespace-nowrap font-extrabold " + GREEN}>{"+" + rows[0].pts + " pts"}</b>
      </p>
      <Link href={capperHref(rows[0].capperId)} className="-my-0.5 -mr-1 shrink-0 whitespace-nowrap rounded-lg bg-[#16A34A] px-2.5 py-[7px] text-xs font-bold text-white hover:brightness-95">
        View trend →
      </Link>
    </>
  );
}

const TIER_CLASS: Record<ConsistencyTier, string> = {
  Elite: "bg-[#7C3AED] text-white",
  "Rock Solid": "bg-[#E4D6FF] text-[#5B21B6] dark:bg-violet-500/25 dark:text-violet-200",
  Steady: "bg-[#EFE9FA] text-[#4C3A75] dark:bg-white/10 dark:text-violet-200",
};
const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;
// The block sparkline's fixed band (win %): the same scale on every row, so a steady capper reads flat.
const BAND: [number, number] = [40, 70];

function ConsistentRows({ rows }: { rows: ConsistentEntry[] }) {
  return (
    <ol className="flex flex-col gap-0.5">
      {rows.map((e, i) => {
        const score = consistencyScore(e.sd);
        const tier = consistencyTier(score);
        const pts = e.blocks
          .map((v, k) => ((k * 70) / Math.max(1, e.blocks.length - 1)).toFixed(1) + "," + (26 - ((Math.min(BAND[1], Math.max(BAND[0], v)) - BAND[0]) / (BAND[1] - BAND[0])) * 22 - 2).toFixed(1))
          .join(" ");
        return (
          <li key={e.capperId}>
            <Link href={capperHref(e.capperId)} className={ROW + " py-1.5"}>
              <Rank n={i + 1} />
              <Avatar e={e} size={30} />
              <span className="min-w-0 flex-1">
                <Name>{e.name}</Name>
                <span className={"mt-0.5 inline-block rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase leading-tight tracking-[0.06em] " + TIER_CLASS[tier]}>{tier}</span>
              </span>
              <svg width={70} height={26} viewBox="0 0 70 26" role="img" aria-label={"Win rate per 10-pick block: " + e.blocks.map((v) => Math.round(v) + "%").join(", ")} className="shrink-0 max-[400px]:w-12">
                <line x1={0} x2={70} y1={13} y2={13} strokeDasharray="2 3" className="stroke-[#E2D4FB] dark:stroke-violet-500/30" />
                <polyline points={pts} fill="none" stroke="#22A55B" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="relative h-[42px] w-[42px] shrink-0" role="img" aria-label={"Confidence score " + score + " of 100"}>
                <svg width={42} height={42} viewBox="0 0 42 42" aria-hidden>
                  <circle cx={21} cy={21} r={RING_R} fill="none" strokeWidth={4} className="stroke-[#ECE4FA] dark:stroke-violet-500/20" />
                  <circle cx={21} cy={21} r={RING_R} fill="none" stroke="#7C3AED" strokeWidth={4} strokeLinecap="round" strokeDasharray={((RING_C * score) / 100).toFixed(1) + " " + RING_C.toFixed(1)} transform="rotate(-90 21 21)" />
                </svg>
                <span aria-hidden className="absolute inset-0 flex items-center justify-center text-[13px] font-extrabold tabular-nums text-[#3B1D7A] dark:text-violet-200">
                  {score}
                </span>
              </span>
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-[#8B7AAE] dark:text-muted-foreground" />
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
      <ShieldCheckIcon className="h-[18px] w-[18px] shrink-0 stroke-[2.2] text-violet-600 dark:text-violet-400" />
      <p className={FOOTER_TEXT}>
        <b className="font-extrabold text-foreground">{rows[0].name}</b> is the most reliable capper right now{" "}
        <b className="whitespace-nowrap font-extrabold text-violet-600 dark:text-violet-400">{"(" + score + " · " + consistencyTier(score) + ")"}</b>
      </p>
      <Link href={capperHref(rows[0].capperId)} className={FOOTER_LINK + " text-violet-700 dark:text-violet-400"}>
        Details →
      </Link>
    </>
  );
}
