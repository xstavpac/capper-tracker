import { FEED_LABEL, FEED_NAMES, OFF_SEASON_DAYS, RECENT_DAYS, STATUS_LABEL, SYNC_STALE_HOURS, formatHoursAgo, type FeedName, type FeedStatus, type LeagueFeedHealth } from "@/lib/feed-health";
import { PanelShell, TINTS, GREEN, RED, FOOTER_TEXT, type PanelTint } from "@/components/dashboard/panel-shell";

// One league's card on the ops console's Feed health tab: status (tint, pill,
// reasons), played / posted counts, and each feed's last sync. Server-rendered,
// no state.
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

export function LeagueFeedCard({ h, now }: { h: LeagueFeedHealth; now: Date }) {
  const n = now.getTime();
  const theme = {
    ...TINT[h.status],
    title: h.label,
    subtitle: h.note ?? subtitleFor(h, now.getTime()),
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
          Warns: ≥{t.minRecent} games / {RECENT_DAYS}d, then none for {t.quietPastDays}d back + {t.quietFutureDays}d ahead
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
          hint={`${h.nextGameAt ? `next in ${formatHoursAgo(h.nextGameAt.getTime() - n)}` : h.postedSource ? "none posted" : "nothing stored"} · ${h.postedSource === "schedule" ? "schedule" : h.postedSource === "odds" ? "odds" : "no source"}`}
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
        {s?.lastSuccessAt ? (
          now - s.lastSuccessAt.getTime() <= SYNC_STALE_HOURS[feed] * 3_600_000 ? (
            <span className={GREEN}>✓ {formatHoursAgo(now - s.lastSuccessAt.getTime())} ago</span>
          ) : (
            // Past the limit: a problem in season, expected off season (gated feeds stop).
            <span className={h.status === "off_season" ? "text-muted-foreground" : RED}>
              {h.status === "off_season" ? "" : "⚠ "}last success {formatHoursAgo(now - s.lastSuccessAt.getTime())} ago
            </span>
          )
        ) : (
          <span className="text-muted-foreground">no success recorded</span>
        )}
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

// The line under the title: what the card is about at a glance (the pill
// already says the status).
function subtitleFor(h: LeagueFeedHealth, now: number): string {
  if (h.status === "check_feed") return h.reasons.length === 1 ? "1 problem below" : `${h.reasons.length} problems below`;
  if (h.status === "off_season") return `no games within ${OFF_SEASON_DAYS} days either side`;
  if (h.nextGameAt) return `next game in ${formatHoursAgo(h.nextGameAt.getTime() - now)}`;
  return h.lastGameAt ? `last game ${formatHoursAgo(now - h.lastGameAt.getTime())} ago` : STATUS_LABEL[h.status];
}
