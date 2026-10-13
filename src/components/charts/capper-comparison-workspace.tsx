"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getCapperComparisonAction } from "@/server/actions/capper-comparison";
import type { ComparisonFilters, CapperComparisonProfile } from "@/server/data/capper-comparison";
import { EMPTY_COMPARISON_FILTERS } from "@/server/data/capper-comparison";
import { BET_TYPE_FILTER_OPTIONS, type BetTypeFilterKey } from "@/lib/bet-type-filter";
import { DateRangePicker } from "@/components/charts/date-range-picker";
import { CapperComparisonChart, type ComparisonSeries } from "@/components/charts/capper-comparison-chart";
import { getRecordColor } from "@/server/data/stats";
import { useFullscreen, FULLSCREEN_CHART_HEIGHT, FULLSCREEN_SURFACE_CLASS } from "@/components/charts/use-fullscreen";
import { FullscreenButton } from "@/components/charts/fullscreen-button";
import { BANNER_CONTROLS, BANNER_ICON, BANNER_ROW, BannerBrand, NavyBanner } from "@/components/ui/navy-banner";
import { CONTROL, GREEN, Message, PanelShell, RED, TINTS } from "@/components/dashboard/panel-shell";
import { StatCell } from "@/components/dashboard/capper-hero";
import { ChartsIcon, TrendingUpIcon } from "@/components/dashboard/cappers-icons";
import { leagueColorVars } from "@/lib/league-colors";
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";
import { formatSignedUnits } from "@/lib/units-extremes";

// Every committed filter change refetches both cappers' history, so a number field
// must not commit on each keystroke (typing "-110" would fire four comparisons).
const NUMBER_INPUT_DEBOUNCE_MS = 400;

// A number input that keeps what the user is typing locally and commits it to the
// filter state only after a pause in typing (or immediately on blur). An
// unparseable in-progress value ("-", ".") is held, not committed. A committed
// value changing from outside (Clear filters) replaces the typed text.
function DebouncedNumberInput({
  value,
  onCommit,
  placeholder,
  className,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  placeholder: string;
  className: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const parse = (s: string): number | null => (s === "" ? null : Number(s));

  useEffect(() => {
    setText((prev) => (parse(prev) === value ? prev : value === null ? "" : String(value)));
  }, [value]);

  useEffect(() => {
    const parsed = parse(text);
    if (parsed === value || (parsed !== null && Number.isNaN(parsed))) return;
    const timer = setTimeout(() => onCommit(parsed), NUMBER_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <input
      type="number"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = parse(text);
        if (parsed !== value && !(parsed !== null && Number.isNaN(parsed))) onCommit(parsed);
      }}
      className={className}
    />
  );
}


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

// The two series: they differ in lightness, not only in hue.
const SERIES_COLORS = ["#2563eb", "#ea580c"];

// The banner's time presets. They set the same Eastern date range the From / to fields do, so a
// preset is just a range that ends today; "All time" is no range at all.
const TIME_PRESETS: { label: string; long: string; days: number | null }[] = [
  { label: "7D", long: "Last 7 days", days: 7 },
  { label: "30D", long: "Last 30 days", days: 30 },
  { label: "60D", long: "Last 60 days", days: 60 },
  { label: "All time", long: "All time", days: null },
];

function presetRange(days: number): NonNullable<ComparisonFilters["dateRange"]> {
  const end = easternDateKey(new Date());
  return { start: addDaysToDateKey(end, -(days - 1)), end };
}

// The preset a range is, or undefined for one typed into the From / to fields.
function activePreset(range: ComparisonFilters["dateRange"]) {
  return TIME_PRESETS.find((p) => {
    if (p.days === null || range === null) return p.days === null && range === null;
    const r = presetRange(p.days);
    return r.start === range.start && r.end === range.end;
  });
}

const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
// The filter bar's fields: the panels' header control (panel-shell.tsx), at the chips' height.
const FIELD = CONTROL + " " + TINTS.neutral.control + " h-8 px-2";
const FIELD_LABEL = "text-xs font-medium " + TINTS.neutral.subtitleClass;
const PANEL_ICON = "h-[17px] w-[17px] stroke-[2.2]";
const CARD = "rounded-[18px] border " + TINTS.neutral.card;
// Two across when each card has 440px, one column under that.
const TWO_UP = "grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))]";

// One capper's row of the banner's stat strip. Before the first comparison arrives the cells are
// drawn empty, so the banner does not change height when it does.
function ProfileStrip({ name, color, profile }: { name: string; color: string; profile: CapperComparisonProfile | null }) {
  const stats = profile?.stats;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-white">
        <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate">{name}</span>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/[0.14] [@container_(min-width:420px)]:grid-cols-3">
        <StatCell label="Record" value={stats ? stats.wins + "-" + stats.losses + "-" + stats.pushes : "—"} />
        <StatCell
          label="Win rate"
          value={stats ? Math.round(stats.winPct) + "%" : "—"}
          tone={stats ? (getRecordColor(stats.winPct) === "green" ? "up" : "down") : undefined}
        />
        <StatCell
          label="Net units"
          value={stats ? (stats.netUnits >= 0 ? "+" : "") + stats.netUnits + "u" : "—"}
          tone={stats ? (stats.netUnits >= 0 ? "up" : "down") : undefined}
        />
        <StatCell label="ROI" value={stats ? (stats.roi >= 0 ? "+" : "") + stats.roi + "%" : "—"} tone={stats ? (stats.roi >= 0 ? "up" : "down") : undefined} />
        <StatCell label="Max drawdown" value={profile ? profile.maxDrawdown + "u" : "—"} tone={profile && profile.maxDrawdown > 0 ? "down" : undefined} />
        <StatCell label="Bets" value={profile ? String(profile.betCount) : "—"} />
      </div>
    </div>
  );
}

// A card header's legend: each series' name and where its line ends.
function SeriesLegend({ series }: { series: ComparisonSeries[] }) {
  return (
    <>
      {series.map((s) => {
        const end = s.points.length > 0 ? s.points[s.points.length - 1].cumulativeUnits : null;
        return (
          <span key={s.id} className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
            <span aria-hidden className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: s.color }} />
            <span className="truncate">{s.label}</span>
            <span className={"flex-none font-semibold tabular-nums " + (end === null ? "text-muted-foreground" : end >= 0 ? GREEN : RED)}>
              {end === null ? "—" : formatSignedUnits(end, 1)}
            </span>
          </span>
        );
      })}
    </>
  );
}

// A chart's card: the white panel of the capper page, with the legend in its header from `sm` up
// and under it on a phone. `children` is the chart, or what stands in for it.
function ChartCard({ title, subtitle, series, children }: { title: string; subtitle: string; series: ComparisonSeries[]; children: ReactNode }) {
  return (
    <PanelShell
      theme={{ ...TINTS.neutral, title, subtitle, icon: <TrendingUpIcon className={PANEL_ICON} /> }}
      control={
        series.length > 0 && (
          <div className="flex min-w-0 max-w-[60%] flex-none items-center gap-4 max-sm:hidden">
            <SeriesLegend series={series} />
          </div>
        )
      }
      footer={undefined}
    >
      {series.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 sm:hidden">
          <SeriesLegend series={series} />
        </div>
      )}
      {children}
    </PanelShell>
  );
}

// What a chart card holds until the first comparison arrives.
function ChartSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex h-72 animate-pulse items-end gap-2 px-1 pb-1">
      {[38, 52, 44, 63, 57, 72, 60, 78, 69, 84, 76, 90].map((h, i) => (
        <span key={i} className="flex-1 rounded-md bg-[#EEF1F6] dark:bg-white/10" style={{ height: h + "%" }} />
      ))}
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

  const brand = <BannerBrand icon={<ChartsIcon className={BANNER_ICON} />} title="Charts" tagline={["Compare", "Side by side"]} />;

  if (cappers.length < 2) {
    return (
      <div className="space-y-3.5">
        <NavyBanner>
          <div className={BANNER_ROW}>{brand}</div>
        </NavyBanner>
        <div className={CARD + " p-10 text-center text-[13px] font-medium text-muted-foreground"}>
          You need at least 2 cappers tracked to use comparison - log picks under a second capper first.
        </div>
      </div>
    );
  }

  const nameOf = (id: string) => cappers.find((c) => c.id === id)?.name ?? "";
  const selected = [
    { id: "a", capperId: capperAId, setCapperId: setCapperAId, label: "Capper A", color: SERIES_COLORS[0], profile: data?.a ?? null },
    { id: "b", capperId: capperBId, setCapperId: setCapperBId, label: "Capper B", color: SERIES_COLORS[1], profile: data?.b ?? null },
  ];
  const series: ComparisonSeries[] = data
    ? [
        { id: "a", label: data.a.capperName, color: SERIES_COLORS[0], points: data.a.chartData },
        { id: "b", label: data.b.capperName, color: SERIES_COLORS[1], points: data.b.chartData },
      ]
    : [];

  const preset = activePreset(filters.dateRange);
  const timeLabel = preset ? preset.long : filters.dateRange ? filters.dateRange.start + " to " + filters.dateRange.end : "All time";
  const sportLabel = sports.find((s) => s.id === filters.sportId)?.name ?? "All leagues";
  // The filters the subtitle does not spell out: everything but the league and the dates.
  const otherFilters = (Object.keys(filters) as (keyof ComparisonFilters)[]).filter((k) => k !== "sportId" && k !== "dateRange" && filters[k] !== null).length;
  const filterLabel = sportLabel + " · " + timeLabel + (otherFilters > 0 ? " · +" + otherFilters + (otherFilters === 1 ? " filter" : " filters") : "");

  // A refetch keeps the last comparison on screen, dimmed, until the new one arrives.
  const chart = (shown: ComparisonSeries[], height: number) => (
    <div className={"transition-opacity " + (loading ? "opacity-60" : "")} onDoubleClick={fs.supported ? fs.toggle : undefined}>
      <CapperComparisonChart series={shown} height={fs.isFullscreen ? (fs.chartHeight ?? FULLSCREEN_CHART_HEIGHT) : height} />
    </div>
  );

  return (
    <div ref={fs.ref} className={(fs.isFullscreen ? FULLSCREEN_SURFACE_CLASS + " " : "") + "space-y-3.5"}>
      <NavyBanner>
        <div className={BANNER_ROW + " [@container_(min-width:640px)]:flex-wrap"}>
          {brand}
          <div className={BANNER_CONTROLS + " [@container_(min-width:640px)]:py-3"}>
            <div role="group" aria-label="Time range" className="flex max-w-full gap-0.5 rounded-full border border-white/[0.14] bg-white/[0.08] p-0.5">
              {TIME_PRESETS.map((p) => {
                const active = p === preset;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    aria-label={p.long}
                    onClick={() => updateFilter("dateRange", p.days === null ? null : presetRange(p.days))}
                    className={
                      "flex h-7 flex-none items-center whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors " +
                      (active ? "bg-white text-banner" : "text-[#D3DEFA] hover:text-white")
                    }
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* One row that scrolls sideways on a phone, as on /cappers; it wraps from `sm` up. */}
        <div
          role="group"
          aria-label="League"
          className={"relative flex gap-1.5 overflow-x-auto border-t border-[rgba(59,130,246,0.18)] px-3 py-2.5 sm:flex-wrap sm:px-5 sm:py-3 " + NO_SCROLLBAR}
        >
          {[{ id: null as string | null, name: "All leagues" }, ...sports].map((s) => {
            const active = s.id === filters.sportId;
            return (
              <button
                key={s.id ?? "ALL"}
                type="button"
                aria-pressed={active}
                onClick={() => updateFilter("sportId", s.id)}
                className={
                  "flex h-8 flex-none items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-medium transition-colors " +
                  (active ? "border-white bg-white text-banner" : "border-white/[0.14] bg-white/[0.08] text-[#D3DEFA] hover:text-white")
                }
              >
                <span
                  aria-hidden
                  className={"h-2 w-2 rounded-sm " + (active ? "bg-[var(--league)]" : "bg-[var(--league-dark)]")}
                  style={leagueColorVars(s.id === null ? "" : s.name)}
                />
                {s.name}
              </button>
            );
          })}
        </div>

        <div className={"relative grid gap-3 px-3 pb-3 transition-opacity sm:px-5 sm:pb-4 [@container_(min-width:900px)]:grid-cols-2 " + (loading && data ? "opacity-60" : "")}>
          {selected.map((s) => (
            <ProfileStrip key={s.id} name={s.profile?.capperName ?? nameOf(s.capperId)} color={s.color} profile={s.profile} />
          ))}
        </div>
      </NavyBanner>

      <div className={CARD + " space-y-2.5 p-3"}>
        <div className="flex flex-wrap items-center gap-2">
          {selected.map((s, i) => (
            <div key={s.id} className="contents">
              {i > 0 && <span className={FIELD_LABEL}>vs</span>}
              <label className={"flex h-8 min-w-0 items-center gap-2 rounded-full border pl-3 pr-1.5 " + TINTS.neutral.control}>
                <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ backgroundColor: s.color }} />
                <span className="sr-only">{s.label}</span>
                <select
                  value={s.capperId}
                  onChange={(e) => s.setCapperId(e.target.value)}
                  className="min-w-0 max-w-[11rem] truncate bg-transparent text-[13px] font-semibold text-foreground focus:outline-none"
                >
                  {cappers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <div role="group" aria-label="Chart layout" className="flex gap-0.5 rounded-full bg-[#F1F4F9] p-0.5 dark:bg-white/[0.06]">
              {(["overlay", "split"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                  className={
                    "flex h-7 items-center rounded-full px-3 text-[13px] font-medium capitalize transition-colors " +
                    (view === mode
                      ? "bg-white text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.12)] dark:bg-white/[0.14] dark:text-foreground dark:shadow-none"
                      : "text-[#64748B] hover:text-[#0F172A] dark:text-muted-foreground dark:hover:text-foreground")
                  }
                >
                  {mode}
                </button>
              ))}
            </div>
            {fs.supported && <FullscreenButton isFullscreen={fs.isFullscreen} onClick={fs.toggle} />}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[#0F1420]/[0.08] pt-2.5 dark:border-white/10">
          <select
            aria-label="Bet type"
            value={filters.betType ?? ""}
            onChange={(e) => updateFilter("betType", (e.target.value || null) as BetTypeFilterKey | null)}
            className={FIELD}
          >
            <option value="">All bet types</option>
            {BET_TYPE_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Favorite or underdog"
            value={filters.favDog ?? ""}
            onChange={(e) => updateFilter("favDog", (e.target.value || null) as ComparisonFilters["favDog"])}
            className={FIELD}
          >
            <option value="">Favorite or underdog</option>
            <option value="FAVORITE">Favorite</option>
            <option value="UNDERDOG">Underdog</option>
          </select>

          <select
            aria-label="Day of week"
            value={filters.dayOfWeek === null ? "" : String(filters.dayOfWeek)}
            onChange={(e) => updateFilter("dayOfWeek", e.target.value === "" ? null : Number(e.target.value))}
            className={FIELD}
          >
            <option value="">Any day</option>
            {DAY_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>

          <select
            aria-label="Month"
            value={filters.month === null ? "" : String(filters.month)}
            onChange={(e) => updateFilter("month", e.target.value === "" ? null : Number(e.target.value))}
            className={FIELD}
          >
            <option value="">Any month</option>
            {MONTH_LABELS.map((label, i) => (
              <option key={i} value={i + 1}>
                {label}
              </option>
            ))}
          </select>

          <select
            aria-label="Streak"
            value={filterToStreakOption(filters.streak)}
            onChange={(e) => updateFilter("streak", streakOptionToFilter(e.target.value as StreakOption))}
            className={FIELD}
          >
            {STREAK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {/* A custom range; the banner's presets fill the same two fields. */}
          <DateRangePicker
            value={filters.dateRange ?? { start: "", end: "" }}
            onChange={(next) => updateFilter("dateRange", next.start && next.end ? next : null)}
          />

          <div className="flex items-center gap-1.5">
            <label className={FIELD_LABEL}>Odds</label>
            <DebouncedNumberInput placeholder="min" value={filters.oddsMin} onCommit={(v) => updateFilter("oddsMin", v)} className={FIELD + " w-20"} />
            <span className={FIELD_LABEL}>to</span>
            <DebouncedNumberInput placeholder="max" value={filters.oddsMax} onCommit={(v) => updateFilter("oddsMax", v)} className={FIELD + " w-20"} />
          </div>

          <div className="flex items-center gap-1.5">
            <label className={FIELD_LABEL}>Units</label>
            <DebouncedNumberInput placeholder="min" value={filters.unitsMin} onCommit={(v) => updateFilter("unitsMin", v)} className={FIELD + " w-16"} />
            <span className={FIELD_LABEL}>to</span>
            <DebouncedNumberInput placeholder="max" value={filters.unitsMax} onCommit={(v) => updateFilter("unitsMax", v)} className={FIELD + " w-16"} />
          </div>

          {JSON.stringify(filters) !== JSON.stringify(EMPTY_COMPARISON_FILTERS) && (
            <button type="button" onClick={() => setFilters(EMPTY_COMPARISON_FILTERS)} className="text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* As on the capper page: 14px between the blocks above, more air around the panels. */}
      <div className="pt-2.5">
        {view === "overlay" || !data ? (
          <ChartCard title="Cumulative units" subtitle={filterLabel} series={series}>
            {data ? chart(series, 320) : error ? <Message error>{error}</Message> : <ChartSkeleton />}
          </ChartCard>
        ) : (
          <div className={TWO_UP}>
            {series.map((s) => (
              <ChartCard key={s.id} title={s.label} subtitle={filterLabel} series={[s]}>
                {chart([s], 260)}
              </ChartCard>
            ))}
          </div>
        )}
        {data && error && <p className={"mt-2 text-[13px] font-medium " + RED}>{error}</p>}
      </div>
    </div>
  );
}
