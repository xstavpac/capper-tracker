import type { BestLast20Entry, CapperPanels } from "@/server/data/capper-panels";
import { getRecordColor } from "@/server/data/stats";
import { CapperPanel, FormPanel } from "@/components/dashboard/capper-panel";
import { Last20Panel, type Last20Row } from "@/components/dashboard/last20-panel";
import { GREEN, RED } from "@/components/dashboard/panel-shell";

// On /cappers a panel's "View all" jumps to the leaderboard below it; from here it is another page.
const LEADERBOARD = "/cappers#leaderboard";
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
//   Hot Hand | Rising Fast | Best last 20
//   Coldest  | Falling off | Worst last 20
// Three across (from ~1500px) the grid fills by column, so the DOM order is pair by pair; two across
// each pair sits side by side, and on a phone each panel is followed by its opposite.
// Hot Hand, Coldest and Rising Fast are the /cappers panels themselves (capper-panel.tsx), window
// dropdowns included; Falling off is Rising Fast's mirror.
// Cards in a row share its height until a Best / Worst last 20 card is opened ("See more"): from then
/// on each keeps its own height (h-auto undoes PanelShell's h-full) and the two rows stop
// sharing one height, so only the opened card, and only its row, grows.
export function DashboardPanels({ panels }: { panels: CapperPanels }) {
  return (
    <div className="grid grid-cols-1 items-stretch gap-3.5 has-[[data-expanded=true]]:items-start [&:has([data-expanded=true])>*]:h-auto min-[1100px]:grid-cols-2 min-[1500px]:grid-flow-col min-[1500px]:grid-cols-3 min-[1500px]:grid-rows-2 min-[1500px]:has-[[data-expanded=true]]:grid-rows-[repeat(2,auto)]">
      <CapperPanel panel="hottest" initial={panels.hottest} leaderboardHref={LEADERBOARD} />
      <CapperPanel panel="coldest" initial={panels.coldest} leaderboardHref={LEADERBOARD} />
      <FormPanel panel="rising" rows={panels.rising} />
      <FormPanel panel="falling" rows={panels.falling} />
      <Last20Panel panel="best" rows={last20Rows(panels.bestLast20)} leaderboardHref={LEADERBOARD} />
      <Last20Panel panel="worst" rows={last20Rows(panels.worstLast20)} leaderboardHref={LEADERBOARD} />
    </div>
  );
}
