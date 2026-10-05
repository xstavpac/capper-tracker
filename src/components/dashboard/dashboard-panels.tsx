import Link from "next/link";
import type { BestLast20Entry, CapperPanels } from "@/server/data/capper-panels";
import { getRecordColor } from "@/server/data/stats";
import { CapperPanel, FormPanel } from "@/components/dashboard/capper-panel";
import { AlertTriangleIcon, TargetIcon } from "@/components/dashboard/cappers-icons";
import { CONTROL, FOOTER_LINK, FooterLine, GREEN, Message, Name, PanelShell, RED, ROW, Rank, TINTS, type PanelTheme } from "@/components/dashboard/panel-shell";

// On /cappers a panel's "View all" jumps to the leaderboard below it; from here it is another page.
const LEADERBOARD = "/cappers#leaderboard";
const ICON = "h-[17px] w-[17px] stroke-[2.2]";

const LAST20: Record<"best" | "worst", PanelTheme & { empty: string; lead: string; footerIcon: string }> = {
  best: {
    ...TINTS.green,
    title: "Best last 20",
    subtitle: "Strongest recent records",
    icon: <TargetIcon className={ICON} />,
    empty: "No active capper is at 50% or better over their last 20.",
    lead: "leads at",
    footerIcon: GREEN,
  },
  worst: {
    ...TINTS.red,
    title: "Worst last 20",
    subtitle: "Weakest recent records",
    icon: <AlertTriangleIcon className={ICON} />,
    empty: "No active capper is under 50% over their last 20.",
    lead: "trails at",
    footerIcon: RED,
  },
};

const record = (e: BestLast20Entry) => e.wins + "–" + e.losses + (e.pushes > 0 ? "–" + e.pushes : "");
const pct = (e: BestLast20Entry) => Math.round(e.recentWinPct) + "%";
const pctClass = (e: BestLast20Entry) => (getRecordColor(e.recentWinPct) === "green" ? GREEN : RED);

// A ranked list: each capper's record over their last 20 graded picks and its win %, in the app's
// win / loss color. Best holds the cappers at 50% or better, Worst the rest, so nobody is in both.
function Last20Panel({ panel, rows }: { panel: "best" | "worst"; rows: BestLast20Entry[] }) {
  const t = LAST20[panel];
  const Icon = panel === "best" ? TargetIcon : AlertTriangleIcon;
  return (
    <PanelShell
      theme={t}
      control={<span className={CONTROL + " shrink-0 whitespace-nowrap px-2.5 py-[5px] " + t.control}>Last 20 picks</span>}
      footer={
        rows.length > 0 && (
          <>
            <Icon className={"h-[18px] w-[18px] shrink-0 stroke-[2.2] " + t.footerIcon} />
            <FooterLine name={rows[0].name}>
              {t.lead} <span className={"font-semibold tabular-nums " + pctClass(rows[0])}>{pct(rows[0]) + " (" + record(rows[0]) + ")"}</span>
            </FooterLine>
            <Link href={LEADERBOARD} className={FOOTER_LINK + " " + t.accent}>
              View all →
            </Link>
          </>
        )
      }
    >
      {rows.length === 0 ? (
        <Message>{t.empty}</Message>
      ) : (
        <ol className="flex flex-col gap-0.5">
          {rows.map((e, i) => (
            <li key={e.capperId}>
              <Link href={"/cappers/" + e.capperId} className={ROW}>
                <Rank n={i + 1} />
                <span className="min-w-0 flex-1">
                  <Name>{e.name}</Name>
                </span>
                <span className="shrink-0 whitespace-nowrap text-right text-xs font-medium tabular-nums text-foreground">{record(e)}</span>
                <span className={"w-10 shrink-0 text-right text-sm font-semibold tabular-nums " + pctClass(e)}>{pct(e)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </PanelShell>
  );
}

// "Right now": streaks and recent form. Top row what is going well, under each its opposite:
//   Hot Hand | Rising Fast | Best last 20
//   Coldest  | Falling off | Worst last 20
// Three across (from ~1500px) the grid fills by column, so the DOM order is pair by pair; two across
// each pair sits side by side, and on a phone each panel is followed by its opposite.
// Hot Hand, Coldest and Rising Fast are the /cappers panels themselves (capper-panel.tsx), window
// dropdowns included; Falling off is Rising Fast's mirror.
export function DashboardPanels({ panels }: { panels: CapperPanels }) {
  return (
    <div className="grid grid-cols-1 items-stretch gap-3.5 min-[1100px]:grid-cols-2 min-[1500px]:grid-flow-col min-[1500px]:grid-cols-3 min-[1500px]:grid-rows-2">
      <CapperPanel panel="hottest" initial={panels.hottest} leaderboardHref={LEADERBOARD} />
      <CapperPanel panel="coldest" initial={panels.coldest} leaderboardHref={LEADERBOARD} />
      <FormPanel panel="rising" rows={panels.rising} />
      <FormPanel panel="falling" rows={panels.falling} />
      <Last20Panel panel="best" rows={panels.bestLast20} />
      <Last20Panel panel="worst" rows={panels.worstLast20} />
    </div>
  );
}
