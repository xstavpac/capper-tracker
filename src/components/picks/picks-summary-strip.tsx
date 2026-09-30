import type { ReactNode } from "react";
import type { PicksSummary } from "@/server/data/picks-summary";
import { winRatePct, type CapperLine } from "@/lib/picks-header";

function signedUnits(n: number): string {
  return (n > 0 ? "+" : "") + n.toFixed(2) + "u";
}

function tone(n: number): string {
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : n < 0 ? "text-red-600 dark:text-red-400" : "text-foreground";
}

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "h-3.5 w-3.5",
  "aria-hidden": true,
};

const RecordIcon = () => (
  <svg {...iconProps}>
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z" />
  </svg>
);
const UnitsIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
  </svg>
);
const RoiIcon = () => (
  <svg {...iconProps}>
    <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
  </svg>
);
const ClockIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const FlameIcon = () => (
  <svg {...iconProps}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
  </svg>
);

const SnowflakeIcon = () => (
  <svg {...iconProps}>
    <path d="M12 2v20M4.9 7l14.2 10M4.9 17L19.1 7M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5" />
  </svg>
);

function Sparkline({ series }: { series: number[] }) {
  const w = 72;
  const h = 22;
  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series);
  const span = max - min || 1;
  const pts = series
    .map((v, i) => ((i / (series.length - 1)) * w).toFixed(1) + "," + (h - 2 - ((v - min) / span) * (h - 4)).toFixed(1))
    .join(" ");
  const positive = series[series.length - 1] >= 0;
  return (
    <svg
      viewBox={"0 0 " + w + " " + h}
      className={"h-5 w-[72px] shrink-0 " + (positive ? "text-emerald-500" : "text-red-500")}
      role="img"
      aria-label="Cumulative units across settled picks"
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Stat({
  icon,
  label,
  value,
  valueClass,
  extra,
  sub,
  className,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  extra?: ReactNode;
  sub: ReactNode;
  className?: string;
}) {
  return (
    <div className={"min-w-0 px-4 py-3 " + (className ?? "")}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className={"text-xl font-semibold tabular-nums " + (valueClass ?? "text-foreground")}>{value}</div>
        {extra}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// One bordered card, four columns split by hairlines (2x2 on phones), for the
// current filter set. `live` + `later` are the still-to-play picks (Live and
// not-started only - Grading and Awaiting-result picks are excluded).
export function PicksSummaryStrip({
  summary,
  series,
  live,
  later,
}: {
  summary: PicksSummary;
  series: number[] | null;
  live: number;
  later: number;
}) {
  const settled = summary.wins + summary.losses + summary.pushes;
  const rate = winRatePct(summary.wins, summary.losses);
  const decided = settled > 0;
  const avgStake = decided ? summary.unitsRisked / settled : 0;
  return (
    <div className="mb-3 grid grid-cols-2 overflow-hidden rounded-card border border-border bg-card shadow-soft sm:grid-cols-4">
      <Stat
        icon={<RecordIcon />}
        label="Record"
        value={summary.wins + "-" + summary.losses + "-" + summary.pushes}
        className="border-b border-r border-border sm:border-b-0"
        sub={
          rate === null ? (
            "No settled picks"
          ) : (
            <span className="flex items-center gap-2">
              <span
                className="block h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-red-500/70"
                role="img"
                aria-label={rate + "% win rate"}
              >
                <span className="block h-full bg-emerald-500" style={{ width: rate + "%" }} />
              </span>
              <span>{rate + "% win rate"}</span>
            </span>
          )
        }
      />
      <Stat
        icon={<UnitsIcon />}
        label="Units"
        value={signedUnits(summary.netUnits)}
        valueClass={tone(summary.netUnits)}
        extra={series ? <Sparkline series={series} /> : null}
        className="border-b border-border sm:border-b-0 sm:border-r"
        sub={decided ? avgStake.toFixed(2) + "u avg stake · " + settled + " settled" : "No settled picks"}
      />
      <Stat
        icon={<RoiIcon />}
        label="ROI"
        value={decided ? (summary.roi > 0 ? "+" : "") + summary.roi.toFixed(1) + "%" : "-"}
        valueClass={decided ? tone(summary.roi) : undefined}
        className="border-r border-border"
        sub={"on " + summary.unitsRisked.toFixed(2) + " units risked"}
      />
      <Stat
        icon={<ClockIcon />}
        label="Still to play"
        value={String(live + later)}
        sub={
          <span>
            <span className="text-red-500" aria-hidden="true">
              ●
            </span>{" "}
            {live + " live · " + later + " later"}
          </span>
        }
      />
    </div>
  );
}

function StripEntry({ label, line, icon }: { label: string; line: CapperLine; icon?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{line.name}</span>
      <span className="text-muted-foreground">{line.wins + "-" + line.losses}</span>
      <span className={"tabular-nums " + tone(line.units)}>{signedUnits(line.units)}</span>
    </span>
  );
}

// Subtle single row under the stat bar. Qualification and hide rules live in
// topAndColdest (lib/picks-header.ts); this renders whichever halves it
// returns, split by a thin divider when both show.
export function TopColdestStrip({
  top,
  coldest,
  topLabel,
}: {
  top: CapperLine | null;
  coldest: CapperLine | null;
  topLabel: string;
}) {
  if (!top && !coldest) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border-subtle bg-muted/40 px-4 py-2 text-xs">
      {top && (
        <StripEntry
          label={topLabel}
          line={top}
          icon={
            <span className="text-amber-500">
              <FlameIcon />
            </span>
          }
        />
      )}
      {top && coldest && <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />}
      {coldest && (
        <StripEntry
          label="Coldest"
          line={coldest}
          icon={
            <span className="text-sky-500">
              <SnowflakeIcon />
            </span>
          }
        />
      )}
    </div>
  );
}
