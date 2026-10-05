"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PANEL_WINDOW,
  PANEL_WINDOWS,
  PANEL_WINDOW_LABELS,
  consistencyScore,
  consistencyTier,
  ptsLabel,
  risingSeries,
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
  TrendingDownIcon,
  TrendingUpIcon,
  TrophyFilledIcon,
  UsersIcon,
} from "@/components/dashboard/cappers-icons";
import { CONTROL, FOOTER_LINK, FOOTER_TEXT, FooterLine, GREEN, Message, Name, PanelShell, RED, ROW, Rank, TINTS, type PanelTheme } from "@/components/dashboard/panel-shell";

type AnyPanel = PanelKey | FormPanelKey;

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
  falling: "Nobody is underperforming their usual form.",
  consistent: "No capper has 50 decided picks with a steady 50%+ record yet.",
};
// Windowless panels say what they read where the others have their window dropdown.
const FORM_SUBLABEL: Record<FormPanelKey, string> = { rising: "Last 10 vs prior 90", falling: "Last 10 vs prior 90", consistent: "Last 50 picks" };

// Each panel's hue (TINTS, panel-shell.tsx) with its own title, subtitle and header icon.
const ICON = "h-[17px] w-[17px]";
const THEME: Record<AnyPanel, PanelTheme> = {
  active: { ...TINTS.blue, title: "Most Active", subtitle: "Who's putting in the work", icon: <UsersIcon className={ICON + " stroke-[1.8]"} /> },
  rising: {
    ...TINTS.green,
    title: "Rising Fast",
    subtitle: "Momentum is building",
    icon: <TrendingUpIcon className={ICON + " stroke-[2.4]"} />,
    iconWrap: "rounded-lg bg-[#DCF7E6] text-[#15803D] dark:bg-emerald-500/15 dark:text-emerald-400",
  },
  falling: { ...TINTS.rose, title: "Falling off", subtitle: "Momentum is fading", icon: <TrendingDownIcon className={ICON + " stroke-[2.4]"} />, iconWrap: "rounded-lg bg-[#FFDDE7] text-[#BE123C] dark:bg-rose-500/15 dark:text-rose-400" },
  hottest: { ...TINTS.orange, title: "Hot Hand", subtitle: "Current win streaks lighting up", icon: <FlameFilledIcon className={ICON} /> },
  consistent: { ...TINTS.violet, title: "Most Consistent", subtitle: "Confidence score · last 50 picks", icon: <TargetIcon className={ICON + " stroke-[2.2]"} /> },
  winners: { ...TINTS.green, title: "Biggest Winners", subtitle: "Top profit (units won)", icon: <TrophyFilledIcon className={ICON} /> },
  coldest: { ...TINTS.red, title: "Coldest", subtitle: "Who's on a cold streak", icon: <SnowflakeIcon className={ICON} /> },
};

const units = (n: number) => (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "u";
const capperHref = (id: string) => "/cappers/" + id;
// Where a footer's "View all" goes: the leaderboard on this page, unless the panel sits on another one.
const LEADERBOARD_HREF = "#leaderboard";

// ---------------------------------------------------------------------------
// Windowed panels (Most Active, Hot Hand, Biggest Winners, Coldest)
// ---------------------------------------------------------------------------

// It renders the server-fetched "This week" rows first; changing its window dropdown fetches ONLY this
// panel (GET /api/cappers/panel), never the whole page. Fetched windows are kept in memory so flipping
// back is free. `weekPct` (Most Active only): picks this week against last week, in percent.
// `leaderboardHref`: the footer's "View all" target, for a panel shown away from /cappers.
export function CapperPanel({ panel, initial, weekPct, leaderboardHref = LEADERBOARD_HREF }: { panel: PanelKey; initial: PanelRows; weekPct?: number | null; leaderboardHref?: string }) {
  const [win, setWin] = useState<PanelWindow>(DEFAULT_PANEL_WINDOW);
  const [rows, setRows] = useState<PanelRows>(initial);
  // The window the rows on screen belong to. It trails `win` while a fetch is in flight, so the
  // footer and the empty message never describe the new window with the old window's rows.
  const [shown, setShown] = useState<PanelWindow>(DEFAULT_PANEL_WINDOW);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const cache = useRef(new Map<PanelWindow, PanelRows>([[DEFAULT_PANEL_WINDOW, initial]]));
  const abort = useRef<AbortController | null>(null);

  // A new server render (time tab, filter or navigation) hands down fresh "This week" rows.
  useEffect(() => {
    cache.current = new Map([[DEFAULT_PANEL_WINDOW, initial]]);
    setRows(initial);
    setShown(DEFAULT_PANEL_WINDOW);
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
      setShown(next);
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
      setShown(next);
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
      theme={THEME[panel]}
      busy={state === "loading"}
      control={
        <div className="relative shrink-0">
          <label htmlFor={selectId} className="sr-only">
            {THEME[panel].title + " time window"}
          </label>
          <select
            id={selectId}
            value={win}
            onChange={(e) => change(e.target.value as PanelWindow)}
            className={CONTROL + " cursor-pointer appearance-none py-[5px] pl-2.5 pr-7 " + THEME[panel].control}
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
          <ActiveFooter rows={rows as ActiveEntry[]} win={shown} weekPct={weekPct ?? null} href={leaderboardHref} />
        ) : panel === "hottest" ? (
          <HottestFooter rows={rows as StreakEntry[]} href={leaderboardHref} />
        ) : panel === "winners" ? (
          <WinnersFooter rows={rows as WinnerEntry[]} href={leaderboardHref} />
        ) : (
          <ColdestFooter rows={rows as StreakEntry[]} href={leaderboardHref} />
        )
      }
    >
      <div className={"flex flex-1 flex-col transition-opacity " + (state === "loading" ? "opacity-60" : "")} aria-busy={state === "loading"}>
        {state === "error" ? (
          <Message error>Couldn&apos;t load this panel. Try another window or refresh.</Message>
        ) : rows.length === 0 ? (
          <Message>{EMPTY[panel](shown)}</Message>
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
          <Link href={capperHref(e.capperId)} className={ROW}>
            <Rank n={i + 1} />
            <span className="w-[132px] shrink-0 min-[400px]:w-[172px] min-[1700px]:w-52">
              <Name>{e.name}</Name>
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-md bg-[#E3E8F5] dark:bg-white/10">
              <span className="block h-full rounded-md bg-brand-600" style={{ width: (max > 0 ? (e.pickCount / max) * 100 : 0) + "%" }} />
            </span>
            <span className="min-w-[26px] shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
              {e.pickCount}
              <span className="sr-only">{e.pickCount === 1 ? " pick" : " picks"}</span>
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
function ActiveFooter({ rows, win, weekPct, href }: { rows: ActiveEntry[]; win: PanelWindow; weekPct: number | null; href: string }) {
  const pct = win === "week" ? weekPct : null;
  return (
    <>
      <ListIcon className={"h-4 w-4 shrink-0 stroke-[2.2] " + THEME.active.accent} />
      <p className={FOOTER_TEXT}>
        {TOTAL_LABEL[win]}
        <span className="ml-1.5 font-semibold tabular-nums text-foreground">{(rows[0]?.totalPicks ?? 0).toLocaleString("en-US")}</span>
        {pct !== null && pct !== 0 && <span className={"ml-1.5 whitespace-nowrap font-semibold tabular-nums " + (pct < 0 ? RED : GREEN)}>{(pct < 0 ? "↓ " : "↑ ") + Math.abs(pct) + "%"}</span>}
      </p>
      <a href={href} className={FOOTER_LINK + " " + THEME.active.accent}>
        View all →
      </a>
    </>
  );
}

const STREAK_DOTS = 10;
// Smaller on a phone and in the three-column range where the sidebar leaves each panel at its narrowest.
const DOT = "h-2 w-2 rounded-full max-[399px]:h-1.5 max-[399px]:w-1.5 min-[1500px]:max-[1699px]:h-1.5 min-[1500px]:max-[1699px]:w-1.5";
const DOT_GAP = "gap-[3px] max-[399px]:gap-0.5 min-[1500px]:max-[1699px]:gap-0.5";
// #1 is a dark featured row (the same in both themes); the rest are rows with a dot trail. A dot per
// win up to STREAK_DOTS, then "+N" for the wins beyond it, so a longer run always draws a longer strip.
function HottestRows({ rows }: { rows: StreakEntry[] }) {
  const [lead, ...rest] = rows;
  const lit = Math.min(lead.streak, STREAK_DOTS);
  // The "+N" slot is kept on every row once any row needs it, so the strips stay aligned.
  const overflow = rest.some((e) => e.streak > STREAK_DOTS);
  return (
    <>
      <Link href={capperHref(lead.capperId)} className="flex items-center gap-2.5 rounded-[14px] border border-[#4A3A1E] bg-[#17130E] px-3 py-2 transition hover:brightness-110">
        <span className="rounded-[9px] border border-[#E8A33A] bg-[#3A2A12] px-2 py-1.5 text-[13px] font-semibold leading-none tabular-nums text-[#FFC65C]">#1</span>
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#8A6A2E] bg-[#2A2013] text-[#FFC65C]">
          <CrownIcon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight tracking-[0.02em] text-white">{lead.name}</span>
          <span className="block whitespace-nowrap text-sm font-semibold leading-tight tabular-nums text-[#FFC65C]">{lead.streak} WINS</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="flex items-center gap-1 text-[10px] font-medium leading-none text-[#D9CBB4]">
            Current streak
            <FlameFilledIcon className="h-[11px] w-[11px]" />
          </span>
          <span aria-hidden className={"flex items-center " + DOT_GAP}>
            {Array.from({ length: lit - 1 }, (_, i) => (
              <span key={i} className={DOT + " bg-[#22C55E]"} />
            ))}
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 border-[#22C55E]">
              <span className="h-[7px] w-[7px] rounded-full bg-[#FFC65C]" />
            </span>
            {lead.streak > STREAK_DOTS && <span className="ml-0.5 text-xs font-semibold leading-none tabular-nums text-[#FFC65C]">{"+" + (lead.streak - STREAK_DOTS)}</span>}
          </span>
        </span>
      </Link>
      {rest.length > 0 && (
        <ol start={2} className="mt-1.5 flex flex-col gap-0.5">
          {rest.map((e, i) => (
            <li key={e.capperId}>
              <Link href={capperHref(e.capperId)} className={ROW}>
                <Rank n={i + 2} />
                <span className="min-w-0 flex-1">
                  <Name>{e.name}</Name>
                </span>
                <span className="shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums text-foreground">{e.streak} WINS</span>
                <span aria-hidden className={"flex shrink-0 items-center " + DOT_GAP}>
                  {Array.from({ length: STREAK_DOTS }, (_, k) => (
                    <span key={k} className={DOT + " " + (k < Math.min(e.streak, STREAK_DOTS) ? "bg-[#22C55E]" : "bg-[#E7D9CB] dark:bg-white/15")} />
                  ))}
                  {overflow && <span className={"w-5 min-[1500px]:max-[1699px]:w-4 text-xs font-semibold leading-none tabular-nums " + GREEN}>{e.streak > STREAK_DOTS ? "+" + (e.streak - STREAK_DOTS) : ""}</span>}
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-[#8A6A4E] dark:text-muted-foreground min-[1500px]:max-[1699px]:hidden" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function HottestFooter({ rows, href }: { rows: StreakEntry[]; href: string }) {
  return (
    <>
      <FlameFilledIcon className="h-[18px] w-[18px] shrink-0" />
      <FooterLine name={rows[0].name}>
        is on the longest run <span className={"font-semibold tabular-nums " + THEME.hottest.accent}>({rows[0].streak} wins)</span>
      </FooterLine>
      <a href={href} className={FOOTER_LINK + " " + THEME.hottest.accent}>
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
const UNITS_COL = "w-[60px] min-[1500px]:max-[1699px]:w-14";
const VIEW_COL = "w-11 min-[1500px]:max-[1699px]:w-10";
function WinnerRows({ rows }: { rows: WinnerEntry[] }) {
  return (
    <>
      <div aria-hidden className="flex items-center gap-2.5 min-[1500px]:max-[1699px]:gap-1.5 border-b border-[#0F1420]/[0.08] px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-[#5B6275] dark:border-white/10 dark:text-muted-foreground">
        <span className="w-5">#</span>
        <span className="flex-1">Capper</span>
        <span className={RECORD_COL}>Record</span>
        <span className={UNITS_COL + " text-right"}>Units</span>
        <span className={"hidden min-[400px]:block " + VIEW_COL} />
      </div>
      <ol className="mt-1 flex flex-col gap-0.5">
        {rows.map((e, i) => {
          const decided = e.wins + e.losses;
          return (
            <li key={e.capperId} className={ROW + " " + (i === 0 ? "bg-[#E9F7EE] dark:bg-emerald-500/10" : "")}>
              <span className={"flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums " + (MEDAL[i] ?? "bg-[#E6EBE8] text-foreground dark:bg-white/10")}>{i + 1}</span>
              <Link href={capperHref(e.capperId)} className="min-w-0 flex-1 hover:underline">
                <Name>{e.name}</Name>
              </Link>
              <span className={RECORD_COL + " shrink-0 whitespace-nowrap text-xs font-medium leading-tight tabular-nums text-foreground"}>
                <span className={RECORD_PART}>{e.wins + "–" + e.losses}</span>
                {decided > 0 && <span className={RECORD_PART + " ml-1 font-semibold text-[#5B6275] max-[479px]:ml-0 min-[1500px]:max-[1699px]:ml-0 dark:text-muted-foreground"}>{Math.round((e.wins / decided) * 100) + "%"}</span>}
              </span>
              <span className={UNITS_COL + " shrink-0 text-right text-sm font-semibold tracking-[-0.01em] tabular-nums " + GREEN}>{units(e.netUnits)}</span>
              <Link
                href={capperHref(e.capperId)}
                aria-label={"View " + e.name}
                className={"hidden shrink-0 rounded-lg bg-[#E3F8EA] py-1 text-center text-xs font-semibold text-[#15803D] hover:brightness-95 dark:bg-emerald-500/15 dark:text-emerald-400 min-[400px]:block " + VIEW_COL}
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

function WinnersFooter({ rows, href }: { rows: WinnerEntry[]; href: string }) {
  const total = rows.reduce((sum, e) => sum + e.netUnits, 0);
  return (
    <>
      <TrendingUpIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.4] " + GREEN} />
      <span className={"text-[15px] font-semibold leading-none tabular-nums " + GREEN}>{units(total)}</span>
      <p className={FOOTER_TEXT}>{rows.length >= 5 ? "total profit from top 5" : "total profit from the top " + rows.length}</p>
      <a href={href} className={FOOTER_LINK + " " + GREEN}>
        View all →
      </a>
    </>
  );
}

const SKID_DASHES = 5;
function ColdestRows({ rows }: { rows: StreakEntry[] }) {
  return (
    <ol className="flex flex-col gap-0.5">
      {rows.map((e, i) => (
        <li key={e.capperId}>
          <Link
            href={capperHref(e.capperId)}
            className={
              "flex h-9 items-center gap-2.5 rounded-xl border px-[5px] transition-colors min-[1500px]:max-[1699px]:gap-1.5 " +
              (i === 0 ? "border-[#F3B4B4] bg-white dark:border-red-500/40 dark:bg-card" : "border-transparent hover:bg-foreground/[0.035]")
            }
          >
            <Rank n={i + 1} />
            <span className="min-w-0 flex-1">
              <Name>{e.name}</Name>
            </span>
            <span aria-hidden className="flex shrink-0 gap-1">
              {Array.from({ length: SKID_DASHES }, (_, k) => (
                <span key={k} className={"h-1 w-[9px] rounded-full " + (k < Math.min(e.streak, SKID_DASHES) ? "bg-[#EF4444]" : "bg-[#F6D4D4] dark:bg-white/15")} />
              ))}
            </span>
            <span className="min-w-[44px] shrink-0 rounded-lg bg-[#FDE4E4] px-2 py-0.5 text-center text-xs font-semibold tabular-nums text-[#B42318] dark:bg-red-500/15 dark:text-red-400">{e.streak}L</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// "(5L, −5.0u)": the run and the units lost across it. A comma, not "·": at this size the dot before the
// minus sign read as a second minus.
function ColdestFooter({ rows, href }: { rows: StreakEntry[]; href: string }) {
  const lead = rows[0];
  return (
    <>
      <AlertTriangleIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.2] " + RED} />
      <FooterLine name={lead.name}>
        has the longest skid <span className={"font-semibold tabular-nums " + RED}>{"(" + lead.streak + "L" + (lead.units === undefined ? "" : ", " + units(lead.units)) + ")"}</span>
      </FooterLine>
      <a href={href} className={FOOTER_LINK + " " + RED}>
        View all →
      </a>
    </>
  );
}

// ---------------------------------------------------------------------------
// Windowless panels (Rising Fast, Falling off, Most Consistent)
// ---------------------------------------------------------------------------

// No dropdown and no fetch: the server renders the rows once.
export function FormPanel({ panel, rows, leaderboardHref = LEADERBOARD_HREF }: { panel: FormPanelKey; rows: RisingEntry[] | ConsistentEntry[]; leaderboardHref?: string }) {
  const ready = rows.length > 0;
  const down = panel === "falling";
  return (
    <PanelShell
      theme={THEME[panel]}
      control={<span className={CONTROL + " shrink-0 whitespace-nowrap px-2.5 py-[5px] " + THEME[panel].control}>{FORM_SUBLABEL[panel]}</span>}
      footer={!ready ? undefined : panel === "consistent" ? <ConsistentFooter rows={rows as ConsistentEntry[]} href={leaderboardHref} /> : <RisingFooter rows={rows as RisingEntry[]} down={down} />}
    >
      {!ready ? <Message>{FORM_EMPTY[panel]}</Message> : panel === "consistent" ? <ConsistentRows rows={rows as ConsistentEntry[]} /> : <RisingChart rows={rows as RisingEntry[]} down={down} />}
    </PanelShell>
  );
}

const AXIS_TEXT = "text-[11px] font-medium leading-none tabular-nums text-[#5B6275] dark:text-muted-foreground";
// Line colors by rank; the legend swatches match. #1 takes the panel's own hue.
const LINE_COLORS = ["#16A34A", "#2563EB", "#F59E0B", "#A855F7", "#06B6D4"];
const LINE_COLORS_DOWN = ["#E11D48", ...LINE_COLORS.slice(1)];
const signedPts = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v));
// What sets Falling off's chart apart from Rising Fast's: #1's label chip, its legend row and the points' color.
const TREND = {
  up: { colors: LINE_COLORS, chip: "bg-[#15803D]", lead: "bg-[#DCF3E4] dark:bg-emerald-500/15", pts: GREEN },
  down: { colors: LINE_COLORS_DOWN, chip: "bg-[#BE123C]", lead: "bg-[#FFE1E9] dark:bg-rose-500/15", pts: "text-[#BE123C] dark:text-rose-400" },
};

// The axis for the lines' range. It bottoms out at the lowest point rounded down to a 10 and tops out at
// the highest rounded up to a gridline; gridlines are the smallest round step that gives at most five
// bands, drawn at its multiples (0 always among them). A dip of under half a point past a 10 (two
// losses against a 51% norm reach -10.2) does not buy a whole extra band: it is under a pixel.
function ptsAxis(values: number[]): { lo: number; hi: number; ticks: number[] } {
  const lo = Math.floor((Math.min(0, ...values) + 0.5) / 10) * 10;
  const max = Math.max(0, ...values);
  const step = [10, 20, 50, 100].find((st) => (Math.max(st, Math.ceil(max / st) * st) - lo) / st <= 5) ?? 100;
  const hi = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let t = hi; t >= lo; t -= step) ticks.push(t);
  // The bottom of the axis gets its own label when it falls between gridlines with room to spare.
  if (ticks[ticks.length - 1] - lo >= step / 2) ticks.push(lo);
  return { lo, hi, ticks };
}
// The plot is at least this tall (px): what "do two endpoint labels collide" is judged against.
const PLOT_MIN_H = 116;
const LABEL_H = 13;

// "Wins above their norm" for the top risers: each line starts at 0 and, pick by pick over the last 10
// decided picks, adds what the result beat the capper's own baseline win rate by (risingSeries). A
// riser's line climbs, and ends on exactly their score. 0 is the norm line.
// `down` is Falling off, "wins below their norm": the same chart upside down - the lines sink to a
// negative score, the axis is the mirror image, and #1 is drawn in the panel's rose.
function RisingChart({ rows, down = false }: { rows: RisingEntry[]; down?: boolean }) {
  const look = down ? TREND.down : TREND.up;
  const lines = rows.map((r) => risingSeries(r.results, r.baseline));
  const n = Math.max(2, ...lines.map((l) => l.length));
  const up = ptsAxis(down ? lines.flat().map((v) => -v) : lines.flat());
  const { lo, hi, ticks } = down ? { lo: -up.hi, hi: -up.lo, ticks: up.ticks.map((t) => -t) } : up;
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (v: number) => ((hi - v) / (hi - lo)) * 100;
  const points = (l: number[]) => l.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(2)).join(" ");
  const ends = lines.map((l) => l[l.length - 1] ?? 0);
  // Every line gets its "+X pts" in the right margin where the panel is wide enough and no two labels
  // would touch; otherwise only #1 is labelled, on the plot.
  const minGap = (LABEL_H / PLOT_MIN_H) * (hi - lo);
  const sortedEnds = [...ends].sort((p, q) => p - q);
  const allLabels = rows.length > 1 && sortedEnds.every((v, i) => i === 0 || v - sortedEnds[i - 1] >= minGap);
  const ranked = rows.map((r, i) => ({ r, i })).reverse(); // drawn last-to-first so #1 sits on top
  const label =
    "Wins " +
    (down ? "below" : "above") +
    " their norm across the last " +
    (n - 1) +
    " decided picks, in points: each line starts at 0 and ends on the capper's score. " +
    rows.map((r) => r.name + " " + (down ? "−" : "+") + Math.abs(r.pts)).join("; ") +
    ".";
  // #1's label sits level with its dot when the line arrives moving away from the norm, and on the far
  // side of the dot (under it rising, over it falling) when the last pick went the other way.
  const prev = lines[0][lines[0].length - 2] ?? 0;
  const leadLabelShift = (down ? prev > ends[0] : prev < ends[0]) ? "translateY(-50%)" : down ? "translateY(calc(-100% - 9px))" : "translateY(9px)";
  return (
    <div className="flex flex-1 flex-col gap-2.5 min-[400px]:flex-row">
      {/* At least ~140px tall, and as tall as the panel's row makes it: no gap above or below. */}
      <div role="img" aria-label={label} className="relative min-h-[144px] w-full min-w-0 flex-1">
        <div className={"absolute bottom-5 left-[34px] top-2 " + (allLabels ? "right-2 min-[1280px]:max-[1499px]:right-[54px] min-[1700px]:right-[54px]" : "right-2")}>
          {ticks.map((t) => (
            <span key={t} aria-hidden className={"absolute right-full mr-1.5 -translate-y-1/2 text-right " + (t === 0 ? "text-[11px] font-semibold leading-none text-[#3A4152] dark:text-foreground/80" : AXIS_TEXT)} style={{ top: y(t) + "%" }}>
              {/* 0 is the norm line. Its label sits in the axis margin: every line starts at the line's left end, so a label on the plot would be crossed. */}
              {t === 0 ? (
                <>
                  Their
                  <br />
                  norm
                </>
              ) : (
                signedPts(t)
              )}
            </span>
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="absolute inset-0 h-full w-full overflow-visible">
            {ticks
              .filter((t) => t !== 0)
              .map((t) => (
                <line key={t} x1={0} x2={100} y1={y(t)} y2={y(t)} vectorEffect="non-scaling-stroke" className="stroke-[#0F1420]/[0.08] dark:stroke-white/10" />
              ))}
            <line x1={0} x2={100} y1={y(0)} y2={y(0)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-[#0F1420]/45 dark:stroke-white/50" />
            {ranked.map(({ r, i }) => (
              <polyline
                key={r.capperId}
                points={points(lines[i])}
                fill="none"
                stroke={look.colors[i]}
                strokeWidth={i === 0 ? 2.5 : 1.25}
                strokeOpacity={i === 0 ? 1 : 0.4}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <span aria-hidden className="absolute h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] bg-white dark:bg-[#0B1220]" style={{ left: x(lines[0].length - 1) + "%", top: y(ends[0]) + "%", borderColor: look.colors[0] }} />
          {/* #1's label on the plot, clear of its line: left of the dot when the line climbs into it, under it when the last pick lost. Hidden where the margin labels show. */}
          <span
            aria-hidden
            className={"absolute right-3.5 whitespace-nowrap rounded-md " + look.chip + " px-1.5 py-[3px] text-[11px] font-semibold leading-none tabular-nums text-white " + (allLabels ? "min-[1280px]:max-[1499px]:hidden min-[1700px]:hidden" : "")}
            style={{ top: y(ends[0]) + "%", transform: leadLabelShift }}
          >
            {ptsLabel(rows[0].pts)}
          </span>
          {allLabels &&
            rows.map((r, i) => (
              <span
                key={r.capperId}
                aria-hidden
                className={"absolute left-full ml-2 hidden -translate-y-1/2 whitespace-nowrap text-[11px] leading-none tabular-nums min-[1280px]:max-[1499px]:block min-[1700px]:block " + (i === 0 ? "font-bold" : "font-semibold")}
                style={{ top: y(ends[i]) + "%", color: look.colors[i] }}
              >
                {ptsLabel(r.pts)}
              </span>
            ))}
        </div>
        {/* Picks back from the newest: the lines start before the first of them, at 0. */}
        <span aria-hidden className={"absolute bottom-0 left-[34px] " + AXIS_TEXT}>
          {n - 1 + " picks ago"}
        </span>
        <span aria-hidden className={"absolute bottom-0 text-[11px] font-semibold leading-none text-foreground " + (allLabels ? "right-2 min-[1280px]:max-[1499px]:right-[54px] min-[1700px]:right-[54px]" : "right-2")}>
          Latest
        </span>
      </div>
      <ol className="flex w-full shrink-0 flex-col justify-center gap-0.5 min-[400px]:w-[150px] min-[1700px]:w-[200px]">
        {rows.map((r, i) => (
          <li key={r.capperId}>
            <Link href={capperHref(r.capperId)} className={"flex h-8 items-center gap-[7px] rounded-lg px-1.5 transition-colors " + (i === 0 ? look.lead : "hover:bg-foreground/[0.035]")}>
              <span aria-hidden className={"w-[11px] shrink-0 rounded-full " + (i === 0 ? "h-1" : "h-[3px]")} style={{ backgroundColor: look.colors[i] }} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{r.name}</span>
              <span className={"whitespace-nowrap text-xs font-semibold tabular-nums " + look.pts}>{ptsLabel(r.pts)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RisingFooter({ rows, down }: { rows: RisingEntry[]; down: boolean }) {
  const look = down ? TREND.down : TREND.up;
  const Icon = down ? TrendingDownIcon : TrendingUpIcon;
  return (
    <>
      <Icon className={"h-[18px] w-[18px] shrink-0 stroke-[2.4] " + look.pts} />
      <FooterLine name={rows[0].name}>
        {/* One string: split text nodes are not kerned across the join. */}
        {down ? "is trending down " : "is trending up "}
        <span className={"font-semibold tabular-nums " + look.pts}>{ptsLabel(rows[0].pts)}</span>
      </FooterLine>
      <Link href={capperHref(rows[0].capperId)} className={"shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white hover:brightness-95 " + (down ? "bg-[#E11D48]" : "bg-[#16A34A]")}>
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
const RING = 30;
const RING_R = 12;
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
            <Link href={capperHref(e.capperId)} className={ROW}>
              <Rank n={i + 1} />
              <span className="min-w-0 flex-1">
                <Name>{e.name}</Name>
              </span>
              <span className={"shrink-0 whitespace-nowrap rounded-[5px] px-1.5 min-[1500px]:max-[1699px]:px-1 py-0.5 text-[9.5px] font-semibold uppercase leading-tight tracking-[0.06em] " + TIER_CLASS[tier]}>{tier}</span>
              <svg width={70} height={26} viewBox="0 0 70 26" role="img" aria-label={"Win rate per 10-pick block: " + e.blocks.map((v) => Math.round(v) + "%").join(", ")} className="shrink-0 max-[400px]:w-12 min-[1500px]:max-[1699px]:w-9">
                <line x1={0} x2={70} y1={13} y2={13} strokeDasharray="2 3" className="stroke-[#E2D4FB] dark:stroke-violet-500/30" />
                <polyline points={pts} fill="none" stroke="#22A55B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="relative shrink-0" style={{ width: RING, height: RING }} role="img" aria-label={"Confidence score " + score + " of 100"}>
                <svg width={RING} height={RING} viewBox={"0 0 " + RING + " " + RING} aria-hidden>
                  <circle cx={RING / 2} cy={RING / 2} r={RING_R} fill="none" strokeWidth={3} className="stroke-[#ECE4FA] dark:stroke-violet-500/20" />
                  <circle cx={RING / 2} cy={RING / 2} r={RING_R} fill="none" stroke="#7C3AED" strokeWidth={3} strokeLinecap="round" strokeDasharray={((RING_C * score) / 100).toFixed(1) + " " + RING_C.toFixed(1)} transform={"rotate(-90 " + RING / 2 + " " + RING / 2 + ")"} />
                </svg>
                <span aria-hidden className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-[#3B1D7A] dark:text-violet-200">
                  {score}
                </span>
              </span>
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 stroke-[2.4] text-[#8B7AAE] dark:text-muted-foreground min-[1500px]:max-[1699px]:hidden" />
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function ConsistentFooter({ rows, href }: { rows: ConsistentEntry[]; href: string }) {
  const score = consistencyScore(rows[0].sd);
  return (
    <>
      <ShieldCheckIcon className={"h-[18px] w-[18px] shrink-0 stroke-[2.2] " + THEME.consistent.accent} />
      <FooterLine name={rows[0].name}>
        is the most reliable <span className={"font-semibold tabular-nums " + THEME.consistent.accent}>{"(" + score + " · " + consistencyTier(score) + ")"}</span>
      </FooterLine>
      <a href={href} className={FOOTER_LINK + " " + THEME.consistent.accent}>
        View all →
      </a>
    </>
  );
}
