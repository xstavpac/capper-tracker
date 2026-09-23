// The one "how good is this capper at this pick" number the Parlay Generator
// ranks by - shared by My Picks (parlay-pool-section.tsx) and Auto-Generate
// (auto-generate.ts) so both rank a pick identically. It's the same record
// PickCard already shows for the pick (getCapperLeagueRecords): the capper's
// record in this bet category in this league, falling back to their
// all-time record in the category, then their last-20-picks record, in the
// same "best available" order the card itself falls back through.
//
// Pure and client-safe: type-only imports.
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

export type RankRecordSource = "LEAGUE" | "OVERALL" | "LAST20";

export type RankRecord = {
  wins: number;
  losses: number;
  winPct: number;
  n: number; // decided picks (wins + losses) - the tie-break sample size
  source: RankRecordSource;
};

type RecordInput = Pick<ExpanderPick, "capperId" | "leagueName" | "category">;

export function bestAvailableRecord(pick: RecordInput, records: CapperLeagueRecords): RankRecord | null {
  const key = pick.capperId + "|" + pick.leagueName + "|" + pick.category;
  const card = pick.category ? records.records[key] : null;
  const toRecord = (c: { wins: number; losses: number; winPct: number }, source: RankRecordSource): RankRecord => ({
    wins: c.wins,
    losses: c.losses,
    winPct: c.winPct,
    n: c.wins + c.losses,
    source,
  });
  if (card && card.league.count > 0) return toRecord(card.league, "LEAGUE");
  if (card && card.overall.count > 0) return toRecord(card.overall, "OVERALL");
  const last20 = records.last20[pick.capperId];
  if (last20 && last20.count > 0) return toRecord(last20, "LAST20");
  return null;
}

// "68% (21–10)" - the display form used next to every generated leg.
export function formatRecord(r: { wins: number; losses: number; winPct: number }): string {
  return `${Math.round(r.winPct)}% (${r.wins}–${r.losses})`;
}
