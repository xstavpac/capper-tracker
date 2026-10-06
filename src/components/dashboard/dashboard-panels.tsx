import type { BestLast20Entry, CapperPanels } from "@/server/data/capper-panels";
import { getRecordColor } from "@/server/data/stats";
import { LIVE_SPORTS } from "@/server/data/odds";
import { easternDateKey } from "@/lib/dates";
import { CapperPanel, FormPanel } from "@/components/dashboard/capper-panel";
import { Last20Panel, type Last20Row } from "@/components/dashboard/last20-panel";
import { LeagueSavantPanel } from "@/components/dashboard/league-savant-panel";
import { GREEN, RED } from "@/components/dashboard/panel-shell";

// On /cappers a panel's "View all" jumps to the leaderboard below it; from here it is another page.
const LEADERBOARD = "/cappers#leaderboard";
// The leagues its league filter accepts (cappers/page.tsx): League Savant's "View all" carries one.
const LEADERBOARD_LEAGUES = LIVE_SPORTS.map((s) => s.label);
const record = (e: BestLast20Entry) => e.wins + "–" + e.losses + (e.pushes > 0 ? "–" + e.pushes : "");
// Best holds the cappers at 50% or better, Worst the rest, so nobody is in both. Each row's win % is
// in the app's win / loss color.
const last20Rows = (rows: BestLast20Entry[]): Last20Row[] =>
  rows.map((e) => ({
    capperId: e.capperId,
    name: e.name,
    record: record(e),
    pct: Math.round(e.recentWinPct) + "%",
    pctClass: getRecordColor(e.recentWinPct) === "green" ? GREEN : RED,
  }));

// "Right now": streaks and recent form. Top row what is going well, under each its opposite:
//   Hot Hand | League Savant | Best last 20
//   Coldest  | Falling off   | Worst last 20
// Three across (from ~1500px) the grid fills by column, so the DOM order is pair by pair; two across
// each pair sits side by side, and on a phone each panel is followed by the one under it.
// Hot Hand and Coldest are the /cappers panels themselves (capper-panel.tsx), window dropdowns
// included. League Savant's league is the day's (Eastern) unless the viewer picked one today.
// Every card is its own height (items-start; h-auto undoes PanelShell's h-full) with one shared
// minimum from two across up: the height of a full five-row card, so collapsed cards line up. Opening
// a League Savant or Best / Worst last 20 card ("See more") then grows that card, and its row, and
// nothing else. One across (a phone) there is no minimum: a short card would only carry empty space.
export function DashboardPanels({ panels }: { panels: CapperPanels }) {
  return (
    <div className="grid grid-cols-1 items-start gap-3.5 [&>*]:h-auto min-[1100px]:grid-cols-2 min-[1100px]:[&>*]:min-h-[340px] min-[1500px]:grid-flow-col min-[1500px]:grid-cols-3 min-[1500px]:grid-rows-[repeat(2,auto)]">
      <CapperPanel panel="hottest" initial={panels.hottest} leaderboardHref={LEADERBOARD} />
      <CapperPanel panel="coldest" initial={panels.coldest} leaderboardHref={LEADERBOARD} />
      <LeagueSavantPanel savant={panels.savant} dateKey={easternDateKey(new Date())} filterable={LEADERBOARD_LEAGUES} leaderboardHref={LEADERBOARD} />
      <FormPanel panel="falling" rows={panels.falling} />
      <Last20Panel panel="best" rows={last20Rows(panels.bestLast20)} leaderboardHref={LEADERBOARD} />
      <Last20Panel panel="worst" rows={last20Rows(panels.worstLast20)} leaderboardHref={LEADERBOARD} />
    </div>
  );
}
