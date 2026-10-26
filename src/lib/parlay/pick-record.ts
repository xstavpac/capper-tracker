// The one "how good is this capper at this pick" number the Parlay Generator
// ranks by - shared by the slip-pick ranking (generator.ts) and Auto-Generate
// (auto-generate.ts) so both rank a pick identically. It's the same record
// PickCard already shows for the pick (getCapperLeagueRecords): the capper's
// record in this bet category in this league, falling back to their
// all-time record in the category, then their last-20-picks record, in the
// same "best available" order the card itself falls back through.
//
// Pure and client-safe: type-only imports, and record-keys.ts (import-free).
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { categoryRecordKey, leagueRecordKey } from "@/lib/record-keys";

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

// The record a generated leg (and a Hedge / Contrarian alternate) is gated and
// ranked on: the capper's record in this bet category in THIS league when they
// have any win or loss there, else their all-time record in the category
// (every league), else none. No minimum volume - a 1-0 record counts. Never
// last 20: that record is every market at once, so it can't say whether a
// capper is good at this bet. Unlike bestAvailableRecord, a league record of
// pushes only doesn't count as a record.
//
// The all-time record is the card's overall column; `allTime` (the bundle's
// categoryRecords - the same numbers) covers a pick that has no card.
export type GateRecord = {
  wins: number;
  losses: number;
  winPct: number;
  n: number;
  source: "LEAGUE" | "OVERALL";
};

export function recordForGate(
  pick: RecordInput,
  records: CapperLeagueRecords,
  allTime: Record<string, CategoryBreakdownItem | null> = {}
): GateRecord | null {
  if (!pick.category) return null;
  const card = records.records[leagueRecordKey(pick.capperId, pick.leagueName, pick.category)] ?? null;
  const toRecord = (c: { wins: number; losses: number; winPct: number }, source: GateRecord["source"]): GateRecord => ({
    wins: c.wins,
    losses: c.losses,
    winPct: c.winPct,
    n: c.wins + c.losses,
    source,
  });
  if (card && card.league.wins + card.league.losses > 0) return toRecord(card.league, "LEAGUE");
  const overall = card?.overall ?? allTime[categoryRecordKey(pick.capperId, pick.category)] ?? null;
  if (overall && overall.wins + overall.losses > 0) return toRecord(overall, "OVERALL");
  return null;
}

// The Parlay Generator's one ordering: win% desc, then more graded picks,
// then pick id - so equal records never fall back to whatever order the
// picks happened to arrive in. A pick with no record at all ranks below
// every pick that has one - it still shows, it just can't outrank a real
// record.
export function compareByRecord(
  a: { pickId: string; record: RankRecord | null },
  b: { pickId: string; record: RankRecord | null }
): number {
  if (a.record && !b.record) return -1;
  if (!a.record && b.record) return 1;
  if (a.record && b.record) {
    if (b.record.winPct !== a.record.winPct) return b.record.winPct - a.record.winPct;
    if (b.record.n !== a.record.n) return b.record.n - a.record.n;
  }
  return a.pickId < b.pickId ? -1 : a.pickId > b.pickId ? 1 : 0;
}

// The slip's picks, best first - what My Picks and the pool's Auto Hedge /
// Contrarian both build their primary legs from, so the two always agree.
export function rankPoolPicks<T extends RecordInput & { pickId: string }>(picks: T[], records: CapperLeagueRecords): T[] {
  return picks
    .map((pick) => ({ pick, pickId: pick.pickId, record: bestAvailableRecord(pick, records) }))
    .sort(compareByRecord)
    .map((r) => r.pick);
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
