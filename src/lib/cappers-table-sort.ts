// The order of the /cappers leaderboard table, and what a click on a column header does to it.
//
// The table is ranked and paginated in the database (cappers-page-aggregates.ts), so this
// comparator is not what orders the rows on screen: it is the definition that SQL has to match,
// row for row (cappers-page-aggregates-acceptance-test.ts compares the two). It only ever reads
// the numbers behind a row, never the text the row shows.
import type { CappersSortKey, SortDir } from "@/lib/cappers-page-params";

export type SortableCapper = {
  capperId: string;
  name: string;
  stats: { wins: number; losses: number; pushes: number; winPct: number; roi: number; netUnits: number };
};

// What a column sorts on, most significant number first - or null when the capper has nothing to
// show in it: no graded picks at all, no win or loss to take a Win % of, or a NaN (an odds-0 win
// can make ROI and units NaN, which has no place in an order).
// Record is wins, then losses as the tie-break with fewer losses ranking higher.
export function sortValues(e: SortableCapper, key: CappersSortKey): number[] | null {
  const { wins, losses, pushes, winPct, roi, netUnits } = e.stats;
  if (wins + losses + pushes === 0) return null;
  switch (key) {
    case "record":
      return [wins, -losses];
    case "win":
      return wins + losses > 0 ? [winPct] : null;
    case "roi":
      return Number.isNaN(roi) ? null : [roi];
    case "units":
      return Number.isNaN(netUnits) ? null : [netUnits];
  }
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Equal in the sorted column: net units high to low (NaN last), then name, then id. The same in
// both directions, so pages never reshuffle.
function tieBreak(a: SortableCapper, b: SortableCapper): number {
  const ua = a.stats.netUnits;
  const ub = b.stats.netUnits;
  if (Number.isNaN(ua) !== Number.isNaN(ub)) return Number.isNaN(ua) ? 1 : -1;
  if (ua !== ub && !Number.isNaN(ua)) return ua > ub ? -1 : 1;
  return cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) || cmpStr(a.name, b.name) || cmpStr(a.capperId, b.capperId);
}

// Array.sort comparator for the leaderboard. A capper with nothing to show in the column goes
// last whichever way the column is sorted.
export function compareCappers(key: CappersSortKey, dir: SortDir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return (a: SortableCapper, b: SortableCapper): number => {
    const va = sortValues(a, key);
    const vb = sortValues(b, key);
    if (!va || !vb) {
      if (va || vb) return va ? -1 : 1;
      return tieBreak(a, b);
    }
    for (let i = 0; i < va.length; i++) {
      // Compared, not subtracted: Infinity - Infinity is NaN.
      if (va[i] !== vb[i]) return va[i] < vb[i] ? -sign : sign;
    }
    return tieBreak(a, b);
  };
}

// The sort a click on `key`'s header leads to: high to low first, reversed by a second click.
export function nextSort(current: { sort: CappersSortKey; dir: SortDir }, key: CappersSortKey): { sort: CappersSortKey; dir: SortDir } {
  return { sort: key, dir: current.sort === key && current.dir === "desc" ? "asc" : "desc" };
}
