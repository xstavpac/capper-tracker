import type { ReactNode } from "react";
import type { CapperPanels } from "@/server/data/capper-panels";

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
    panels.bestLast10.length > 0;

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
            <PanelRow
              key={e.capperId}
              capperId={e.capperId}
              name={e.name}
              colorTag={e.colorTag}
              right={
                <span className="text-emerald-600">
                  {e.wins}-{e.losses}
                  {e.pushes > 0 ? "-" + e.pushes : ""}
                </span>
              }
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

      {panels.bestLast10.length > 0 && (
        <Panel title="Best last 10" subtitle="Recent form vs. their lifetime rate">
          {panels.bestLast10.slice(0, MAX_ROWS).map((e) => (
            <PanelRow
              key={e.capperId}
              capperId={e.capperId}
              name={e.name}
              colorTag={e.colorTag}
              right={
                <span className={e.deltaPts >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {e.recentWinPct}% ({e.deltaPts >= 0 ? "up" : "down"} {Math.abs(e.deltaPts)}pt)
                </span>
              }
            />
          ))}
        </Panel>
      )}
    </div>
  );
}
