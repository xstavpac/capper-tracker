import type { ReactNode } from "react";
import type { CapperPanels } from "@/server/data/capper-panels";
import { SCORECARD_WIN_THRESHOLD } from "@/server/data/stats";

const MAX_ROWS = 5;

export function Avatar({ name, colorTag }: { name: string; colorTag: string | null }) {
  return (
    <div
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
      style={{ backgroundColor: colorTag ?? "#3B82F6" }}
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function PanelRow({
  capperId,
  name,
  colorTag,
  right,
}: {
  capperId: string;
  name: string;
  colorTag: string | null;
  right: ReactNode;
}) {
  return (
    <a
      href={"/cappers/" + capperId}
      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={name} colorTag={colorTag} />
        <span className="truncate">{name}</span>
      </div>
      <span className="shrink-0 text-xs font-medium">{right}</span>
    </a>
  );
}

// Name + right-aligned record + a thin progress bar underneath whose fill
// length is the win%, animating in from empty on load. Used by Rising and
// Best Last-20 specifically - the two "catch something happening right now"
// panels - kept deliberately plainer everywhere else in this file.
export function BarRow({
  capperId,
  name,
  colorTag,
  record,
  winPct,
}: {
  capperId: string;
  name: string;
  colorTag: string | null;
  record: string;
  winPct: number;
}) {
  const positive = winPct >= SCORECARD_WIN_THRESHOLD;
  const fill = Math.min(100, Math.max(0, winPct)) / 100;

  return (
    <a href={"/cappers/" + capperId} className="block rounded-lg px-2 py-1.5 hover:bg-gray-50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={name} colorTag={colorTag} />
          <span className="truncate text-sm">{name}</span>
        </div>
        <span className={"shrink-0 text-sm font-semibold " + (positive ? "text-emerald-600" : "text-red-600")}>
          {record}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={"h-full origin-left animate-fill-bar rounded-full " + (positive ? "bg-emerald-500" : "bg-red-500")}
          style={{ transform: "scaleX(" + fill + ")", ["--fill" as string]: fill }}
        />
      </div>
    </a>
  );
}

export function record(wins: number, losses: number, pushes: number) {
  return wins + "-" + losses + (pushes > 0 ? "-" + pushes : "");
}

// Excludes pushes from the denominator, matching computeStats' winPct
// convention (a push is neither a win nor a loss).
export function winPctExcludingPushes(wins: number, losses: number) {
  const decided = wins + losses;
  return decided > 0 ? (wins / decided) * 100 : 0;
}

export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      <p className="mb-2 text-xs text-gray-500">{subtitle}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function CapperPanelsGrid({ panels }: { panels: CapperPanels }) {
  const hasAny =
    panels.hotStreaks.length > 0 ||
    panels.coolingOff.length > 0 ||
    panels.rising.length > 0 ||
    panels.fallingOff.length > 0 ||
    panels.bestLast20.length > 0;

  if (!hasAny) return null;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {panels.hotStreaks.length > 0 && (
        <Panel title="Hot streaks" subtitle="Active win streaks, longest first">
          {panels.hotStreaks.slice(0, MAX_ROWS).map((e) => (
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
          {panels.coolingOff.slice(0, MAX_ROWS).map((e) => (
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
        <Panel title="Rising" subtitle="Strong starts, too early for a full rank">
          {panels.rising.slice(0, MAX_ROWS).map((e) => (
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

      {panels.fallingOff.length > 0 && (
        <Panel title="Falling off" subtitle="Recent form well below their lifetime rate">
          {panels.fallingOff.slice(0, MAX_ROWS).map((e) => (
            <PanelRow
              key={e.capperId}
              capperId={e.capperId}
              name={e.name}
              colorTag={e.colorTag}
              right={
                <span className="text-red-600">
                  {e.lifetimeWinPct}% &rarr; {e.recentWinPct}%
                </span>
              }
            />
          ))}
        </Panel>
      )}

      {panels.bestLast20.length > 0 && (
        <Panel title="Best last 20" subtitle="Record over their last 20 graded picks">
          {panels.bestLast20.slice(0, MAX_ROWS).map((e) => (
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
  );
}
