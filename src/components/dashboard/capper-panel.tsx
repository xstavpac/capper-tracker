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

const GREEN = "text-[#15803D] dark:text-emerald-400";
const RED = "text-[#B91C1C] dark:text-red-400";

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

// Each panel's own hue: a soft card tint + border, the header's icon tile, the subtitle's dark shade,
// the control's border, and the footer's icon + link color. Dark mode keeps a faint wash of the hue.
const ICON = "h-[17px] w-[17px]";
const THEME: Record<AnyPanel, { title: string; subtitle: string; card: string; icon: ReactNode; iconWrap: string; subtitleClass: string; control: string; accent: string }> = {
  active: {
    title: "Most Active",
    subtitle: "Who's putting in the work",
    card: "bg-[#F6F8FF] border-[#E1E7FA] dark:bg-brand-500/[0.06] dark:border-brand-500/30",
    icon: <UsersIcon className={ICON + " stroke-[1.8]"} />,
    iconWrap: "rounded-full bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: "text-brand-600 dark:text-brand-400",
  },
  rising: {
    title: "Rising Fast",
    subtitle: "Momentum is building",
    card: "bg-[#F4FBF7] border-[#D6EFDF] dark:bg-emerald-500/[0.06] dark:border-emerald-500/30",
    icon: <TrendingUpIcon className={ICON + " stroke-[2.4]"} />,
    iconWrap: "rounded-lg bg-[#DCF7E6] text-[#15803D] dark:bg-emerald-500/15 dark:text-emerald-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: GREEN,
  },
  hottest: {
    title: "Hot Hand",
    subtitle: "Current win streaks lighting up",
    card: "bg-[#FFF8F2] border-[#F8E1CC] dark:bg-orange-500/[0.06] dark:border-orange-500/30",
    icon: <FlameFilledIcon className={ICON} />,
    iconWrap: "rounded-full bg-[#FFE3CC] dark:bg-orange-500/15",
    subtitleClass: "text-[#6B4A2E] dark:text-muted-foreground",
    control: "border-[#F1D3B6] dark:border-border",
    accent: "text-[#C2410C] dark:text-orange-400",
  },
  consistent: {
    title: "Most Consistent",
    subtitle: "Confidence score · last 50 picks",
    card: "bg-[#FAF7FF] border-[#E7DDFA] dark:bg-violet-500/[0.06] dark:border-violet-500/30",
    icon: <TargetIcon className={ICON + " stroke-[2.2]"} />,
    iconWrap: "rounded-full bg-[#EDE2FF] text-[#7C3AED] dark:bg-violet-500/15 dark:text-violet-400",
    subtitleClass: "text-[#5B4E75] dark:text-muted-foreground",
    control: "border-[#E2D4FB] dark:border-border",
    accent: "text-[#6D28D9] dark:text-violet-400",
  },
  winners: {
    title: "Biggest Winners",
    subtitle: "Top profit (units won)",
    card: "bg-[#F4FBF7] border-[#D6EFDF] dark:bg-emerald-500/[0.06] dark:border-emerald-500/30",
    icon: <TrophyFilledIcon className={ICON} />,
    iconWrap: "rounded-full bg-[#DCF7E6] text-[#16A34A] dark:bg-emerald-500/15 dark:text-emerald-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: GREEN,
  },
  coldest: {
    title: "Coldest",
    subtitle: "Who's on a cold streak",
    card: "bg-[#FFF7F7] border-[#F6D9D9] dark:bg-red-500/[0.06] dark:border-red-500/30",
    icon: <SnowflakeIcon className={ICON} />,
    iconWrap: "rounded-full bg-[#FFE0E0] text-[#DC2626] dark:bg-red-500/15 dark:text-red-400",
    subtitleClass: "text-[#7A3A3A] dark:text-muted-foreground",
    control: "border-[#F3CACA] dark:border-border",
    accent: RED,
  },
};

const units = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";
const capperHref = (id: string) => "/cappers/" + id;
const LEADERBOARD_HREF = "#leaderboard";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const AVATAR_COLORS = ["#2563EB", "#0F766E", "#B45309", "#7C3AED", "#BE185D", "#1D4ED8", "#15803D", "#9F1239", "#334155", "#C2410C"];
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
function Avatar({ e, size = 24 }: { e: { capperId: string; name: string; colorTag: string | null }; size?: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: avatarColor(e), width: size, height: size }}>
      {initials(e.name)}
    </span>
  );
}

function Rank({ n }: { n: number }) {
  return <span className="w-4 shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{n + "."}</span>;
}
function Name({ children }: { children: ReactNode }) {
  return <span className="block truncate text-[12.5px] font-semibold text-foreground">{children}</span>;
}

const ROW = "flex items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-foreground/[0.035]";
const FOOTER_TEXT = "min-w-0 flex-1 text-[12.5px] font-medium text-[#3A4152] dark:text-foreground/75";
const FOOTER_LINK = "shrink-0 whitespace-nowrap text-[12.5px] font-semibold hover:underline";
const STRONG = "font-semibold text-foreground";

function PanelShell({ panel, control, footer, children }: { panel: AnyPanel; control: ReactNode; footer: ReactNode; children: ReactNode }) {
  const t = THEME[panel];
  return (
    <section className={"flex h-full flex-col rounded-[18px] border p-[18px] " + t.card}>
      <div className="flex items-center gap-3">
        <span className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center " + t.iconWrap}>{t.icon}</span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{t.title}</h2>
        {control}
      </div>
      {/* Under the whole header row, so it never has to share a line with the control. */}
      <p className={"mt-0.5 truncate pl-[38px] text-xs font-medium " + t.subtitleClass}>{t.subtitle}</p>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
      {footer && <div className="mt-3 flex items-center gap-2.5 border-t border-[#0F1420]/[0.08] px-0.5 pt-3 dark:border-white/10">{footer}</div>}
    </section>
  );
}

const CONTROL = "rounded-[9px] border bg-white text-xs font-medium text-foreground dark:bg-card";

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={"flex flex-1 items-center justify-center py-6 text-center text-[13px] font-medium " + (error ? RED : "text-muted-foreground")}>{children}</p>;
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
        !ready ? undefined : panel === "active" ? (
          <ActiveFooter rows={rows as ActiveEntry[]} win={win} weekPct={weekPct ?? null} />
        ) : panel === "hottest" ? (
          <HottestFooter rows={rows as StreakEntry[]} />
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
            <Avatar e={e} />
            <span className="w-[104px] shrink-0 min-[400px]:w-28">
              <Name>{e.name}</Name>
              <span className="block text-[11px] font-medium tabular-nums text-[#5B6275] dark:text-muted-foreground">
                {e.pickCount} pick{e.pickCount === 1 ? "" : "s"}
              </span>
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-md bg-[#E3E8F5] dark:bg-white/10">
              <span className="block h-full rounded-md bg-brand-600" style={{ width: (max > 0 ? (e.pickCount / max) * 100 : 0) + "%" }} />
            </span>
            <span aria-hidden className="min-w-[26px] shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
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
      <ListIcon className={"h-4 w-4 shrink-0 stroke-[2.2] " + THEME.active.accent} />
      <p className={FOOTER_TEXT}>
        {TOTAL_LABEL[win]}
        <span className="ml-1.5 font-semibold tabular-nums text-foreground">{(rows[0]?.totalPicks ?? 0).toLocaleString("en-US")}</span>
        {pct !== null && pct !== 0 && <span className={"ml-1.5 whitespace-nowrap font-semibold tabular-nums " + (pct < 0 ? RED : GREEN)}>{(pct < 0 ? "↓ " : "↑ ") + Math.abs(pct) + "%"}</span>}
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + THEME.active.accent}>
        View all →
      </a>
    </>
  );
}

const STREAK_DOTS = 8;
// #1 is a dark featured row (the same in both themes); the rest are rows with an 8-dot trail.
function HottestRows({ rows }: { rows: StreakEntry[] }) {
  const [lead, ...rest] = rows;
  const lit = Math.min(lead.streak, STREAK_DOTS);
  return (
    <>
      <Link href={capperHref(lead.capperId)} className="flex items-center gap-3 rounded-[14px] border border-[#4A3A1E] bg-[#17130E] px-3.5 py-3 transition hover:brightness-110">
        <span className="rounded-[9px] border border-[#E8A33A] bg-[#3A2A12] px-2 py-1.5 text-[13px] font-semibold leading-none tabular-nums text-[#FFC65C]">#1</span>
        <span aria-hidden className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border border-[#8A6A2E] bg-[#2A2013] text-[#FFC65C]">
          <CrownIcon className="h-[21px] w-[21px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold tracking-[0.02em] text-white">{lead.name}</span>
          <span className="block whitespace-nowrap text-base font-semibold leading-tight tabular-nums text-[#FFC65C]">{lead.streak} WINS</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="flex items-center gap-1 text-[10px] font-medium text-[#D9CBB4]">
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
                <Avatar e={e} size={22} />
                <span className="min-w-0 flex-1">
                  <Name>{e.name}</Name>
                </span>
                <span className="shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums text-foreground">{e.streak} WINS</span>
                <span aria-hidden className="flex shrink-0 gap-[3px]">
                  {Array.from({ length: STREAK_DOTS }, (_, k) => (
                    <span key={k} className={"h-2 w-2 rounded-full " + (k < Math.min(e.streak, STREAK_DOTS) ? "bg-[#22C55E]" : "bg-[#E7D9CB] dark:bg-white/15")} />
                  ))}
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-[#8A6A4E] dark:text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function HottestFooter({ rows }: { rows: StreakEntry[] }) {
  return (
    <>
      <FlameFilledIcon className="h-[18px] w-[18px] shrink-0" />
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> is on the longest run <span className={"whitespace-nowrap font-semibold tabular-nums " + THEME.hottest.accent}>({rows[0].streak} wins)</span>
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + THEME.hottest.accent}>
        View all →
      </a>
    </>
  );
}

// Rank chip: gold, silver, bronze, then plain.
const MEDAL = ["bg-[#F5B301] text-[#3A2A00]", "bg-[#C5CBD6] text-[#1F2633]", "bg-[#D08A4E] text-white"];
// Record column: "12-3 80%" on one line where the panel is wide enough, win % under the W-L where it
// is not (a phone, and the narrow three-column range).
const RECORD_COL = "w-[74px] max-[479px]:w-10 min-[1500px]:max-[1699px]:w-10";
const RECORD_PART = "max-[479px]:block min-[1500px]:max-[1699px]:block";
function WinnerRows({ rows }: { rows: WinnerEntry[] }) {
  return (
    <>
      <div aria-hidden className="flex items-center gap-2.5 border-b border-[#0F1420]/[0.08] px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-[#5B6275] dark:border-white/10 dark:text-muted-foreground">
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
            <li key={e.capperId} className={ROW + " py-1.5 " + (i === 0 ? "bg-[#E9F7EE] dark:bg-emerald-500/10" : "")}>
              <span className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums " + (MEDAL[i] ?? "bg-[#E6EBE8] text-foreground dark:bg-white/10")}>{i + 1}</span>
              <Link href={capperHref(e.capperId)} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                <Avatar e={e} />
                <Name>{e.name}</Name>
              </Link>
              <span className={RECORD_COL + " shrink-0 whitespace-nowrap text-xs font-medium leading-tight tabular-nums text-foreground"}>
                <span className={RECORD_PART}>{e.wins + "–" + e.losses}</span>
                {decided > 0 && <span className={RECORD_PART + " ml-1 font-semibold text-[#5B6275] max-[479px]:ml-0 min-[1500px]:max-[1699px]:ml-0 dark:text-muted-foreground"}>{Math.round((e.wins / decided) * 100) + "%"}</span>}
              </span>
              <span className={"w-[60px] shrink-0 text-right text-sm font-semibold tracking-[-0.01em] tabular-nums " + GREEN}>{units(e.netUnits)}</span>
              <Link
                href={capperHref(e.capperId)}
                aria-label={"View " + e.name}
                className="hidden w-11 shrink-0 rounded-lg bg-[#E3F8EA] py-1.5 text-center text-[11.5px] font-semibold text-[#15803D] hover:brightness-95 dark:bg-emerald-500/15 dark:text-emerald-400 min-[400px]:block"
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
      <TrendingUpIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.4] " + GREEN} />
      <span className={"text-[15px] font-semibold leading-none tabular-nums " + GREEN}>{units(total)}</span>
      <p className={FOOTER_TEXT}>{rows.length >= 5 ? "total profit from top 5" : "total profit from the top " + rows.length}</p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + GREEN}>
        View all →
      </a>
    </>
  );
}

const SKID_DASHES = 5;
function ColdestRows({ rows }: { rows: StreakEntry[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link
            href={capperHref(e.capperId)}
            className={
              "flex items-center gap-2.5 rounded-xl border px-2 py-[7px] transition-colors " +
              (i === 0 ? "border-[#F3B4B4] bg-white dark:border-red-500/40 dark:bg-card" : "border-transparent hover:bg-foreground/[0.035]")
            }
          >
            <Rank n={i + 1} />
            <Avatar e={e} size={22} />
            <span className="min-w-0 flex-1">
              <Name>{e.name}</Name>
            </span>
            <span aria-hidden className="flex shrink-0 gap-1">
              {Array.from({ length: SKID_DASHES }, (_, k) => (
                <span key={k} className={"h-1 w-[9px] rounded-full " + (k < Math.min(e.streak, SKID_DASHES) ? "bg-[#EF4444]" : "bg-[#F6D4D4] dark:bg-white/15")} />
              ))}
            </span>
            <span className="min-w-[44px] shrink-0 rounded-lg bg-[#FDE4E4] px-2 py-1 text-center text-[12.5px] font-semibold tabular-nums text-[#B42318] dark:bg-red-500/15 dark:text-red-400">{e.streak}L</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// "(5L · −5.0u)": the run and the units lost across it.
function ColdestFooter({ rows }: { rows: StreakEntry[] }) {
  const lead = rows[0];
  return (
    <>
      <AlertTriangleIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.2] " + RED} />
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{lead.name}</span> has the longest skid{" "}
        <span className={"whitespace-nowrap font-semibold tabular-nums " + RED}>{"(" + lead.streak + "L" + (lead.units === undefined ? "" : " · " + units(lead.units)) + ")"}</span>
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

// Line colors by rank; the legend swatches match.
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
function RisingChart({ rows }: { rows: RisingEntry[] }) {
  const X0 = 30;
  const X1 = 214;
  const Y0 = 12;
  const Y1 = 176;
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
  const TICK = "fill-[#5B6275] text-[9px] font-medium tabular-nums dark:fill-muted-foreground";
  return (
    <div className="flex flex-1 flex-col items-center gap-2.5 min-[400px]:flex-row">
      <svg viewBox="0 0 220 200" role="img" aria-label={label} className="h-auto w-full min-w-0 flex-1">
        {[0, 1, 2].map((k) => (
          <line key={k} x1={X0} x2={216} y1={Y0 + (k * (Y1 - Y0)) / 3} y2={Y0 + (k * (Y1 - Y0)) / 3} strokeDasharray="3 4" className="stroke-[#0F1420]/10 dark:stroke-white/10" />
        ))}
        <line x1={X0} x2={216} y1={Y1} y2={Y1} className="stroke-[#0F1420]/25 dark:stroke-white/25" />
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % 2 === 0)
          .map((i) => (
            <line key={i} x1={x(i)} x2={x(i)} y1={Y0} y2={Y1} className="stroke-[#0F1420]/[0.05] dark:stroke-white/[0.06]" />
          ))}
        {[0, 1, 2, 3].map((k) => (
          <text key={k} x={X0 - 5} y={Y1 - (k * (Y1 - Y0)) / 3 + 3} textAnchor="end" className={TICK}>
            {Math.round(lo + k * step) + "%"}
          </text>
        ))}
        <polygon points={line(lead) + " " + x(lead.trend.length - 1).toFixed(1) + "," + Y1 + " " + X0 + "," + Y1} fill={LINE_COLORS[0]} fillOpacity={0.1} />
        {ranked.map(({ r, i }) => (
          <polyline key={r.capperId} points={line(r)} fill="none" stroke={LINE_COLORS[i]} strokeWidth={i === 0 ? 2 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {ranked.map(({ r, i }) => {
          const cx = x(r.trend.length - 1);
          const cy = y(r.trend[r.trend.length - 1] ?? lo);
          return i === 0 ? (
            <circle key={r.capperId} cx={cx} cy={cy} r={4.5} stroke={LINE_COLORS[0]} strokeWidth={2.4} className="fill-white dark:fill-[#0B1220]" />
          ) : (
            <circle key={r.capperId} cx={cx} cy={cy} r={3} fill={LINE_COLORS[i]} />
          );
        })}
        {/* Picks back from the newest; the last point is the current rolling win %. */}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % 2 === 0 && n - 1 - i > 1)
          .map((i) => (
            <text key={i} x={x(i)} y={Y1 + 18} textAnchor="middle" className={TICK}>
              {"−" + (n - 1 - i)}
            </text>
          ))}
        <text x={216} y={Y1 + 18} textAnchor="end" className="fill-foreground text-[9px] font-semibold">
          Latest
        </text>
      </svg>
      <ol className="flex w-full shrink-0 flex-col justify-center gap-1 min-[400px]:w-[142px]">
        {rows.map((r, i) => (
          <li key={r.capperId}>
            <Link href={capperHref(r.capperId)} className="flex items-center gap-[7px] rounded-lg px-1 py-[5px] transition-colors hover:bg-foreground/[0.035]">
              <span aria-hidden className="h-1 w-[9px] shrink-0 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{r.name}</span>
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
      <TrendingUpIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.4] " + GREEN} />
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> is trending up <span className={"whitespace-nowrap font-semibold tabular-nums " + GREEN}>{"+" + rows[0].pts + " pts"}</span>
      </p>
      <Link href={capperHref(rows[0].capperId)} className="shrink-0 whitespace-nowrap rounded-lg bg-[#16A34A] px-2.5 py-[7px] text-xs font-semibold text-white hover:brightness-95">
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
              <Avatar e={e} />
              <span className="min-w-0 flex-1">
                <Name>{e.name}</Name>
                <span className={"mt-0.5 inline-block rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase leading-tight tracking-[0.06em] " + TIER_CLASS[tier]}>{tier}</span>
              </span>
              <svg width={70} height={26} viewBox="0 0 70 26" role="img" aria-label={"Win rate per 10-pick block: " + e.blocks.map((v) => Math.round(v) + "%").join(", ")} className="shrink-0 max-[400px]:w-12">
                <line x1={0} x2={70} y1={13} y2={13} strokeDasharray="2 3" className="stroke-[#E2D4FB] dark:stroke-violet-500/30" />
                <polyline points={pts} fill="none" stroke="#22A55B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="relative h-[42px] w-[42px] shrink-0" role="img" aria-label={"Confidence score " + score + " of 100"}>
                <svg width={42} height={42} viewBox="0 0 42 42" aria-hidden>
                  <circle cx={21} cy={21} r={RING_R} fill="none" strokeWidth={4} className="stroke-[#ECE4FA] dark:stroke-violet-500/20" />
                  <circle cx={21} cy={21} r={RING_R} fill="none" stroke="#7C3AED" strokeWidth={4} strokeLinecap="round" strokeDasharray={((RING_C * score) / 100).toFixed(1) + " " + RING_C.toFixed(1)} transform="rotate(-90 21 21)" />
                </svg>
                <span aria-hidden className="absolute inset-0 flex items-center justify-center text-[13px] font-semibold tabular-nums text-[#3B1D7A] dark:text-violet-200">
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
      <ShieldCheckIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.2] " + THEME.consistent.accent} />
      <p className={FOOTER_TEXT}>
        <span className={STRONG}>{rows[0].name}</span> is the most reliable capper right now{" "}
        <span className={"whitespace-nowrap font-semibold tabular-nums " + THEME.consistent.accent}>{"(" + score + " · " + consistencyTier(score) + ")"}</span>
      </p>
      <a href={LEADERBOARD_HREF} className={FOOTER_LINK + " " + THEME.consistent.accent}>
        View all →
      </a>
    </>
  );
}
