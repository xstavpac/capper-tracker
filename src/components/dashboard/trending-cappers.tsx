import type { CapperPanels } from "@/server/data/capper-panels";
import { Panel, PanelRow, BarRow, record, winPctExcludingPushes } from "@/components/dashboard/capper-panels";

const CONDENSED_ROWS = 3;

// Condensed cheat-sheet version of the Cappers-page panels, right on the
// Dashboard so "who's hot right now" doesn't require a navigation - same
// data, same row components, just three panels and fewer rows each.
export function TrendingCappers({ panels }: { panels: CapperPanels }) {
  const hasAny = panels.hotStreaks.length > 0 || panels.rising.length > 0 || panels.bestLast20.length > 0;
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

        {panels.rising.length > 0 && (
          <Panel title="Rising" subtitle="Strong starts, too early for a full rank">
            {panels.rising.slice(0, CONDENSED_ROWS).map((e) => (
              <BarRow
                key={e.capperId}
                capperId={e.capperId}
                name={e.name}
                colorTag={e.colorTag}
                record={record(e.wins, e.losses, e.pushes)}
                winPct={winPctExcludingPushes(e.wins, e.losses)}
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
      </div>
    </div>
  );
}
