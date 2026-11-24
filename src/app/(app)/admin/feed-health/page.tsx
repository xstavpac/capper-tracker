import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadFeedHealth } from "@/server/data/feed-health";
import { IN_SEASON_DAYS, RECENT_DAYS, feedHealthReport } from "@/lib/feed-health";
import { formatAdminReport } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";
import { LeagueFeedCard } from "@/components/admin/feed-health-card";

// Feed health, admin-only (requireAdminOpsPage): per league, whether the
// stored schedule looks like a season in progress, an off season, or a broken
// feed - derived from stored games and sync records only, no season calendar
// (rules and thresholds: lib/feed-health.ts). One aggregate statement per
// load (loadFeedHealth), read fresh; no cache, no polling. Reload to refresh.
export default async function FeedHealthPage() {
  await requireAdminOpsPage();
  const now = new Date();
  const health = await loadFeedHealth(now);
  const report = formatAdminReport(feedHealthReport(health, now));
  const flagged = health.filter((h) => h.status === "check_feed");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Feed health</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each league&apos;s stored schedule: finals played (game_results) and games posted in the latest odds snapshot, plus each feed&apos;s last successful sync. Status comes from this data alone, no season calendar. Reload to refresh.
          </p>
        </div>
        <CopyReportButton report={report} />
      </div>

      {flagged.length > 0 && (
        <p className="text-sm font-medium text-[#C2410C] dark:text-orange-400">
          {flagged.length === 1 ? "1 league needs" : `${flagged.length} leagues need`} a feed check: {flagged.map((h) => h.label).join(", ")}.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {health.map((h) => (
          <LeagueFeedCard key={h.sportKey} h={h} now={now} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        In season: a game played or posted within {IN_SEASON_DAYS} days. ⚠ Check feed: a busy stretch ({RECENT_DAYS} days) followed by an empty schedule on both sides, or a feed that stopped
        syncing mid-season. Posted games reach only as far as the Odds API lists - about a week for NFL and NCAAF, the current day for the other leagues. NCAAB stores finals only for games
        with picks.
      </p>

      <ReportDetails report={report} />
    </div>
  );
}
