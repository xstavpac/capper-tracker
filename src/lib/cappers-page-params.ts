// URL search-param contract for the /cappers page. The page is server-rendered, so
// every control (time tabs, filters, sort, pagination) is a param; nothing lives in
// client state. Defaults are omitted from the URL to keep links short.
import type { ScorecardWindow } from "@/server/data/stats";

export const RANGE_OPTIONS: { key: string; window: ScorecardWindow; label: string }[] = [
  { key: "all", window: "ALL", label: "All time" },
  { key: "today", window: "TODAY", label: "Today" },
  { key: "yesterday", window: "YESTERDAY", label: "Yesterday" },
  { key: "7d", window: "LAST_7", label: "Last 7 days" },
  { key: "30d", window: "LAST_30", label: "Last 30 days" },
  { key: "60d", window: "LAST_60", label: "Last 60 days" },
];

export const MIN_PICKS_OPTIONS = [0, 5, 10, 20, 50];
export const DEFAULT_MIN_PICKS = 10;

export const SORT_OPTIONS = [
  { key: "roi", label: "ROI" },
  { key: "win", label: "Win %" },
  { key: "units", label: "Units" },
  { key: "record", label: "Record" },
] as const;
export type CappersSortKey = (typeof SORT_OPTIONS)[number]["key"];

export const PAGE_SIZE = 20;

export type CappersParams = {
  range: string;
  window: ScorecardWindow;
  league?: string;
  min: number;
  sort: CappersSortKey;
  fav: boolean;
  q: string;
  page: number;
};

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseCappersParams(raw: Raw, leagues: string[]): CappersParams {
  const rangeOpt = RANGE_OPTIONS.find((r) => r.key === first(raw.range)) ?? RANGE_OPTIONS[0];
  const minRaw = Number(first(raw.min));
  const sort = SORT_OPTIONS.find((s) => s.key === first(raw.sort))?.key ?? "roi";
  const league = first(raw.league);
  const page = Math.floor(Number(first(raw.page)));
  return {
    range: rangeOpt.key,
    window: rangeOpt.window,
    league: league && leagues.includes(league) ? league : undefined,
    min: first(raw.min) !== undefined && MIN_PICKS_OPTIONS.includes(minRaw) ? minRaw : DEFAULT_MIN_PICKS,
    sort,
    fav: first(raw.fav) === "1",
    q: (first(raw.q) ?? "").slice(0, 80),
    page: page >= 1 ? page : 1,
  };
}

// Href for `params` with `overrides` applied. Anything but `page` resets the page to 1.
export function cappersHref(params: CappersParams, overrides: Partial<CappersParams> = {}): string {
  const next = { ...params, ...overrides };
  if (!("page" in overrides)) next.page = 1;
  const qs = new URLSearchParams();
  if (next.range !== "all") qs.set("range", next.range);
  if (next.league) qs.set("league", next.league);
  if (next.min !== DEFAULT_MIN_PICKS) qs.set("min", String(next.min));
  if (next.sort !== "roi") qs.set("sort", next.sort);
  if (next.fav) qs.set("fav", "1");
  if (next.q.trim()) qs.set("q", next.q.trim());
  if (next.page > 1) qs.set("page", String(next.page));
  const s = qs.toString();
  return s ? "/cappers?" + s : "/cappers";
}
