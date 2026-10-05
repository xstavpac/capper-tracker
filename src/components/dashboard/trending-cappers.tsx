import Link from "next/link";
import type { ReactNode } from "react";
import type { BestLast20Entry, CapperPanels } from "@/server/data/capper-panels";
import { getRecordColor } from "@/server/data/stats";
import { STREAK_PANEL_MIN } from "@/lib/cappers-panels";
import { AlertTriangleIcon, FlameFilledIcon, SnowflakeIcon, TargetIcon, TrendingDownIcon, TrendingUpIcon } from "@/components/dashboard/cappers-icons";
import { FOOTER_LINK, FOOTER_TEXT, GREEN, Message, Name, PanelShell, RED, ROW, Rank, TINTS, type PanelTheme } from "@/components/dashboard/panel-shell";

const FLAME_PATH = "M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z";

// Two layered flame shapes (same silhouette, different color/scale) flicker
// on independent keyframes/durations so they don't move as one rigid unit -
// plus a few embers that rise and fade above the flame on a staggered loop.
// Exported so the Sharp Money page's Fav ML category icon (same "flame"
// concept - a capper on a hot run of favorite-moneyline picks) can reuse this
// exact component instead of duplicating the flame shape/animation - see
// src/components/sharp-money/category-icons.tsx.
export function HotStreaksIcon() {
  return (
    <span className="relative inline-block h-5 w-5 shrink-0" aria-hidden="true">
      <span
        className="absolute left-[7px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "0s" }}
      />
      <span
        className="absolute left-[11px] top-0.5 h-[3px] w-[3px] rounded-full bg-orange-300 animate-ember-rise"
        style={{ animationDelay: "0.6s" }}
      />
      <span
        className="absolute left-[9px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "1.2s" }}
      />
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-orange-500 animate-flame-outer">
        <path d={FLAME_PATH} />
      </svg>
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-amber-300 animate-flame-inner">
        <path d={FLAME_PATH} />
      </svg>
    </span>
  );
}

// Rows a dashboard panel shows; "View all" goes to /cappers for the rest.
const PANEL_ROWS = 3;
const ICON = "h-[17px] w-[17px]";
const VALUE = "shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums ";

type PanelKey = "hot" | "best" | "trending" | "cooling" | "worst" | "falling";
// Hot streaks and Cooling off are /cappers' Hot Hand and Coldest (same rows, see CapperPanels), so they
// share those panels' hues, icons and wording. `basis` is the footer's note on what the panel reads.
const THEME: Record<PanelKey, PanelTheme & { basis: string; empty: string }> = {
  hot: {
    ...TINTS.orange,
    title: "Hot streaks",
    subtitle: "Current win streaks lighting up",
    icon: <FlameFilledIcon className={ICON} />,
    basis: "Active this week",
    empty: "No cappers on a " + STREAK_PANEL_MIN + "+ game win streak this week.",
  },
  best: {
    ...TINTS.green,
    title: "Best last 20",
    subtitle: "Strongest recent records",
    icon: <TargetIcon className={ICON + " stroke-[2.2]"} />,
    basis: "Last 20 graded picks, 50%+",
    empty: "No active capper is at 50% or better over their last 20.",
  },
  trending: {
    ...TINTS.green,
    title: "Trending",
    subtitle: "Recent form on the way up",
    icon: <TrendingUpIcon className={ICON + " stroke-[2.4]"} />,
    iconWrap: "rounded-lg bg-[#DCF7E6] text-[#15803D] dark:bg-emerald-500/15 dark:text-emerald-400",
    basis: "Last 5 picks vs the 5 before",
    empty: "Nobody's recent form is clearly up yet.",
  },
  cooling: {
    ...TINTS.red,
    title: "Cooling off",
    subtitle: "Who's on a cold streak",
    icon: <SnowflakeIcon className={ICON} />,
    basis: "Active this week",
    empty: "No cappers on a " + STREAK_PANEL_MIN + "+ game losing streak this week.",
  },
  worst: {
    ...TINTS.red,
    title: "Worst last 20",
    subtitle: "Weakest recent records",
    icon: <AlertTriangleIcon className={ICON + " stroke-[2.2]"} />,
    basis: "Last 20 graded picks, under 50%",
    empty: "No active capper is under 50% over their last 20.",
  },
  falling: {
    ...TINTS.rose,
    title: "Falling off",
    subtitle: "Recent form below their norm",
    icon: <TrendingDownIcon className={ICON + " stroke-[2.4]"} />,
    basis: "Last 10 picks vs lifetime",
    empty: "Nobody's recent form is clearly down.",
  },
};

type Row = { capperId: string; name: string; value: ReactNode };

function DashboardPanel({ panel, rows }: { panel: PanelKey; rows: Row[] }) {
  const t = THEME[panel];
  return (
    <PanelShell
      theme={t}
      footer={
        <>
          <p className={FOOTER_TEXT}>{t.basis}</p>
          <Link href="/cappers" className={FOOTER_LINK + " " + t.accent}>
            View all →
          </Link>
        </>
      }
    >
      {rows.length === 0 ? (
        <Message>{t.empty}</Message>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {rows.slice(0, PANEL_ROWS).map((r, i) => (
            <li key={r.capperId}>
              <Link href={"/cappers/" + r.capperId} className={ROW}>
                <Rank n={i + 1} />
                <span className="min-w-0 flex-1">
                  <Name>{r.name}</Name>
                </span>
                {r.value}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </PanelShell>
  );
}

const pct = (n: number) => Math.round(n) + "%";
// "12–6  67%": the record, then the win % in the app's win/loss color.
function recordValue(e: BestLast20Entry) {
  return (
    <span className={VALUE + "text-foreground"}>
      {e.wins + "–" + e.losses + (e.pushes > 0 ? "–" + e.pushes : "")}
      <span className={"ml-2 inline-block min-w-[34px] text-sm " + (getRecordColor(e.recentWinPct) === "green" ? GREEN : RED)}>{pct(e.recentWinPct)}</span>
    </span>
  );
}

// The Cappers page's panels in brief, right on the Dashboard: three rows each, the rest a click away.
// Each panel sits with its mirror. Three across (from ~1500px) the grid fills by column, so the top
// row is what is going well (Hot streaks | Best last 20 | Trending) over Cooling off | Worst last 20 |
// Falling off; two across the pairs are side by side; on a phone each is followed by its mirror.
export function TrendingCappers({ panels }: { panels: CapperPanels }) {
  const base = (e: { capperId: string; name: string }) => ({ capperId: e.capperId, name: e.name });
  return (
    <div className="grid grid-cols-1 items-stretch gap-3.5 min-[1100px]:grid-cols-2 min-[1500px]:grid-flow-col min-[1500px]:grid-cols-3 min-[1500px]:grid-rows-2">
      <DashboardPanel panel="hot" rows={panels.hotStreaks.map((e) => ({ ...base(e), value: <span className={VALUE + GREEN}>{e.streak}-game win streak</span> }))} />
      <DashboardPanel panel="cooling" rows={panels.coolingOff.map((e) => ({ ...base(e), value: <span className={VALUE + RED}>{e.streak}-game losing streak</span> }))} />
      <DashboardPanel panel="best" rows={panels.bestLast20.map((e) => ({ ...base(e), value: recordValue(e) }))} />
      <DashboardPanel panel="worst" rows={panels.worstLast20.map((e) => ({ ...base(e), value: recordValue(e) }))} />
      <DashboardPanel
        panel="trending"
        rows={panels.rising.map((e) => ({ ...base(e), value: <span className={VALUE + GREEN}>{pct(e.previousWinPct) + " → " + pct(e.recentWinPct)}</span> }))}
      />
      <DashboardPanel
        panel="falling"
        rows={panels.fallingOff.map((e) => ({ ...base(e), value: <span className={VALUE + THEME.falling.accent}>{pct(e.lifetimeWinPct) + " → " + pct(e.recentWinPct)}</span> }))}
      />
    </div>
  );
}
