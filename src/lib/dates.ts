// Every date/time in this app is pinned to US Eastern - sports schedules and
// broadcasts are all Eastern-native, and the app must behave identically no
// matter what timezone the server process happens to run in (Vercel
// functions default to UTC, local dev uses the machine's own TZ) or where a
// user is physically logged in from (VPN, travel, etc.). Nothing here should
// ever read Date's local getFullYear()/getMonth()/getDate()/toLocaleString()
// without an explicit timeZone - those silently follow the server process's
// own zone, not a fixed one.
export const APP_TIME_ZONE = "America/New_York";

function easternDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// UTC-minus-Eastern offset in minutes at this instant (240 for EDT, 300 for
// EST) - re-formatting the same instant's wall-clock string in both zones
// and re-parsing each as if it were server-local cancels out whatever the
// server's own local zone actually is, leaving just the real UTC/ET gap.
function easternOffsetMinutes(date: Date): number {
  const utcAsLocal = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const etAsLocal = new Date(date.toLocaleString("en-US", { timeZone: APP_TIME_ZONE }));
  return (utcAsLocal.getTime() - etAsLocal.getTime()) / 60000;
}

// The real UTC instant corresponding to 00:00:00 Eastern on the Eastern
// calendar day that `reference` falls on - used for "today"/"yesterday"
// window boundaries (see filterPicksByGameWindow in server/data/stats.ts).
export function startOfEasternDay(reference: Date): Date {
  const { year, month, day } = easternDateParts(reference);
  const utcMidnightGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMin = easternOffsetMinutes(utcMidnightGuess);
  return new Date(utcMidnightGuess.getTime() + offsetMin * 60000);
}

// "YYYY-MM-DD" for the Eastern calendar day `date` falls on - replaces the
// old todayKey()'s raw toISOString().slice(0,10), which keyed by UTC day and
// let evening ET games straddle the cache/window boundary a few hours early.
export function easternDateKey(date: Date): string {
  const { year, month, day } = easternDateParts(date);
  return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

// Do `a` and `b` fall on the same Eastern calendar day? Timezone-fixed
// replacement for the old sameLocalDay, which compared using the server
// process's own local zone instead of a consistent one.
export function sameEasternDay(a: Date, b: Date): boolean {
  const pa = easternDateParts(a);
  const pb = easternDateParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

// Turns a "YYYY-MM-DD" Eastern-calendar-day key (as typed into a native
// <input type="date">, or produced by easternDateKey above) into the UTC
// instant for that day's Eastern midnight. Parses via noon UTC first - the
// same trick model-engine/resolver.ts's snapshotDateToTimestamp already uses
// for this exact "YYYY-MM-DD" -> Eastern-day-instant problem - rather than
// `new Date(dateKey)` directly, which parses as UTC MIDNIGHT: for several
// hours every Eastern evening that's already the PREVIOUS Eastern calendar
// day, which would silently shift the boundary a day early.
export function easternDayStart(dateKey: string): Date {
  return startOfEasternDay(new Date(dateKey + "T12:00:00.000Z"));
}

// "YYYY-MM-DD" + `days` calendar days, still "YYYY-MM-DD". Pure calendar
// math on the key via Date.UTC (which overflows month/year boundaries
// correctly) - no wall-clock instant is involved, so it's inherently
// DST-proof, unlike adding 86400000ms.
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Do `a` and `b` fall within `maxDays` Eastern calendar days of each other?
// Compares the two Eastern midnights (not raw timestamps), so it counts
// whole calendar days regardless of time-of-day - "2 days" means up to the
// day-before-yesterday / day-after-tomorrow, inclusive, never a rolling 48h.
// Used to keep a pick's resolved game near its import date (see odds.ts).
export function withinDateDriftDays(a: Date, b: Date, maxDays: number): boolean {
  const dayMs = startOfEasternDay(a).getTime() - startOfEasternDay(b).getTime();
  return Math.round(Math.abs(dayMs) / 86400000) <= maxDays;
}

// The UTC instant range [start, end) covering every Eastern calendar day
// from startKey through endKey inclusive - used to scope a DB query's
// gameTime column to a single day (startKey === endKey) or a date range.
// `end` is the NEXT day's Eastern midnight, computed by adding to the
// calendar digits directly (via Date.UTC, which correctly overflows month/
// year boundaries) rather than a fixed 86400000ms - a range crossing a DST
// transition still lands on the right wall-clock boundary that way.
export function easternDateRange(startKey: string, endKey: string): { start: Date; end: Date } {
  return { start: easternDayStart(startKey), end: easternDayStart(addDaysToDateKey(endKey, 1)) };
}

// Formats `date` for display, always in Eastern - a thin wrapper so display
// call sites can't accidentally omit the timeZone and fall back to whatever
// zone the rendering server happens to be in.
export function formatEastern(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleString("en-US", { ...options, timeZone: APP_TIME_ZONE });
}

// Picks the item in `items` whose getTime() is nearest to `referenceTime` (ms).
// Shared by every "same two teams, which of these games is this" match -
// live scores to odds, resolved nicknames to a schedule game, picks to game results.
export function closestByTime<T>(items: T[], getTime: (item: T) => number, referenceTime: number): T {
  return items.reduce((closest, item) =>
    Math.abs(getTime(item) - referenceTime) < Math.abs(getTime(closest) - referenceTime) ? item : closest
  );
}

// "2h ago" / "3d ago" style relative time - `nowMs` is a required param
// (not a default parameter evaluated at call time) so a Server Component
// can pass one `Date.now()` snapshot for a whole render instead of each call
// site computing its own, and so this stays trivially testable.
export function formatRelativeTime(date: Date, nowMs: number): string {
  const diffMin = Math.round((nowMs - date.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return diffMin + "m ago";
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return diffHours + "h ago";
  const diffDays = Math.round(diffHours / 24);
  return diffDays + "d ago";
}
