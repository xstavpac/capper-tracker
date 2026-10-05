import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getDashboardSummary, STALE_PENDING_HOURS } from "@/server/data/dashboard-summary";
import { getCapperPanels } from "@/server/data/capper-panels";
import { ThemedPage } from "@/components/dashboard/themed-page";
import { PageBanner } from "@/components/dashboard/page-banner";
import { DashboardStatCards } from "@/components/dashboard/dashboard-stat-cards";
import { DashboardCategoryCards } from "@/components/dashboard/dashboard-category-cards";
import { DashboardPanels } from "@/components/dashboard/dashboard-panels";
import { UnitsChart } from "@/components/dashboard/units-chart";
import { FOOTER_LINK, FOOTER_TEXT, GREEN, PanelShell, RED, TINTS } from "@/components/dashboard/panel-shell";
import { ActivityIcon, ListIcon } from "@/components/dashboard/cappers-icons";
import dashboardBanner from "../../../../public/banners/dashboard.png";

const ICON = "h-[17px] w-[17px] stroke-[2.2]";
const PERFORMANCE = { ...TINTS.neutral, title: "Performance", subtitle: "Cumulative units across every settled pick", icon: <ActivityIcon className={ICON} /> };
const RECENT = { ...TINTS.neutral, title: "Recent picks", subtitle: "The latest ten, newest first", icon: <ListIcon className={ICON} /> };

export default async function DashboardPage() {
  const user = await requireUser();
  const [summary, panels] = await Promise.all([getDashboardSummary(user.id), getCapperPanels(user.id)]);
  const { chartData, stalePendingCount } = summary;

  return (
    <ThemedPage>
      {/* dashboard.png is 2040x221. In its own pixels the icon's circle spans 82-256 (centre 111
          down), the art's divider is at 305-308, the word spans 369-1125 and the illustration starts
          at 1200. A phone's row is 52px, and its motto is centred like the word. From `sm` up the
          crop ends 10px before the illustration's start in the 104px row (565px) and the 112px row
          (608px), and the motto is indented to sit under the D: 174px in the 104px row (960px of
          art) and 187px in the 112px row (1034px). */}
      <PageBanner
        src={dashboardBanner}
        title="Dashboard"
        className="bg-[#001637]"
        phone={{ height: 52, circle: { left: 82, right: 256, centerY: 111 }, word: { start: 369, end: 1125 } }}
        cropClassName="sm:w-[555px] lg:w-[598px]"
        glow="card"
      >
        <p className="whitespace-nowrap pb-[11px] text-[9.5px] font-bold uppercase tracking-[2px] text-[#BFD3FF] max-sm:text-center sm:pb-4 sm:pl-[174px] sm:text-[13px] sm:tracking-[3.5px] lg:pl-[187px]">
          Track <span className="text-[#38BDF8]">·</span> Compare <span className="text-[#38BDF8]">·</span> Decide
        </p>
      </PageBanner>

      <DashboardStatCards summary={summary} />

      {stalePendingCount > 0 && (
        <a
          href="/picks/pending"
          className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
        >
          <span>
            {stalePendingCount} pick{stalePendingCount === 1 ? " has" : "s have"} been pending over{" "}
            {STALE_PENDING_HOURS} hours - review them
          </span>
          <span className="font-semibold">&rarr;</span>
        </a>
      )}

      <section className="space-y-2 pt-1">
        <h2 className="px-0.5 text-[15px] font-semibold tracking-[-0.01em] text-foreground">Record by category</h2>
        <DashboardCategoryCards items={summary.categoryBreakdown} />
      </section>

      <DashboardPanels panels={panels} />

      <PanelShell theme={PERFORMANCE} footer={undefined}>
        <UnitsChart data={chartData} themed />
      </PanelShell>

      <PanelShell
        theme={RECENT}
        footer={
          summary.recentPicks.length > 0 && (
            <>
              <p className={FOOTER_TEXT}>
                {summary.totalPicks.toLocaleString("en-US")} pick{summary.totalPicks === 1 ? "" : "s"} tracked
              </p>
              <Link href="/picks" className={FOOTER_LINK + " " + RECENT.accent}>
                View all →
              </Link>
            </>
          )
        }
      >
        {summary.recentPicks.length === 0 ? (
          <p className="py-6 text-center text-[13px] font-medium text-muted-foreground">No picks yet - add your first capper to get started.</p>
        ) : (
          <ul className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
            {summary.recentPicks.map((pick) => (
              <li key={pick.id} className="flex items-center justify-between gap-3 px-1.5 py-2 text-[13px] font-medium">
                <span className="min-w-0 text-foreground">
                  {pick.awayTeam} @ {pick.homeTeam} - {pick.label}
                  <span className="text-[#5B6275] dark:text-muted-foreground"> ({pick.capperName})</span>
                </span>
                <span className={"shrink-0 whitespace-nowrap font-semibold tabular-nums " + (pick.status === "WIN" ? GREEN : pick.status === "LOSS" ? RED : "text-[#5B6275] dark:text-muted-foreground")}>
                  {pick.status === "PENDING" ? "Pending" : pick.status + " - " + pick.units + "u"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelShell>
    </ThemedPage>
  );
}
