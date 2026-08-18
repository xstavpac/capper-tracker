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

// Color/the "+N pts" pill are driven by `verdict` (rate vs baseline, the
// same comparison the text badge below uses) - NOT by the arc's own fill
// fraction. The arc fraction is a separate, still-legitimate fact ("how far
// through today's expected total are we") and is left alone; only the
// hot/cold judgment layered on top of it was the bug (see board-pulse.ts).
function Gauge({
  count,
  expected,
  verdict,
  upsetRate,
}: {
  count: number;
  expected: number;
  verdict: BoardPulseVerdict;
  upsetRate: number | null;
}) {
  const fraction = expected > 0 ? Math.min(count / expected, 1) : 0;
  const color = verdict === "hot" ? "#dc2626" : verdict === "cold" ? "#f97316" : "#9ca3af"; // red-600 / orange-500 / gray-400

  return (
    <div className="relative inline-block">
      <svg viewBox={`0 0 ${GAUGE_VIEWBOX_W} ${GAUGE_VIEWBOX_H}`} className="h-[124px] w-[220px]">
        <path
          d={ARC_PATH}
          pathLength={100}
          fill="none"
          stroke="#e5e7eb"
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
        <div className="text-3xl font-bold text-gray-900">{count}</div>
        <div className="text-xs text-gray-500">upsets so far</div>
      </div>
      {verdict === "hot" && upsetRate !== null && (
        <span className="absolute right-0 top-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
          +{Math.round((upsetRate - MLB_UNDERDOG_WIN_RATE) * 100)}pts vs avg
        </span>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card bg-gray-50 p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

export function BoardPulsePanel({ stats }: { stats: BoardPulseStats }) {
  const badgeClass =
    stats.verdict === "hot"
      ? "bg-red-100 text-red-700"
      : stats.verdict === "cold"
        ? "bg-orange-100 text-orange-700"
        : "bg-gray-100 text-gray-500";
  const badgeText =
    stats.verdict === "insufficient"
      ? "not enough games yet"
      : "running " + (stats.verdict === "hot" ? "above" : "below") + " average";

  return (
    <div className="mb-6 rounded-card bg-white p-6 shadow-soft">
      <h2 className="text-base font-semibold text-gray-900">Board pulse &middot; live</h2>
      <p className="mt-0.5 text-sm text-gray-500">
        {stats.gameCount} game{stats.gameCount === 1 ? "" : "s"} today &middot; updates as scores change
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-8">
        <Gauge count={stats.upsetsSoFar} expected={stats.expectedUpsets} verdict={stats.verdict} upsetRate={stats.upsetRate} />

        <div>
          <p className="text-base text-gray-900">
            Expected today: <span className="font-bold">{stats.expectedUpsets.toFixed(1)}</span>
          </p>
          <p className="mt-1 max-w-xs text-sm text-gray-500">
            based on MLB&apos;s historical ~{Math.round(MLB_UNDERDOG_WIN_RATE * 100)}% underdog win rate across{" "}
            {stats.gameCount} game{stats.gameCount === 1 ? "" : "s"}
          </p>
          {stats.verdict !== "insufficient" && stats.upsetRate !== null && (
            <p className="mt-1 text-sm text-gray-500">
              Current pace: <span className="font-medium text-gray-700">{Math.round(stats.upsetRate * 100)}%</span> upsets
              across {stats.gamesSoFar} decided game{stats.gamesSoFar === 1 ? "" : "s"} so far
            </p>
          )}
          <span className={"mt-3 inline-block rounded-full px-3 py-1 text-sm font-medium " + badgeClass}>{badgeText}</span>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Favs leading" value={stats.favsLeading} />
        <StatTile label="Dogs leading" value={stats.dogsLeading} />
        <StatTile label="Trending over" value={stats.trendingOver} />
        <StatTile label="Trending under" value={stats.trendingUnder} />
      </div>
    </div>
  );
}
