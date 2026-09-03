import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import { MLB_UNDERDOG_WIN_RATE, MIN_GAMES_FOR_VERDICT, type BoardPulseStats, type BoardPulseVerdict } from "@/lib/board-pulse";

const GAUGE_VIEWBOX_W = 200;
const GAUGE_VIEWBOX_H = 112;
const GAUGE_CX = 100;
const GAUGE_CY = 100;
const GAUGE_R = 84;
const GAUGE_STROKE = 16;

// Semicircle path, left to right through the top - pathLength=100 lets
// strokeDasharray be expressed directly as "percent of the arc", regardless
// of the actual pixel radius.
const ARC_PATH = `M ${GAUGE_CX - GAUGE_R} ${GAUGE_CY} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${GAUGE_CX + GAUGE_R} ${GAUGE_CY}`;

// The arc is a PROGRESS indicator: confirmed upsets as a fraction of the whole
// day's expected total. Its color is driven by `verdict` (the pace-vs-expected
// judgment, see board-pulse.ts's classifyPace) - not by its own fill fraction.
// The two are separate facts: "how far through today's expected upsets are we"
// (the arc) vs "are the finished games running ahead of / behind the pace the
// baseline predicts" (the color, and the pace banner above).
function Gauge({ count, expected, verdict }: { count: number; expected: number; verdict: BoardPulseVerdict }) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const fraction = expected > 0 ? Math.min(count / expected, 1) : 0;
  const color = verdict === "hot" ? "#dc2626" : verdict === "cold" ? "#f97316" : "#9ca3af"; // red-600 / orange-500 / gray-400 - saturated/mid enough to stay readable on dark unmodified
  const trackColor = isDark ? "#374151" : "#e5e7eb"; // border token's dark/light value - the arc's unfilled track

  return (
    <div className="relative inline-block">
      <svg viewBox={`0 0 ${GAUGE_VIEWBOX_W} ${GAUGE_VIEWBOX_H}`} className="h-[124px] w-[220px]">
        <path
          d={ARC_PATH}
          pathLength={100}
          fill="none"
          stroke={trackColor}
          strokeWidth={GAUGE_STROKE}
          strokeLinecap="round"
        />
        <path
          d={ARC_PATH}
          pathLength={100}
          fill="none"
          stroke={color}
          strokeWidth={GAUGE_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end pb-1 text-center">
        <div className="text-3xl font-bold text-foreground">{count}</div>
        <div className="text-xs text-muted-foreground">confirmed upsets</div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card bg-muted p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

export function BoardPulsePanel({ stats }: { stats: BoardPulseStats }) {
  const liveLeaders = stats.favsLeadingLive + stats.dogsLeadingLive;

  // Pace banner - the headline. Colour by verdict: hot -> red, cold -> orange,
  // "on pace" / "insufficient" -> neutral (an on-pace upset count is neither
  // good nor bad).
  const bannerClass =
    stats.verdict === "hot"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300"
      : stats.verdict === "cold"
        ? "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/25 dark:bg-orange-500/10 dark:text-orange-300"
        : "border-border-subtle bg-muted text-muted-foreground";
  const dotClass =
    stats.verdict === "hot" ? "bg-red-500" : stats.verdict === "cold" ? "bg-orange-500" : "bg-muted-foreground/50";
  const bannerTitle =
    stats.verdict === "insufficient"
      ? `Not enough final games to call the pace (${stats.decidedGames}/${MIN_GAMES_FOR_VERDICT})`
      : stats.verdict === "on pace"
        ? "Upsets on pace"
        : "Upsets running " + stats.verdict; // "hot" | "cold"
  const signedPace = (stats.paceDelta >= 0 ? "+" : "") + stats.paceDelta.toFixed(1);

  const rateDeltaPts = stats.upsetRate !== null ? Math.round((stats.upsetRate - MLB_UNDERDOG_WIN_RATE) * 100) : 0;

  const badgeClass =
    stats.verdict === "hot"
      ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400"
      : stats.verdict === "cold"
        ? "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400"
        : "bg-muted text-muted-foreground";
  const badgeText =
    stats.verdict === "insufficient"
      ? "not enough games yet"
      : stats.verdict === "on pace"
        ? "running on pace"
        : "running " + (stats.verdict === "hot" ? "above" : "below") + " average";

  return (
    <div className="mb-6 rounded-card bg-card p-6 shadow-soft">
      <h2 className="text-base font-semibold text-foreground">Board pulse &middot; live</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {stats.gameCount} game{stats.gameCount === 1 ? "" : "s"} today &middot; {stats.decidedGames} final &middot; updates
        live
      </p>

      <div className={"mt-4 rounded-card border px-4 py-3 " + bannerClass}>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className={"h-2 w-2 shrink-0 rounded-full " + dotClass} />
            {bannerTitle}
          </span>
          {stats.verdict !== "insufficient" && (
            <span className="shrink-0 text-sm font-semibold tabular-nums">{signedPace} vs expected</span>
          )}
        </div>
        {stats.verdict !== "insufficient" && (
          <p className="mt-1 text-xs opacity-80">
            {stats.upsetsConfirmed} confirmed vs {stats.expectedUpsetsSoFar.toFixed(1)} expected through{" "}
            {stats.decidedGames} final game{stats.decidedGames === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-8">
        <div>
          <Gauge count={stats.upsetsConfirmed} expected={stats.expectedUpsets} verdict={stats.verdict} />
          {stats.upsetsLive > 0 && (
            <p className="mt-1 text-center text-xs text-muted-foreground">+{stats.upsetsLive} leading live</p>
          )}
        </div>

        <div>
          <p className="text-base text-foreground">
            Expected today: <span className="font-bold">{stats.expectedUpsets.toFixed(1)}</span>
          </p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            across the full {stats.gameCount}-game slate (~{Math.round(MLB_UNDERDOG_WIN_RATE * 100)}% underdog win rate)
          </p>
          {stats.verdict !== "insufficient" && stats.upsetRate !== null && (
            <>
              <p className="mt-2 text-sm text-foreground">
                Confirmed pace: <span className="font-medium">{Math.round(stats.upsetRate * 100)}%</span>
                {"  ·  "}
                <span className="font-medium">
                  {rateDeltaPts >= 0 ? "+" : ""}
                  {rateDeltaPts} pts vs avg
                </span>
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {stats.upsetsConfirmed} of {stats.decidedGames} finished game{stats.decidedGames === 1 ? "" : "s"}{" "}
                {stats.upsetsConfirmed === 1 ? "was an upset" : "were upsets"}
              </p>
            </>
          )}
          <span className={"mt-3 inline-block rounded-full px-3 py-1 text-sm font-medium " + badgeClass}>{badgeText}</span>
        </div>
      </div>

      {liveLeaders > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Live now:</span> {stats.favsLeadingLive} fav
          {stats.favsLeadingLive === 1 ? "" : "s"} leading &middot; {stats.dogsLeadingLive} dog
          {stats.dogsLeadingLive === 1 ? "" : "s"} leading
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Favs won" value={stats.favsWon} />
        <StatTile label="Dogs won" value={stats.dogsWon} />
        <StatTile label="Trending over" value={stats.trendingOver} />
        <StatTile label="Trending under" value={stats.trendingUnder} />
      </div>
    </div>
  );
}
