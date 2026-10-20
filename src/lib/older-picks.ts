// "Load older picks" on /picks: the pure, client-safe half. The first page
// (the date window) is untouched; each click reads strictly older rows with a
// keyset cursor on the Settled order (gameTime DESC, id DESC) - never OFFSET.
// The server half is server/data/picks-older.ts; the action is
// loadOlderPicksAction (server/actions/picks.ts).

// Rows one DB page reads (one more is read to know whether anything is older).
export const OLDER_PICKS_PAGE_SIZE = 50;
// A bet-type filter is cut in memory after the read, so a page can come back
// sparse. The action then reads on until it has this many visible rows...
export const OLDER_PICKS_MIN_VISIBLE = 10;
// ...but never more than this many DB pages in one click (~150 rows).
export const OLDER_PICKS_MAX_PAGES_PER_CLICK = 3;

// The position after the last row a click read. gameTime as an ISO string so
// it survives the action boundary.
export type OlderPicksCursor = { gameTime: string; id: string };

// What the older rows follow: the page's filters, and `before`, the first
// Eastern day of the window the page shows (older rows are strictly before it).
export type OlderPicksQuery = {
  capperId?: string;
  sportId?: string;
  status?: string;
  betType?: string;
  before: string;
};

const QUERY_KEYS = ["capperId", "sportId", "status", "betType", "before"] as const;

// The filters only (empty ones dropped): a change to any of them resets the
// older rows to none loaded.
export function olderPicksQueryKey(q: OlderPicksQuery): string {
  return QUERY_KEYS.filter((k) => q[k]).map((k) => k + "=" + q[k]).join("&");
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
// Row ids are cuids; capper and sport ids the same. Shape only: every id is
// used inside a userId-scoped WHERE, never to read anything on its own.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PICK_STATUSES = ["PENDING", "WIN", "LOSS", "PUSH", "CANCELLED"];
const BET_TYPE_KEY = /^[A-Z0-9_]{1,32}$/;

// Validates what the client sent. Returns null for anything malformed rather
// than dropping the bad field: a filter silently ignored would load rows the
// user filtered out.
export function parseOlderPicksQuery(raw: unknown): OlderPicksQuery | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<OlderPicksQuery> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(QUERY_KEYS as readonly string[]).includes(k)) return null;
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return null;
    const ok =
      k === "capperId" || k === "sportId"
        ? ID.test(v)
        : k === "status"
          ? PICK_STATUSES.includes(v)
          : k === "betType"
            ? BET_TYPE_KEY.test(v)
            : DATE_KEY.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
    if (!ok) return null;
    out[k as keyof OlderPicksQuery] = v;
  }
  return out.before ? (out as OlderPicksQuery) : null;
}

export function parseOlderPicksCursor(raw: unknown): OlderPicksCursor | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return "invalid";
  const { gameTime, id } = raw as Record<string, unknown>;
  if (typeof gameTime !== "string" || typeof id !== "string" || !ID.test(id)) return "invalid";
  const t = Date.parse(gameTime);
  if (Number.isNaN(t) || new Date(t).toISOString() !== gameTime) return "invalid";
  return { gameTime, id };
}

// Sorted, merged [start, end) windows of +-padMs around each time: the
// game_results read for a page of older picks covers the days the picks are
// on, not every day between the oldest and the newest.
export function mergedTimeWindows(times: number[], padMs: number): { start: number; end: number }[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t - padMs <= last.end) last.end = Math.max(last.end, t + padMs);
    else out.push({ start: t - padMs, end: t + padMs });
  }
  return out;
}

// Consecutive runs of rows on the same day, in list order. Computed over the
// whole merged list every render, so two clicks that split one day still give
// that day one header.
export function groupByDay<T>(rows: T[], dayKeyOf: (row: T) => string): { dayKey: string; rows: T[] }[] {
  const out: { dayKey: string; rows: T[] }[] = [];
  for (const row of rows) {
    const key = dayKeyOf(row);
    const last = out[out.length - 1];
    if (last && last.dayKey === key) last.rows.push(row);
    else out.push({ dayKey: key, rows: [row] });
  }
  return out;
}
