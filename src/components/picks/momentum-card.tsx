"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buildMomentum, clockLabel, momentumMatchesTile, type MomentumEvent, type MomentumPoint } from "@/lib/momentum";
import { TrendingUpIcon } from "@/components/dashboard/cappers-icons";

const GREEN_LINE = "#22a55a";
const RED_LINE = "#dc2626";

const u2 = (v: number) => (v > 0.005 ? "+" : v < -0.005 ? "−" : "") + Math.abs(v).toFixed(2) + "u";
const tickU = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + "u";
const dotColor = (v: number) => (v >= 0 ? "#16a34a" : RED_LINE);

const PILL = {
  up: { label: "Trending Up", cls: "bg-[#dcf3e4] text-[#137a3a] dark:bg-emerald-500/15 dark:text-emerald-300", dot: "#16a34a" },
  down: { label: "Trending Down", cls: "bg-[#fde0e0] text-[#b91c1c] dark:bg-red-500/15 dark:text-red-300", dot: RED_LINE },
  flat: { label: "Holding Flat", cls: "bg-[#eef1f6] text-[#334155] dark:bg-white/10 dark:text-slate-300", dot: "#64748b" },
} as const;

// Today's Momentum: running net units across the day's graded picks, one point per grading minute.
// `events` are {gradedAt ms, units change} computed on the server from rows /picks already loaded
// (momentumEvents); the viewer's time zone is only known here, so the series is built after mount.
export function MomentumCard({
  events,
  unstamped,
  tileNet,
  isToday,
}: {
  events: MomentumEvent[];
  unstamped: number;
  // The Net Units tile's number; the card's last point must equal it (dev-only warning otherwise).
  tileNet: number;
  isToday: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const [tz, setTz] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setNow(Date.now());
  }, []);

  const m = useMemo(() => (tz ? buildMomentum(events, unstamped, { now, isToday, tz }) : null), [events, unstamped, now, isToday, tz]);

  useEffect(() => {
    if (m && process.env.NODE_ENV !== "production" && !momentumMatchesTile(m.net, tileNet)) {
      console.warn("[momentum] last point " + m.net + "u differs from the Net Units tile " + tileNet + "u");
    }
  }, [m, tileNet]);

  const net = m ? m.net : tileNet;
  const down = net < 0;
  const pill = PILL[m ? m.trend : "flat"];

  return (
    <section
      aria-label="Today's Momentum"
      className={
        "flex flex-wrap gap-x-7 gap-y-2 rounded-[18px] border px-5 pb-3 pt-5 sm:px-6 " +
        (down
          ? "border-[#f8cfd2] bg-[#fff5f5] dark:border-red-500/30 dark:bg-red-500/10"
          : "border-[#cbe9d4] bg-[#f3fbf5] dark:border-emerald-500/30 dark:bg-emerald-500/10")
      }
    >
      <div
        className={
          "flex min-w-[200px] flex-1 flex-col gap-6 sm:flex-none sm:basis-[230px] sm:gap-9 sm:border-r sm:pr-6 " +
          (down ? "border-[#f3d3d6] dark:border-red-500/25" : "border-[#d3ebdb] dark:border-emerald-500/25")
        }
      >
        <div className="flex items-center gap-2.5">
          <TrendingUpIcon className="h-[22px] w-[22px]" />
          <h2 className="text-[19px] font-bold">{isToday ? "Today's Momentum" : "Day's Momentum"}</h2>
        </div>
        <div>
          <p
            className={
              "text-[44px] font-bold leading-[1.05] tracking-[-0.02em] tabular-nums sm:text-[50px] " +
              (down ? "text-[#a01523] dark:text-red-400" : "text-[#137a3a] dark:text-emerald-400")
            }
          >
            {(net > 0 ? "+" : "") + net.toFixed(2) + "u"}
          </p>
          <p className="mt-1.5 text-base text-foreground/80">Current Net Units</p>
        </div>
      </div>

      <div className="flex min-w-0 flex-[999_1_340px] flex-col">
        <div className="flex justify-end">
          <span className={"flex items-center gap-2 rounded-full px-3.5 py-[7px] text-sm font-semibold " + pill.cls}>
            <span className="h-[9px] w-[9px] rounded-full" style={{ background: pill.dot }} />
            {pill.label}
          </span>
        </div>
        <div className="-mt-2 h-[230px] w-full text-slate-600 dark:text-slate-300">
          {m ? <Chart m={m} tz={tz as string} uid={uid} isToday={isToday} down={down} /> : null}
        </div>
      </div>
    </section>
  );
}

function Chart({ m, tz, uid, isToday, down }: { m: NonNullable<ReturnType<typeof buildMomentum>>; tz: string; uid: string; isToday: boolean; down: boolean }) {
  const tickLabel = new Map(m.xTicks.map((t) => [t.t, t.label]));
  const last = m.points[m.points.length - 1];
  const grid = down ? "#f2dfe1" : "#dcefe2";
  const lineId = "ml" + uid;
  const areaId = "ma" + uid;
  const stop = (share: number) => Math.round(share * 1000) / 10;

  return (
    <div className="relative h-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={m.points} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
          <defs>
            {/* objectBoundingBox: the gradient spans the drawn shape, so the split sits on the 0u line */}
            <linearGradient id={lineId} x1="0" y1="0" x2="0" y2="1">
              <stop offset={stop(m.lineGreen) + "%"} stopColor={GREEN_LINE} />
              <stop offset={stop(m.lineGreen) + "%"} stopColor={RED_LINE} />
            </linearGradient>
            <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={m.areaGreen === 0 ? RED_LINE : GREEN_LINE} stopOpacity={m.areaGreen === 0 ? 0.05 : 0.26} />
              <stop offset={stop(m.areaGreen) + "%"} stopColor={m.areaGreen === 0 ? RED_LINE : GREEN_LINE} stopOpacity={0.05} />
              <stop offset={stop(m.areaGreen) + "%"} stopColor={RED_LINE} stopOpacity={0.06} />
              <stop offset="100%" stopColor={RED_LINE} stopOpacity={m.areaGreen === 1 ? 0.06 : 0.24} />
            </linearGradient>
          </defs>
          {m.xTicks.map((t) => (
            <ReferenceLine key={t.t} x={t.t} stroke={grid} strokeWidth={t.dayStart ? 2 : 1} ifOverflow="visible" />
          ))}
          <XAxis
            type="number"
            dataKey="t"
            domain={[m.xStart, m.xEnd]}
            ticks={m.xTicks.map((t) => t.t)}
            tickFormatter={(v: number) => tickLabel.get(v) ?? ""}
            tick={{ fill: "currentColor", fontSize: 12.5 }}
            tickLine={false}
            axisLine={false}
            interval={0}
            allowDataOverflow
          />
          <YAxis
            type="number"
            domain={m.yDomain}
            ticks={m.yTicks}
            tickFormatter={tickU}
            tick={{ fill: "currentColor", fontSize: 12.5 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <ReferenceLine y={0} stroke="#a8b3c4" strokeWidth={1.25} strokeDasharray="5 5" />
          {!m.empty && (
            <Tooltip
              cursor={{ stroke: "#64748b", strokeDasharray: "3 3" }}
              content={<MomentumTip tz={tz} />}
              isAnimationActive={false}
            />
          )}
          <Area
            type="monotone"
            dataKey="v"
            baseValue={0}
            // One colour needs no gradient (and a zero-height flat line has no bounding box to paint one on).
            stroke={m.lineGreen === 1 ? GREEN_LINE : m.lineGreen === 0 ? RED_LINE : "url(#" + lineId + ")"}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={"url(#" + areaId + ")"}
            isAnimationActive={false}
            dot={m.empty ? false : <Dot lastT={last.t} />}
            activeDot={<ActiveDot />}
          />
        </AreaChart>
      </ResponsiveContainer>
      {m.empty && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 text-sm font-medium text-muted-foreground">
          {isToday ? "No picks graded yet today" : "No picks graded this day"}
        </p>
      )}
    </div>
  );
}

type DotProps = { cx?: number; cy?: number; payload?: MomentumPoint; lastT?: number };

// Small dots on the points; the last one is bigger with a soft glow.
function Dot({ cx, cy, payload, lastT }: DotProps) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  const c = dotColor(payload.v);
  if (payload.t === lastT) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={11} fill={c} fillOpacity={0.2} />
        <circle cx={cx} cy={cy} r={6} fill={c} stroke="#ffffff" strokeWidth={2} />
      </g>
    );
  }
  return <circle cx={cx} cy={cy} r={3.2} fill={c} />;
}

function ActiveDot({ cx, cy, payload }: DotProps) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  return <circle cx={cx} cy={cy} r={6} fill={dotColor(payload.v)} stroke="#ffffff" strokeWidth={2} />;
}

function MomentumTip({ active, payload, tz }: { active?: boolean; payload?: { payload: MomentumPoint }[]; tz: string }) {
  const p = active && payload && payload.length > 0 ? payload[0].payload : null;
  if (!p) return null;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold text-muted-foreground">{clockLabel(p.t, tz)}</p>
      <p className="mt-0.5 text-lg font-extrabold tabular-nums" style={{ color: dotColor(p.v) }}>
        {u2(p.v) + " net"}
      </p>
      <p className="mt-0.5 text-xs text-foreground/80 tabular-nums">
        {p.prevT === null ? "Start" : u2(p.change) + " since " + clockLabel(p.prevT, tz)}
      </p>
    </div>
  );
}
