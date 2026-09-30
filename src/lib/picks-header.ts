// Pure helpers behind the /picks header (stat bar, top/coldest strip, sport
// chips, date arrows). Everything is computed from rows the page already
// loaded - no queries. Display-only: never touches grading or import.
// Client-safe (no prisma import).
import { winUnits } from "@/lib/pick-display";

const SETTLED = new Set(["WIN", "LOSS", "PUSH"]);

export type HeaderPick = {
  capperId: string;
  capperName: string;
  sportId: string;
  sportName: string;
  status: string;
  units: number;
  odds: number;
  gameTime: Date;
  gradedAt: Date | null;
};

// W / (W + L) as a whole percent; pushes excluded. null when nothing decided
// (a push-only set has no win rate either).
export function winRatePct(wins: number, losses: number): number | null {
  const d = wins + losses;
  return d > 0 ? Math.round((wins / d) * 100) : null;
}

function unitsDelta(p: { status: string; units: number; odds: number }): number {
  if (p.status === "WIN") return winUnits(p.units, p.odds);
  if (p.status === "LOSS") return -p.units;
  return 0;
}

// Cumulative units across settled picks, game time then settle time. Returns
// null under 2 settled picks (no line worth drawing).
export function cumulativeUnitsSeries(picks: HeaderPick[]): number[] | null {
  const settled = picks
    .filter((p) => SETTLED.has(p.status))
    .sort(
      (a, b) =>
        a.gameTime.getTime() - b.gameTime.getTime() ||
        (a.gradedAt?.getTime() ?? 0) - (b.gradedAt?.getTime() ?? 0)
    );
  if (settled.length < 2) return null;
  let run = 0;
  return settled.map((p) => (run += unitsDelta(p)));
}

export type CapperLine = {
  capperId: string;
  name: string;
  wins: number;
  losses: number;
  pushes: number;
  units: number;
};

// Top / coldest cappers among those with >= 2 settled picks. Top = most units,
// coldest = fewest; ties broken by record (wins - losses, then win rate) and
// then name so the result is deterministic. `top` is null unless that capper
// is actually positive and `coldest` unless negative, so a lone -2u capper is
// only ever Coldest. The whole thing is null when neither half qualifies or
// the view is a single capper.
export function topAndColdest(
  picks: HeaderPick[],
  singleCapperFiltered: boolean
): { top: CapperLine | null; coldest: CapperLine | null } | null {
  if (singleCapperFiltered) return null;
  const by = new Map<string, CapperLine & { settled: number }>();
  for (const p of picks) {
    if (!SETTLED.has(p.status)) continue;
    const c = by.get(p.capperId) ?? {
      capperId: p.capperId,
      name: p.capperName,
      wins: 0,
      losses: 0,
      pushes: 0,
      units: 0,
      settled: 0,
    };
    c.settled++;
    if (p.status === "WIN") c.wins++;
    else if (p.status === "LOSS") c.losses++;
    else c.pushes++;
    c.units += unitsDelta(p);
    by.set(p.capperId, c);
  }
  const eligible: CapperLine[] = [...by.values()]
    .filter((c) => c.settled >= 2)
    .map((c) => ({
      capperId: c.capperId,
      name: c.name,
      wins: c.wins,
      losses: c.losses,
      pushes: c.pushes,
      units: Math.round(c.units * 100) / 100,
    }));
  if (eligible.length === 0) return null;
  // Positive when a has the better record than b.
  const recordCmp = (a: CapperLine, b: CapperLine) =>
    a.wins - a.losses - (b.wins - b.losses) ||
    (winRatePct(a.wins, a.losses) ?? 0) - (winRatePct(b.wins, b.losses) ?? 0) ||
    b.name.localeCompare(a.name);
  const best = [...eligible].sort((a, b) => b.units - a.units || recordCmp(b, a))[0];
  const worst = [...eligible].sort((a, b) => a.units - b.units || recordCmp(a, b))[0];
  const top = best.units > 0 ? best : null;
  const coldest = worst.units < 0 ? worst : null;
  return top || coldest ? { top, coldest } : null;
}

export type SportChip = { id: string; name: string; count: number };

const byCountThenName = (a: SportChip, b: SportChip) => b.count - a.count || a.name.localeCompare(b.name);

// Sport chips sorted by pick count desc (name breaks ties). The first
// `visibleCount` are shown; the rest overflow into "More". A selected sport
// that would sit in More is promoted into the visible row (displacing the
// last visible chip into More) so it is always visible.
export function sportChipLayout(
  picks: { sportId: string; sportName: string }[],
  selectedSportId: string | null,
  visibleCount = 4
): { visible: SportChip[]; more: SportChip[]; total: number } {
  const counts = new Map<string, SportChip>();
  for (const p of picks) {
    const c = counts.get(p.sportId) ?? { id: p.sportId, name: p.sportName, count: 0 };
    c.count++;
    counts.set(p.sportId, c);
  }
  const sorted = [...counts.values()].sort(byCountThenName);
  let visible = sorted.slice(0, visibleCount);
  let more = sorted.slice(visibleCount);
  const sel = selectedSportId ? more.find((s) => s.id === selectedSportId) : undefined;
  if (sel) {
    const displaced = visible[visible.length - 1];
    visible = [...visible.slice(0, -1), sel];
    more = [displaced, ...more.filter((s) => s.id !== sel.id)].sort(byCountThenName);
  }
  return { visible, more, total: picks.length };
}

// YYYY-MM-DD +/- N days (calendar math in UTC, so DST can't skew it).
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The href a date arrow navigates to: same path and other params, `date` set
// to the shifted day, and range params dropped (arrows only exist in
// single-day mode).
export function dateStepHref(pathname: string, currentQuery: string, dateKey: string, days: number): string {
  const next = new URLSearchParams(currentQuery);
  next.delete("startDate");
  next.delete("endDate");
  next.set("date", shiftDateKey(dateKey, days));
  return pathname + "?" + next.toString();
}
