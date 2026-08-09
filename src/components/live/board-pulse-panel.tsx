import { MLB_UNDERDOG_WIN_RATE, type BoardPulseStats } from "@/lib/board-pulse";

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

function Gauge({ count, expected }: { count: number; expected: number }) {
  const fraction = expected > 0 ? Math.min(count / expected, 1) : 0;
  const overflow = count - expected;
  const isOver = overflow > 0;
  const color = isOver ? "#dc2626" : "#f97316"; // red-600 / orange-500

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
      {isOver && (
        <span className="absolute right-0 top-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
          +{overflow.toFixed(1)} over
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
  const isOver = stats.upsetsSoFar > stats.expectedUpsets;

  return (
    <div className="mb-6 rounded-card bg-white p-6 shadow-soft">
      <h2 className="text-base font-semibold text-gray-900">Board pulse &middot; live</h2>
      <p className="mt-0.5 text-sm text-gray-500">
        {stats.gameCount} game{stats.gameCount === 1 ? "" : "s"} today &middot; updates as scores change
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-8">
        <Gauge count={stats.upsetsSoFar} expected={stats.expectedUpsets} />

        <div>
          <p className="text-base text-gray-900">
            Expected today: <span className="font-bold">{stats.expectedUpsets.toFixed(1)}</span>
          </p>
          <p className="mt-1 max-w-xs text-sm text-gray-500">
            based on MLB&apos;s historical ~{Math.round(MLB_UNDERDOG_WIN_RATE * 100)}% underdog win rate across{" "}
            {stats.gameCount} game{stats.gameCount === 1 ? "" : "s"}
          </p>
          <span
            className={
              "mt-3 inline-block rounded-full px-3 py-1 text-sm font-medium " +
              (isOver ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700")
            }
          >
            running {isOver ? "above" : "below"} average
          </span>
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
