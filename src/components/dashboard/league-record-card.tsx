import { getRecordColor, type LeagueRecordColumn, LEAGUE_RECORD_LAST_N } from "@/server/data/stats";
import { FavoriteStarIcon } from "@/components/dashboard/capper-panels";

// The league-specific capper record card: one bet-type category, shown three
// ways - Overall (all leagues), the current league (emphasized), and the
// capper's last 20 graded picks in that category. All three numbers come from
// computeLeagueRecordCards (one shared pipeline - see stats.ts); this
// component is purely presentational.
//
// Full three-column layout, for the capper detail page. On production game
// cards (8+ picks stacked) three columns per pick is too dense / wraps at
// mobile widths - a condensed variant is proposed separately, not shipped
// here.

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function LeagueBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
    </svg>
  );
}

const RECORD_TEXT: Record<ReturnType<typeof getRecordColor>, string> = {
  green: "text-emerald-600 dark:text-emerald-400",
  red: "text-red-600 dark:text-red-400",
};

function recordText(c: LeagueRecordColumn) {
  return c.wins + "-" + c.losses + (c.pushes > 0 ? "-" + c.pushes : "");
}

// A single stat column. `decided` (wins+losses) drives whether a percentage
// shows at all - a column with only pushes, or no graded picks, shows "—".
function StatColumn({
  icon,
  label,
  column,
  emphasized = false,
}: {
  icon: React.ReactNode;
  label: string;
  column: LeagueRecordColumn;
  emphasized?: boolean;
}) {
  const decided = column.wins + column.losses;
  const color = getRecordColor(column.winPct);
  return (
    <div className="flex flex-1 flex-col items-center px-2 text-center">
      <div
        className={
          "flex items-center gap-1 text-[11px] " +
          (emphasized ? "font-semibold text-foreground" : "text-muted-foreground")
        }
      >
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{recordText(column)}</div>
      <div className={"text-xs font-medium tabular-nums " + (decided > 0 ? RECORD_TEXT[color] : "text-muted-foreground")}>
        {decided > 0 ? "(" + Math.round(column.winPct) + "%)" : "—"}
      </div>
    </div>
  );
}

export function LeagueRecordCard({
  capperName,
  isVerified,
  betTypeLabel,
  leagueName,
  overall,
  league,
  last20,
}: {
  capperName: string;
  isVerified: boolean;
  betTypeLabel: string;
  leagueName: string;
  overall: LeagueRecordColumn;
  league: LeagueRecordColumn;
  last20: LeagueRecordColumn | null;
}) {
  return (
    <div className="rounded-card border border-border-subtle bg-card p-3 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{capperName}</span>
            {isVerified && <FavoriteStarIcon />}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{betTypeLabel}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
          <LeagueBadgeIcon />
          {leagueName}
        </span>
      </div>

      <div className="mt-3 flex items-stretch divide-x divide-border-subtle">
        <StatColumn icon={<GlobeIcon />} label="Overall" column={overall} />
        <StatColumn icon={<LeagueBadgeIcon />} label={leagueName} column={league} emphasized />
        {last20 ? (
          <StatColumn icon={<ClockIcon />} label={"Last " + LEAGUE_RECORD_LAST_N} column={last20} />
        ) : (
          <div className="flex flex-1 flex-col items-center px-2 text-center">
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ClockIcon />
              <span>Last {LEAGUE_RECORD_LAST_N}</span>
            </div>
            <div className="mt-1 text-sm font-semibold text-muted-foreground">&mdash;</div>
            <div className="text-[11px] text-muted-foreground">Need {LEAGUE_RECORD_LAST_N} picks</div>
          </div>
        )}
      </div>
    </div>
  );
}
