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

// Compact "<record> · <basis>" label for a bestAvailableRecord result - the
// same three-way fallback (league+category, then all-leagues category, then
// capper-wide last 20) Parlay A and its "next picks" rank by. Pure text, no
// React, so it's unit-testable without rendering: "68% (21–10) · MLB
// favorite moneyline" / "59% (44–31) · all leagues favorite moneyline" /
// "55% (11–9) · last 20, all markets". The LAST20 case never names a market -
// that record is the capper's most recent picks across every league and
// category (getCapperLeagueRecords.last20), never scoped to this pick's own
// market, so labeling it with one would misstate what it measures.
export function rankBasisLabel(record: RankRecord, opts: { leagueName: string; marketNoun: string }): string {
  const base = formatRecord(record);
  if (record.source === "LEAGUE") return `${base} · ${opts.leagueName} ${opts.marketNoun}`;
  if (record.source === "OVERALL") return `${base} · all leagues ${opts.marketNoun}`;
  return `${base} · last 20, all markets`;
}

// Compact "<record> · <basis>" label for a Hedge/Contrarian swap candidate's
// record. rankCandidates (qualification-ranking.ts) qualifies and ranks
// candidates ONLY on getCapperCategoryRecords - the all-leagues, category-
// scoped record - never league-scoped and never falling back to last 20 the
// way bestAvailableRecord does; an unqualified candidate is dropped outright,
// not backfilled with a weaker basis. So this label has exactly one form,
// always "all leagues <market>", making it explicitly NOT directly
// comparable to a Parlay A leg's rankBasisLabel when that leg's basis is
// LEAGUE-sourced (a league-specific record next to an all-leagues one look
// alike without this).
export function swapRecordLabel(record: { wins: number; losses: number; winPct: number }, marketNoun: string): string {
  return `${formatRecord(record)} · all leagues ${marketNoun}`;
}
