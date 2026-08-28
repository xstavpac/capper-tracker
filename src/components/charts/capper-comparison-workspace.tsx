"use client";

import { useEffect, useState } from "react";
import { getCapperComparisonAction } from "@/server/actions/capper-comparison";
import type { ComparisonFilters, CapperComparisonProfile } from "@/server/data/capper-comparison";
import { EMPTY_COMPARISON_FILTERS } from "@/server/data/capper-comparison";
import { BET_TYPE_FILTER_OPTIONS, type BetTypeFilterKey } from "@/lib/bet-type-filter";
import { DateRangePicker } from "@/components/charts/date-range-picker";
import { CapperComparisonChart, type ComparisonSeries } from "@/components/charts/capper-comparison-chart";
import { getRecordColor } from "@/server/data/stats";
import { useFullscreen, FULLSCREEN_CHART_HEIGHT, FULLSCREEN_SURFACE_CLASS } from "@/components/charts/use-fullscreen";
import { FullscreenButton } from "@/components/charts/fullscreen-button";

const PALETTE_A = "#2563eb";
const PALETTE_B = "#dc2626";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type StreakOption = "ANY" | "LOSS_1" | "LOSS_2" | "LOSS_3" | "LOSS_4" | "WIN_1" | "WIN_2" | "WIN_3" | "WIN_4";

const STREAK_OPTIONS: { value: StreakOption; label: string }[] = [
  { value: "ANY", label: "Any streak" },
  { value: "LOSS_1", label: "After 1L" },
  { value: "LOSS_2", label: "After 2L" },
  { value: "LOSS_3", label: "After 3L" },
  { value: "LOSS_4", label: "After 4+L" },
  { value: "WIN_1", label: "After 1W" },
  { value: "WIN_2", label: "After 2W" },
  { value: "WIN_3", label: "After 3W" },
  { value: "WIN_4", label: "After 4+W" },
];

function streakOptionToFilter(opt: StreakOption): ComparisonFilters["streak"] {
  if (opt === "ANY") return null;
  const [type, lengthStr] = opt.split("_");
  return { type: type as "WIN" | "LOSS", length: Number(lengthStr) as 1 | 2 | 3 | 4 };
}

function filterToStreakOption(streak: ComparisonFilters["streak"]): StreakOption {
  if (!streak) return "ANY";
  return (streak.type + "_" + streak.length) as StreakOption;
}

function SELECT_CLASS() {
  return "rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground";
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          "mt-0.5 text-sm font-semibold " +
          (tone === "up" ? "text-emerald-600 dark:text-emerald-400" : tone === "down" ? "text-red-600 dark:text-red-400" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}

function ProfileTiles({ profile, color }: { profile: CapperComparisonProfile; color: string }) {
  const { stats } = profile;
  return (
    <div className="rounded-card bg-card p-4 shadow-soft">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="font-medium text-foreground">{profile.capperName}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Record" value={stats.wins + "-" + stats.losses + "-" + stats.pushes} />
        <StatTile label="Win rate" value={Math.round(stats.winPct) + "%"} tone={getRecordColor(stats.winPct) === "green" ? "up" : "down"} />
        <StatTile label="Net units" value={(stats.netUnits >= 0 ? "+" : "") + stats.netUnits + "u"} tone={stats.netUnits >= 0 ? "up" : "down"} />
        <StatTile label="ROI" value={(stats.roi >= 0 ? "+" : "") + stats.roi + "%"} tone={stats.roi >= 0 ? "up" : "down"} />
        <StatTile label="Max drawdown" value={profile.maxDrawdown + "u"} tone={profile.maxDrawdown > 0 ? "down" : undefined} />
        <StatTile label="Bets" value={String(profile.betCount)} />
      </div>
    </div>
  );
}

export function CapperComparisonWorkspace({
  cappers,
  sports,
}: {
  cappers: { id: string; name: string }[];
  sports: { id: string; name: string }[];
}) {
  const [capperAId, setCapperAId] = useState(cappers[0]?.id ?? "");
  const [capperBId, setCapperBId] = useState(cappers[1]?.id ?? cappers[0]?.id ?? "");
  const [filters, setFilters] = useState<ComparisonFilters>(EMPTY_COMPARISON_FILTERS);
  const [view, setView] = useState<"overlay" | "split">("overlay");

  const [data, setData] = useState<{ a: CapperComparisonProfile; b: CapperComparisonProfile } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same whole-workspace fullscreen target as the other two /charts modes -
  // see use-fullscreen.ts. Declared before the "need 2+ cappers" early
  // return below so hook order stays fixed regardless of that branch.
  const fs = useFullscreen<HTMLDivElement>();

  useEffect(() => {
    if (!capperAId || !capperBId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCapperComparisonAction(capperAId, capperBId, filters)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this comparison.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capperAId, capperBId, JSON.stringify(filters)]);

  function updateFilter<K extends keyof ComparisonFilters>(key: K, value: ComparisonFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  const overlaySeries: ComparisonSeries[] = data
    ? [
        { id: "a", label: data.a.capperName, color: PALETTE_A, points: data.a.chartData },
        { id: "b", label: data.b.capperName, color: PALETTE_B, points: data.b.chartData },
      ]
    : [];

  if (cappers.length < 2) {
    return (
      <div className="rounded-card bg-card p-10 text-center text-sm text-muted-foreground shadow-soft">
        You need at least 2 cappers tracked to use comparison - log picks under a second capper first.
      </div>
    );
  }

  return (
    <div ref={fs.ref} className={(fs.isFullscreen ? FULLSCREEN_SURFACE_CLASS + " " : "") + "space-y-4"}>
      <div className="rounded-card bg-card p-4 shadow-soft">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <label className="text-muted-foreground">Capper A</label>
            <select value={capperAId} onChange={(e) => setCapperAId(e.target.value)} className={SELECT_CLASS()}>
              {cappers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-muted-foreground">Capper B</label>
            <select value={capperBId} onChange={(e) => setCapperBId(e.target.value)} className={SELECT_CLASS()}>
              {cappers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex gap-1 rounded-full bg-muted p-1">
              {(["overlay", "split"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setView(mode)}
                  className={
                    "rounded-full px-3 py-1 text-xs font-medium capitalize transition " +
                    (view === mode ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {mode}
                </button>
              ))}
            </div>
            {fs.supported && <FullscreenButton isFullscreen={fs.isFullscreen} onClick={fs.toggle} />}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <select
            value={filters.sportId ?? ""}
            onChange={(e) => updateFilter("sportId", e.target.value || null)}
            className={SELECT_CLASS()}
          >
            <option value="">All leagues</option>
            {sports.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            value={filters.betType ?? ""}
            onChange={(e) => updateFilter("betType", (e.target.value || null) as BetTypeFilterKey | null)}
            className={SELECT_CLASS()}
          >
            <option value="">All bet types</option>
            {BET_TYPE_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={filters.favDog ?? ""}
            onChange={(e) => updateFilter("favDog", (e.target.value || null) as ComparisonFilters["favDog"])}
            className={SELECT_CLASS()}
          >
            <option value="">Favorite or underdog</option>
            <option value="FAVORITE">Favorite</option>
            <option value="UNDERDOG">Underdog</option>
          </select>

          <select
            value={filters.dayOfWeek === null ? "" : String(filters.dayOfWeek)}
            onChange={(e) => updateFilter("dayOfWeek", e.target.value === "" ? null : Number(e.target.value))}
            className={SELECT_CLASS()}
          >
            <option value="">Any day</option>
            {DAY_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>

          <select
            value={filters.month === null ? "" : String(filters.month)}
            onChange={(e) => updateFilter("month", e.target.value === "" ? null : Number(e.target.value))}
            className={SELECT_CLASS()}
          >
            <option value="">Any month</option>
            {MONTH_LABELS.map((label, i) => (
              <option key={i} value={i + 1}>
                {label}
              </option>
            ))}
          </select>

          <select
            value={filterToStreakOption(filters.streak)}
            onChange={(e) => updateFilter("streak", streakOptionToFilter(e.target.value as StreakOption))}
            className={SELECT_CLASS()}
          >
            {STREAK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <DateRangePicker
            value={filters.dateRange ?? { start: "", end: "" }}
            onChange={(next) => updateFilter("dateRange", next.start && next.end ? next : null)}
          />

          <div className="flex items-center gap-1.5 text-sm">
            <label className="text-muted-foreground">Odds</label>
            <input
              type="number"
              placeholder="min"
              value={filters.oddsMin ?? ""}
              onChange={(e) => updateFilter("oddsMin", e.target.value === "" ? null : Number(e.target.value))}
              className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="number"
              placeholder="max"
              value={filters.oddsMax ?? ""}
              onChange={(e) => updateFilter("oddsMax", e.target.value === "" ? null : Number(e.target.value))}
              className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <label className="text-muted-foreground">Units</label>
            <input
              type="number"
              placeholder="min"
              value={filters.unitsMin ?? ""}
              onChange={(e) => updateFilter("unitsMin", e.target.value === "" ? null : Number(e.target.value))}
              className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="number"
              placeholder="max"
              value={filters.unitsMax ?? ""}
              onChange={(e) => updateFilter("unitsMax", e.target.value === "" ? null : Number(e.target.value))}
              className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
            />
          </div>

          {JSON.stringify(filters) !== JSON.stringify(EMPTY_COMPARISON_FILTERS) && (
            <button onClick={() => setFilters(EMPTY_COMPARISON_FILTERS)} className="text-sm text-muted-foreground hover:text-foreground">
              Clear filters
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

      {loading && !data && <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading…</div>}

      {data && view === "overlay" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <ProfileTiles profile={data.a} color={PALETTE_A} />
            <ProfileTiles profile={data.b} color={PALETTE_B} />
          </div>
          <div className="rounded-card bg-card p-4 shadow-soft" onDoubleClick={fs.supported ? fs.toggle : undefined}>
            <CapperComparisonChart
              series={overlaySeries}
              height={fs.isFullscreen ? (fs.chartHeight ?? FULLSCREEN_CHART_HEIGHT) : 320}
            />
          </div>
        </>
      )}

      {data && view === "split" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <ProfileTiles profile={data.a} color={PALETTE_A} />
            <div className="rounded-card bg-card p-4 shadow-soft" onDoubleClick={fs.supported ? fs.toggle : undefined}>
              <CapperComparisonChart
                series={[{ id: "a", label: data.a.capperName, color: PALETTE_A, points: data.a.chartData }]}
                height={fs.isFullscreen ? (fs.chartHeight ?? FULLSCREEN_CHART_HEIGHT) : 260}
              />
            </div>
          </div>
          <div className="space-y-4">
            <ProfileTiles profile={data.b} color={PALETTE_B} />
            <div className="rounded-card bg-card p-4 shadow-soft" onDoubleClick={fs.supported ? fs.toggle : undefined}>
              <CapperComparisonChart
                series={[{ id: "b", label: data.b.capperName, color: PALETTE_B, points: data.b.chartData }]}
                height={fs.isFullscreen ? (fs.chartHeight ?? FULLSCREEN_CHART_HEIGHT) : 260}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
