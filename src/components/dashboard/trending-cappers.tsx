import type { CapperPanels } from "@/server/data/capper-panels";
import { Panel, PanelRow, BarRow, record } from "@/components/dashboard/capper-panels";
import { SURGE_DURATION_MS } from "@/components/dashboard/energy-surge-constants";
import { ExpandableRows } from "@/components/dashboard/expandable-rows";
import { EXPANDABLE_ROWS_MAX } from "@/components/dashboard/expandable-rows-constants";
import { TrendIcon } from "@/components/dashboard/trend-icon";

const FLAME_PATH = "M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z";

// Two layered flame shapes (same silhouette, different color/scale) flicker
// on independent keyframes/durations so they don't move as one rigid unit -
// plus a few embers that rise and fade above the flame on a staggered loop.
function HotStreaksIcon() {
  return (
    <span className="relative inline-block h-5 w-5 shrink-0" aria-hidden="true">
      <span
        className="absolute left-[7px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "0s" }}
      />
      <span
        className="absolute left-[11px] top-0.5 h-[3px] w-[3px] rounded-full bg-orange-300 animate-ember-rise"
        style={{ animationDelay: "0.6s" }}
      />
      <span
        className="absolute left-[9px] top-0 h-[3px] w-[3px] rounded-full bg-amber-300 animate-ember-rise"
        style={{ animationDelay: "1.2s" }}
      />
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-orange-500 animate-flame-outer">
        <path d={FLAME_PATH} />
      </svg>
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute inset-0 h-5 w-5 origin-bottom text-amber-300 animate-flame-inner">
        <path d={FLAME_PATH} />
      </svg>
    </span>
  );
}

// A static snowflake (unmoving, unlike the flame) with small falling
// particle dots drifting past it - 2 smaller/dimmer, 2 larger/more opaque -
// each on its own fall+drift keyframe and stagger, for a layered "snow
// passing by" effect rather than the icon itself animating.
function CoolingOffIcon() {
  return (
    <span className="relative inline-block h-5 w-5 shrink-0" aria-hidden="true">
      <span
        className="absolute left-0 top-0 h-1 w-1 rounded-full bg-sky-300 opacity-60 animate-snow-fall-a"
        style={{ animationDelay: "0s" }}
      />
      <span
        className="absolute right-0 top-0 h-1 w-1 rounded-full bg-sky-300 opacity-60 animate-snow-fall-b"
        style={{ animationDelay: "0.8s" }}
      />
      <span
        className="absolute left-0.5 top-1 h-1.5 w-1.5 rounded-full bg-sky-500 opacity-90 animate-snow-fall-b"
        style={{ animationDelay: "1.4s" }}
      />
      <span
        className="absolute right-0.5 top-1 h-1.5 w-1.5 rounded-full bg-sky-500 opacity-90 animate-snow-fall-a"
        style={{ animationDelay: "2s" }}
      />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="absolute inset-0 h-5 w-5 text-sky-600"
      >
        <path d="M12 2v20M4 7l16 10M20 7 4 17M2 12h20" />
      </svg>
    </span>
  );
}

// Concentric rings + an incoming arrow, static (the "hit" is shown by the
// per-row fill bar, not by animating the header glyph itself) - matches
// Tabler's ti-target-arrow.
function BestIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="7" />
      <circle cx="9" cy="9" r="4" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
      <path d="M21 21 15.5 15.5" />
      <path d="M13 13 16.2 14 14 16.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Same rings, crossed out - matches Tabler's ti-target-off. Static, same
// reasoning as BestIcon above.
function WorstIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="4" />
      <path d="M3 21 21 3" />
    </svg>
  );
}

// Capsule body + window + fins, matches Tabler's ti-rocket. Drifts up and
// settles on a slow loop - same low-frequency, non-distracting pace as the
// Hot streaks flame, just a vertical bob instead of a flicker.
function TrendingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400 animate-rocket-drift"
      aria-hidden="true"
    >
      <rect x="9.5" y="3.5" width="5" height="11" rx="2.5" />
      <circle cx="12" cy="8" r="1.1" />
      <path d="M9.5 11 6 15.5 9.5 14.3" />
      <path d="M14.5 11 18 15.5 14.5 14.3" />
    </svg>
  );
}

// Canopy + shroud lines + basket, matches Tabler's ti-parachute. Rocks
// gently side to side from the canopy, same slow pace as the rocket's drift
// and the flame/snowflake treatments.
function FallingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 origin-top text-red-600 dark:text-red-400 animate-parachute-sway"
      aria-hidden="true"
    >
      <path d="M3 10a9 9 0 0 1 18 0" />
      <path d="M4.5 10 9 17M9.5 10 10.5 17M14.5 10 13.5 17M19.5 10 15 17" />
      <rect x="9" y="17" width="6" height="3" rx="1" />
    </svg>
  );
}

// Condensed cheat-sheet version of the Cappers-page panels, right on the
// Dashboard so "who's hot right now" doesn't require a navigation - same
// data, same row components, just fewer rows each. Six panels in a 2x3
// grid, column-major: Hot Streaks stacked above Cooling Off, Best Last-20
// above Worst Last-20, Trending above Falling Off - grid-flow-col fills
// column by column from DOM order, so the panels are listed in that same
// column-major sequence below (not the row-major Hot/Cooling/Trending order
// a plain grid-cols-3 would produce).
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
        <h2 className="text-sm font-semibold text-foreground">Trending cappers</h2>
        <a href="/cappers" className="text-xs font-medium text-brand-600 hover:text-brand-700">
          See all &rarr;
        </a>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-fr sm:grid-rows-2">
        {panels.hotStreaks.length > 0 && (
          <Panel title="Hot streaks" subtitle="Active win streaks, longest first" icon={<HotStreaksIcon />}>
            <ExpandableRows>
              {panels.hotStreaks.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <PanelRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  icon={<TrendIcon direction="up" />}
                  right={<span className="text-emerald-600 dark:text-emerald-400">{e.streakCount}W</span>}
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}

        {panels.coolingOff.length > 0 && (
          <Panel title="Cooling off" subtitle="Active loss streaks, longest first" icon={<CoolingOffIcon />}>
            <ExpandableRows>
              {panels.coolingOff.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <PanelRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  icon={<TrendIcon direction="down" />}
                  right={<span className="text-red-600 dark:text-red-400">{e.streakCount}L</span>}
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}

        {panels.bestLast20.length > 0 && (
          <Panel title="Best last 20 picks" icon={<BestIcon />}>
            <ExpandableRows>
              {panels.bestLast20.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <BarRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  record={record(e.wins, e.losses, e.pushes)}
                  winPct={e.recentWinPct}
                  showWinPct
                  startDelayMs={SURGE_DURATION_MS}
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}

        {panels.worstLast20.length > 0 && (
          <Panel title="Worst last 20 picks" icon={<WorstIcon />}>
            <ExpandableRows>
              {panels.worstLast20.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <BarRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  record={record(e.wins, e.losses, e.pushes)}
                  winPct={e.recentWinPct}
                  showWinPct
                  startDelayMs={SURGE_DURATION_MS}
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}

        {panels.rising.length > 0 && (
          <Panel
            title="Trending"
            subtitle="Recent form meaningfully better than their stretch before it"
            icon={<TrendingIcon />}
          >
            <ExpandableRows>
              {panels.rising.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <PanelRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  icon={<TrendIcon direction="up" />}
                  right={
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {Math.round(e.previousWinPct)}% &rarr; {Math.round(e.recentWinPct)}%
                    </span>
                  }
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}

        {panels.fallingOff.length > 0 && (
          <Panel
            title="Falling off"
            subtitle="Recent form well below their lifetime rate"
            icon={<FallingIcon />}
          >
            <ExpandableRows>
              {panels.fallingOff.slice(0, EXPANDABLE_ROWS_MAX).map((e) => (
                <PanelRow
                  key={e.capperId}
                  capperId={e.capperId}
                  name={e.name}
                  colorTag={e.colorTag}
                  icon={<TrendIcon direction="down" />}
                  right={
                    <span className="text-red-600 dark:text-red-400">
                      {Math.round(e.lifetimeWinPct)}% &rarr; {Math.round(e.recentWinPct)}%
                    </span>
                  }
                />
              ))}
            </ExpandableRows>
          </Panel>
        )}
      </div>
    </div>
  );
}
