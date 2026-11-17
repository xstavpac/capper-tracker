// Momentum card, 7D / 30D ranges (components/picks/momentum-card.tsx). Pure and client-safe.
//
// The server (server/data/momentum-daily.ts) returns ONE aggregated row per Eastern game day that has a
// settled pick: that day's net units. This file turns those rows into the same `Momentum` shape the
// intraday "Today" view renders, so the card's chart, colours and pill are shared:
//   - one point per day over the trailing window ending today (a day with no picks is a real 0u day),
//   - the line is the RUNNING net across the window, so the last point is the range's total (the big number),
//   - today's still-open day is simply the latest, partial point.
// The Today view (momentum.ts buildMomentum) does not import or call anything here.
import { addDaysToDateKey, easternDayStart } from "@/lib/dates";
import { FLAT_BELOW_UNITS, greenShare, yAxisFor, type Momentum, type MomentumPoint, type MomentumTrend } from "@/lib/momentum";

export type MomentumRange = "7D" | "30D";
export const MOMENTUM_RANGES: readonly MomentumRange[] = ["7D", "30D"];
// 30 days is the hard cap: nothing longer is accepted anywhere (action, query, builder).
export const MOMENTUM_RANGE_DAYS: Record<MomentumRange, number> = { "7D": 7, "30D": 30 };

// How many trailing days the "Trending" pill looks at: the recent slope inside the selected window.
export const TREND_DAYS: Record<MomentumRange, number> = { "7D": 2, "30D": 7 };

export type DailyNet = { day: string; net: number }; // day = Eastern "YYYY-MM-DD"

const round2 = (n: number) => Math.round(n * 100) / 100;

// The window's day keys, oldest first, ending at (and including) endKey.
export function rangeDayKeys(range: MomentumRange, endKey: string): string[] {
  const n = MOMENTUM_RANGE_DAYS[range];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDaysToDateKey(endKey, -i));
  return out;
}

// "Nov 10" from a date key, no time zone involved (pure calendar text).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function shortDayLabel(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return MONTHS[m - 1] + " " + d;
}
export function longDayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + " " + shortDayLabel(key);
}

export function buildDailyMomentum(rows: DailyNet[], range: MomentumRange, endKey: string): Momentum {
  const keys = rangeDayKeys(range, endKey);
  const byDay = new Map(rows.map((r) => [r.day, r.net]));
  // Rows outside the window are ignored, so a late/odd row can't leak past the cap.
  const points: MomentumPoint[] = [];
  let run = 0;
  let any = false;
  keys.forEach((key, i) => {
    const d = round2(byDay.get(key) ?? 0);
    if (byDay.has(key)) any = true;
    run = round2(run + d);
    const prev = i > 0 ? points[i - 1] : null;
    points.push({
      t: easternDayStart(key).getTime(),
      v: run,
      change: d,
      prevT: prev ? prev.t : null,
      label: longDayLabel(key),
      prevLabel: i > 0 ? shortDayLabel(keys[i - 1]) : null,
    });
  });

  // Trend: change across the last TREND_DAYS days of the window (real slope, not the intraday 2 h rule).
  const k = TREND_DAYS[range];
  const last = points[points.length - 1];
  const baseV = points.length - 1 - k >= 0 ? points[points.length - 1 - k].v : 0;
  const delta = round2(last.v - baseV);
  const trend: MomentumTrend = Math.abs(delta) < FLAT_BELOW_UNITS ? "flat" : delta > 0 ? "up" : "down";

  // Axis labels: every day for 7D, every 5th (anchored on today) for 30D so they never crowd.
  const every = range === "7D" ? 1 : 5;
  const xTicks = points
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => (points.length - 1 - i) % every === 0)
    .map(({ p, i }) => ({ t: p.t, label: shortDayLabel(keys[i]), dayStart: false }));

  const vals = points.map((p) => p.v);
  const vmin = Math.min(...vals);
  const vmax = Math.max(...vals);
  const y = yAxisFor(vmin, vmax);
  return {
    empty: !any,
    points,
    net: last.v,
    xStart: points[0].t,
    xEnd: last.t,
    xTicks,
    yTicks: y.ticks,
    yDomain: y.domain,
    trend,
    lineGreen: greenShare(vmin, vmax),
    areaGreen: greenShare(Math.min(vmin, 0), Math.max(vmax, 0)),
  };
}
