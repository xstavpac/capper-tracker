import { requireAdminOpsPage } from "@/server/admin-gate";
import { loadFeedHealth } from "@/server/data/feed-health";
import {
  FEED_LABEL,
  FEED_NAMES,
  IN_SEASON_DAYS,
  RECENT_DAYS,
  STATUS_LABEL,
  feedHealthReport,
  formatHoursAgo,
  type FeedName,
  type FeedStatus,
  type LeagueFeedHealth,
} from "@/lib/feed-health";
import { formatAdminReport } from "@/lib/admin-report";
import { CopyReportButton, ReportDetails } from "@/components/admin/report-controls";
import { PanelShell, TINTS, GREEN, RED, FOOTER_TEXT, type PanelTint } from "@/components/dashboard/panel-shell";

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
          <LeagueCard key={h.sportKey} h={h} now={now} />
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

// Off season is the plain card without the stat cards' soft drop shadow.
const OFF_SEASON: PanelTint = { ...TINTS.neutral, card: "border-[#E3E6EC] bg-white dk-tint [--tint:148_163_184] dark:border-border dark:bg-card" };
const TINT: Record<FeedStatus, PanelTint> = { in_season: TINTS.green, off_season: OFF_SEASON, check_feed: TINTS.orange };
const GLYPH: Record<FeedStatus, { char: string; className: string }> = {
  in_season: { char: "●", className: "text-[11px] text-[#16A34A] dark:text-emerald-400" },
  off_season: { char: "–", className: "text-sm font-semibold text-muted-foreground" },
  check_feed: { char: "⚠", className: "text-[13px] text-[#C2410C] dark:text-orange-400" },
};
const PILL: Record<FeedStatus, string> = {
  in_season: "bg-[#DCF7E6] text-[#15803D] dark:bg-emerald-500/15 dark:text-emerald-400",
  off_season: "bg-[#EEF0F4] text-[#4B5263] dark:bg-white/10 dark:text-muted-foreground",
  check_feed: "bg-[#FFE3CC] text-[#C2410C] dark:bg-orange-500/15 dark:text-orange-400",
};

function LeagueCard({ h, now }: { h: LeagueFeedHealth; now: Date }) {
  const n = now.getTime();
  const theme = {
    ...TINT[h.status],
    title: h.label,
    subtitle: h.note ?? (h.status === "check_feed" ? `${h.reasons.length === 1 ? "1 problem" : `${h.reasons.length} problems`} below` : STATUS_LABEL[h.status]),
    icon: <span aria-hidden className={GLYPH[h.status].className}>{GLYPH[h.status].char}</span>,
  };
  const t = h.thresholds;
  return (
    <PanelShell
      theme={theme}
      wrapSubtitle
      titleBadge={<span className={"ml-2 inline-flex rounded-full px-2 py-0.5 align-[1px] text-[11px] font-semibold " + PILL[h.status]}>{STATUS_LABEL[h.status]}</span>}
      footer={
        <p className={FOOTER_TEXT} title="Check feed thresholds (lib/feed-health.ts)">
          Warns after ≥{t.minRecent} games in {RECENT_DAYS}d, then {t.quietPastDays}d with none played and {t.quietFutureDays}d with none posted
        </p>
      }
    >
      {h.reasons.length > 0 && (
        <ul className="mb-2 space-y-1">
          {h.reasons.map((r) => (
            <li key={r} className="text-xs font-medium leading-4 text-[#9A3412] dark:text-orange-300">
              {r}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid grid-cols-2 gap-2">
        <Count label="Played · last 7 days" value={h.past7} hint={h.lastGameAt ? `last ${formatHoursAgo(n - h.lastGameAt.getTime())} ago` : `none in ${RECENT_DAYS} days`} />
        <Count
          label="Posted · next 7 days"
          value={h.next7}
          hint={h.nextGameAt ? `next in ${formatHoursAgo(h.nextGameAt.getTime() - n)}` : h.postedFetchDate ? "none posted" : "no snapshot today/yesterday"}
        />
      </dl>
      <dl className="mt-2.5 space-y-1.5">
        {FEED_NAMES.map((feed) => (
          <SyncLine key={feed} feed={feed} h={h} now={n} />
        ))}
      </dl>
    </PanelShell>
  );
}

function Count({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-[10px] border border-[#0F1420]/[0.08] bg-white/70 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
      <dd className="truncate text-[11px] text-muted-foreground">{hint}</dd>
    </div>
  );
}

function SyncLine({ feed, h, now }: { feed: FeedName; h: LeagueFeedHealth; now: number }) {
  const s = h.syncs[feed];
  const errorIsLatest = !!s?.lastErrorAt && (!s.lastSuccessAt || s.lastErrorAt > s.lastSuccessAt);
  return (
    <div className="text-xs leading-4">
      <dt className="font-medium text-muted-foreground">{FEED_LABEL[feed]}</dt>
      <dd className="text-foreground">
        {s?.lastSuccessAt ? <span className={GREEN}>✓ {formatHoursAgo(now - s.lastSuccessAt.getTime())} ago</span> : <span className="text-muted-foreground">no success recorded</span>}
        {s?.lastErrorAt && (
          <span className={errorIsLatest ? RED : "text-muted-foreground"} title={s.lastError ?? undefined}>
            {" "}
            · last error {formatHoursAgo(now - s.lastErrorAt.getTime())} ago{s.lastError ? `: ${s.lastError.slice(0, 80)}` : ""}
          </span>
        )}
      </dd>
    </div>
  );
}
