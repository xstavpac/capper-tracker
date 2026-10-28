// The keys the capper record maps are indexed by (getCapperRecordBundle in
// server/data/picks.ts builds them, every reader looks records up with them).
// Client-safe - no imports - so the Parlay Generator's engine can look records
// up in the browser. server/data/picks.ts re-exports both.
import type { PickCategoryKey } from "@/server/data/stats";
import type { PropMarketKey } from "@/lib/prop-market-key";

export function categoryRecordKey(capperId: string, category: PickCategoryKey): string {
  return capperId + "|" + category;
}

export function leagueRecordKey(capperId: string, leagueSport: string, category: PickCategoryKey): string {
  return capperId + "|" + leagueSport + "|" + category;
}

// A capper's per-market prop record (getCapperPropMarketRecords): its in-league
// column is `leagueSport`'s, its all-time column the key's whole sport family.
export function propMarketRecordKey(capperId: string, leagueSport: string, key: PropMarketKey): string {
  return capperId + "|" + leagueSport + "|" + key;
}
