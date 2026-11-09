// Today's Momentum card (components/picks/momentum-card.tsx): the running net units across a day's
// graded picks, one point per grading minute. Pure and client-safe, and built from rows /picks
// already loaded - no queries.
//
// TIME: Pick.gradedAt is `timestamp WITHOUT time zone`. Prisma reads and writes such a column as UTC
// wall-clock, so the Date the page receives is the correct instant (prod check: gradedAt sits a
// median 3.75 h after gameTime, i.e. 3:15 PM ET for a 1 PM ET game, not 5 h off). Everything here
// works in epoch ms and converts to the VIEWER's IANA zone explicitly (`tz`), never via the
// machine's zone, so the server and the browser agree and the tests pin it.
import { winUnits } from "@/lib/pick-display";

const H = 3600000;
const MIN = 60000;
const SETTLED = new Set(["WIN", "LOSS", "PUSH"]);

export const FLAT_BELOW_UNITS = 1.5;
export const TREND_WINDOW_MS = 2 * H;
export const MIN_SPAN_MS = 2 * H;

export type MomentumEvent = { t: number; d: number };

function unitsDelta(p: { status: string; units: number; odds: number }): number {
  if (p.status === "WIN") return winUnits(p.units, p.odds);
  if (p.status === "LOSS") return -p.units;
  return 0;
}

// The graded picks as {when, units change}, for the client component. A settled pick with no
// gradedAt (old rows) has no time to plot: its change is returned as `unstamped` and folded into the
// last point, so the last point always equals the Net Units tile. Pushes move nothing and are dropped.
export function momentumEvents(
  picks: { status: string; units: number; odds: number; gradedAt: Date | null }[]
): { events: MomentumEvent[]; unstamped: number } {
  const events: MomentumEvent[] = [];
  let unstamped = 0;
  for (const p of picks) {
    if (!SETTLED.has(p.status)) continue;
    const d = unitsDelta(p);
    if (d === 0) continue;
    if (p.gradedAt) events.push({ t: p.gradedAt.getTime(), d });
    else unstamped += d;
  }
  events.sort((a, b) => a.t - b.t);
  return { events, unstamped };
}

// ---- time zone ----------------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
type Local = { dayKey: string; weekday: string; hour: number; minute: number; second: number };

export function localParts(ms: number, tz: string): Local {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const part of f.formatToParts(ms)) o[part.type] = part.value;
  return {
    dayKey: o.year + "-" + o.month + "-" + o.day,
    weekday: o.weekday,
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    second: Number(o.second),
  };
}

// "9:15 PM"
export function clockLabel(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return (l.hour % 12 || 12) + ":" + String(l.minute).padStart(2, "0") + " " + (l.hour >= 12 ? "PM" : "AM");
}

// "9PM" (":30" kept for a half-hour zone)
export function hourLabel(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return (l.hour % 12 || 12) + (l.minute ? ":" + String(l.minute).padStart(2, "0") : "") + (l.hour >= 12 ? "PM" : "AM");
}

export function floorToHour(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  return ms - (l.minute * 60 + l.second) * 1000 - (((ms % 1000) + 1000) % 1000);
}

// ---- the series ---------------------------------------------------------------------------------

export type MomentumPoint = {
  t: number;
  v: number; // running net units
  change: number; // since the previous point
  prevT: number | null; // that previous point's time (null on the first)
};
export type MomentumTick = { t: number; label: string; dayStart: boolean };
export type MomentumTrend = "up" | "down" | "flat";

export type Momentum = {
  empty: boolean;
  points: MomentumPoint[];
  net: number;
  xStart: number;
  xEnd: number;
  xTicks: MomentumTick[];
  yTicks: number[];
  yDomain: [number, number];
  trend: MomentumTrend;
  // Share of a gradient's height (top = 0) that is green: 1 all green, 0 all red.
  lineGreen: number;
  areaGreen: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const Y_STEPS = [20, 40, 50, 100, 200, 500, 1000, 2000];

export function yAxisFor(min: number, max: number): { ticks: number[]; domain: [number, number] } {
  let lo = Math.floor(Math.min(min, 0) / 20) * 20;
  let hi = Math.ceil(Math.max(max, 0) / 20) * 20;
  if (lo === 0 && hi === 0) {
    lo = -20;
    hi = 20;
  }
  const step = Y_STEPS.find((s) => (hi - lo) / s <= 8) ?? Y_STEPS[Y_STEPS.length - 1];
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const pad = step * 0.12;
  return { ticks, domain: [lo - pad, hi + pad] };
}

// Green fraction of a top-to-bottom gradient spanning [min, max] split at 0.
export function greenShare(min: number, max: number): number {
  if (min >= 0) return 1;
  if (max <= 0) return 0;
  return max / (max - min);
}

// Hours between labels, chosen from the span so the axis stays at about 5 labels: <=8 h -> 2 h,
// <=16 h -> 4 h, longer -> 6 h.
export function tickStepHours(spanMs: number): number {
  return spanMs <= 8 * H ? 2 : spanMs <= 16 * H ? 4 : 6;
}

// Ticks sit on local clock hours that are multiples of the step (12AM, 4AM, 8AM ...), not offset from
// xStart. Midnight always carries its weekday and the stronger gridline.
export function xTicksFor(xStart: number, xEnd: number, tz: string): MomentumTick[] {
  const step = tickStepHours(xEnd - xStart);
  const out: MomentumTick[] = [];
  let t = floorToHour(xStart, tz);
  while (t < xStart || localParts(t, tz).hour % step !== 0) t += H;
  for (; t <= xEnd; t += step * H) {
    const l = localParts(t, tz);
    const dayStart = l.hour === 0;
    out.push({ t, label: hourLabel(t, tz) + (dayStart ? " " + l.weekday : ""), dayStart });
  }
  return out;
}

export function buildMomentum(
  events: MomentumEvent[],
  unstamped: number,
  opts: { now: number; isToday: boolean; tz: string; dayEnd?: number }
): Momentum {
  const { now, isToday, tz } = opts;
  // Past day: the selected Eastern day's end (exclusive). Picks are in the day by GAME time but may be
  // graded much later (futures, multi-day parlays, regrades). Those late grades are folded into the
  // last in-day point so the axis stays inside the day and the last point still equals the Net Units tile.
  const dayEnd = !isToday && opts.dayEnd != null ? opts.dayEnd : null;
  let late = 0;
  let lateCount = 0;
  // One point per grading minute: a game's picks are stamped within a minute of each other.
  const buckets: { t: number; d: number }[] = [];
  for (const e of events) {
    if (dayEnd != null && e.t >= dayEnd) {
      late += e.d;
      lateCount++;
      continue;
    }
    const last = buckets[buckets.length - 1];
    if (last && Math.floor(last.t / MIN) === Math.floor(e.t / MIN)) {
      last.t = e.t;
      last.d += e.d;
    } else buckets.push({ t: e.t, d: e.d });
  }
  const extra = late + unstamped;
  if (extra !== 0) {
    if (buckets.length > 0) buckets[buckets.length - 1].d += extra;
    else buckets.push({ t: dayEnd != null ? dayEnd - MIN : now, d: extra });
  }
  const empty = buckets.length === 0;

  let xStart = empty ? floorToHour(now, tz) - 6 * H : floorToHour(buckets[0].t, tz);
  // A clamped axis can't grow past the day's end, so a late-night start is pulled back to keep MIN_SPAN_MS.
  if (dayEnd != null && !empty) xStart = Math.min(xStart, floorToHour(dayEnd - MIN_SPAN_MS, tz));
  const points: MomentumPoint[] = [{ t: xStart, v: 0, change: 0, prevT: null }];
  let run = 0;
  for (const b of buckets) {
    const prev = points[points.length - 1];
    run += b.d;
    points.push({ t: Math.max(b.t, prev.t), v: round2(run), change: round2(b.d), prevT: prev.t });
  }
  const lastPoint = points[points.length - 1];
  const rawEnd = empty ? now : isToday ? Math.max(lastPoint.t, now) : lastPoint.t;
  // Past day: never beyond the day's end, and exactly the day's end when late grades were folded.
  const xEnd =
    dayEnd != null && !empty
      ? lateCount > 0
        ? dayEnd
        : Math.min(Math.max(rawEnd, xStart + MIN_SPAN_MS), dayEnd)
      : Math.max(rawEnd, xStart + MIN_SPAN_MS);

  const vals = points.map((p) => p.v);
  const vmin = Math.min(...vals);
  const vmax = Math.max(...vals);
  const y = yAxisFor(vmin, vmax);

  // Trend: the change across the last 2 hours (to now on today, else to the last grade).
  const ref = isToday ? Math.max(now, lastPoint.t) : lastPoint.t;
  let base = 0;
  for (const p of points) if (p.t <= ref - TREND_WINDOW_MS) base = p.v;
  const delta = round2(lastPoint.v - base);
  const trend: MomentumTrend = Math.abs(delta) < FLAT_BELOW_UNITS ? "flat" : delta > 0 ? "up" : "down";

  return {
    empty,
    points,
    net: lastPoint.v,
    xStart,
    xEnd,
    xTicks: xTicksFor(xStart, xEnd, tz),
    yTicks: y.ticks,
    yDomain: y.domain,
    trend,
    lineGreen: greenShare(vmin, vmax),
    areaGreen: greenShare(Math.min(vmin, 0), Math.max(vmax, 0)),
  };
}

// The card's agreement check with the Net Units tile (dev-only use in the component).
export function momentumMatchesTile(momentumNet: number, tileNet: number): boolean {
  return Math.abs(momentumNet - tileNet) <= 0.01;
}
