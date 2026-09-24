// American odds are never 0 (risk $X to win $0 is meaningless) - shared by
// every path that can persist a Pick.odds value, so a stray 0 is rejected the
// same way everywhere: manual entry (createPickAction in
// server/actions/picks.ts) and bulk/catalog import (bulkImportPicksAction in
// server/actions/bulk-picks.ts). One function, re-read wherever the rule is
// needed, rather than two copies of the same `=== 0` check drifting apart.
export function isInvalidOdds(odds: number): boolean {
  return odds === 0;
}
