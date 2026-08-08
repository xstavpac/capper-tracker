import type { CapperPanels } from "@/server/data/capper-panels";
import { Panel, PanelRow, BarRow, record, winPctExcludingPushes } from "@/components/dashboard/capper-panels";
import { TrendIcon } from "@/components/dashboard/trend-icon";

const CONDENSED_ROWS = 3;

// Condensed cheat-sheet version of the Cappers-page panels, right on the
// Dashboard so "who's hot right now" doesn't require a navigation - same
// data, same row components, just fewer rows each. Six panels in a 2x3
// grid: Hot Streaks / Cooling Off / Trending on top, Best Last-20 / Worst
// Last-20 / Falling Off underneath - grid-cols-3 wraps them into that
// layout automatically from DOM order, no manual row assignment needed.
export function TrendingCappers({ panels }: { panels: CapperPanels }) {
  const hasAny =
    panels.hotStreaks.length > 0 ||
    panels.coolingOff.length > 0 ||
    panels.rising.length > 0 ||
    panels.bestLast20.length > 0 ||
    panels.worstLast20.length > 0 ||
    panels.fallingOff.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Trending cappers</h2>
        <a href="/cappers" className="text-xs font-medium text-brand-600 hover:text-brand-700">
          See all &rarr;
        </a>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {panels.hotStreaks.length > 0 && (
          <Panel title="Hot streaks" subtitle="Active win streaks, longest first">
            {panels.hotStreaks.slice(0, CONDENSED_ROWS).map((e) => (
              <PanelRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                right={<span className="text-orange-600">{e.streakCount}W</span>}
              />
            ))}
          </Panel>
        )}

        {panels.coolingOff.length > 0 && (
          <Panel title="Cooling off" subtitle="Active loss streaks, longest first">
            {panels.coolingOff.slice(0, CONDENSED_ROWS).map((e) => (
              <PanelRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                right={<span className="text-sky-600">{e.streakCount}L</span>}
              />
            ))}
          </Panel>
        )}

        {panels.rising.length > 0 && (
          <Panel title="Trending" subtitle="Strong starts, too early for a full rank">
            {panels.rising.slice(0, CONDENSED_ROWS).map((e) => (
              <BarRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                record={record(e.wins, e.losses, e.pushes)}
                winPct={winPctExcludingPushes(e.wins, e.losses)}
                trending
              />
            ))}
          </Panel>
        )}

        {panels.bestLast20.length > 0 && (
          <Panel title="Best last 20" subtitle="Record over their last 20 graded picks">
            {panels.bestLast20.slice(0, CONDENSED_ROWS).map((e) => (
              <BarRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                record={record(e.wins, e.losses, e.pushes)}
                winPct={e.recentWinPct}
              />
            ))}
          </Panel>
        )}

        {panels.worstLast20.length > 0 && (
          <Panel title="Worst last 20" subtitle="Worst record over their last 20 graded picks">
            {panels.worstLast20.slice(0, CONDENSED_ROWS).map((e) => (
              <BarRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                record={record(e.wins, e.losses, e.pushes)}
                winPct={e.recentWinPct}
              />
            ))}
          </Panel>
        )}

        {panels.fallingOff.length > 0 && (
          <Panel title="Falling off" subtitle="Recent form well below their lifetime rate">
            {panels.fallingOff.slice(0, CONDENSED_ROWS).map((e) => (
              <PanelRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                icon={<TrendIcon direction="down" />}
                right={
                  <span className="text-red-600">
                    {Math.round(e.lifetimeWinPct)}% &rarr; {Math.round(e.recentWinPct)}%
                  </span>
                }
              />
            ))}
          </Panel>
        )}
      </div>
    </div>
  );
}
