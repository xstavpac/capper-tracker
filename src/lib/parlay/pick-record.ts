// The one "how good is this capper at this pick" number the Parlay Generator
// ranks by - shared by the slip-pick ranking (generator.ts) and Auto-Generate
// (auto-generate.ts) so both rank a pick identically. It's the same record
// PickCard already shows for the pick (getCapperLeagueRecords): the capper's
// record in this bet category in this league, falling back to their
// all-time record in the category, then their last-20-picks record, in the
// same "best available" order the card itself falls back through.
//
// Pure and client-safe: type-only imports, and import-free modules
// (record-keys.ts, wilson-lower-bound.ts, generator-z.ts).
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";
import { propMarketKey, type PropMarketKey } from "@/lib/prop-market-key";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import { GENERATOR_Z } from "@/lib/parlay/generator-z";

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

// The record a generated leg (and a Hedge / Contrarian alternate, and a
// Consensus Hybrid supporter - consensus.ts) is gated and ranked on - the
// better of two: the capper's record in this bet category in
// THIS league, and their all-time record in the category (every league, every
// season). Each is scored with the generator's ordering score (Wilson lower
// bound at GENERATOR_Z) and the higher one is the record; a tie goes to the
// in-league one. So a tiny in-league record (1-2) no longer hides a strong
// all-time one (60-40), while a strong in-league one (8-0) still wins. The
// gate is then checked on the chosen record's plain win % only - never the
// other one. No minimum volume - a 1-0 record counts, it just scores low.
// Never last 20: that record is every market at once, so it can't say whether
// a capper is good at this bet. Unlike bestAvailableRecord, a record of pushes
// only doesn't count as a record.
//
// The all-time record is the card's overall column; `allTime` (the bundle's
// categoryRecords - the same numbers) covers a pick that has no card.
//
// A player prop with a market key (prop-market-key.ts - "NBA points", "NHL
// shots on goal") is gated on its per-market records instead (`propMarkets`,
// the snapshot's propMarketRecords): in-league, and all-time across the
// market's sport family, the same best-of-two. Never its category's: TD_PROP
// blends every prop market of every league into one record, so it can't say
// whether a capper is good at this one - no record on the market is no record.
// A prop with no key (no propMarket) and every game line keep the category path.
export type GateRecord = {
  wins: number;
  losses: number;
  winPct: number;
  n: number;
  source: "LEAGUE" | "OVERALL";
  // Set when the record is a per-market prop record: which market.
  propMarket?: PropMarketKey;
};

type Column = { wins: number; losses: number; winPct: number };
type GateInput = RecordInput & Pick<ExpanderPick, "betType" | "propMarket">;

function gateCandidates(
  pick: GateInput,
  records: CapperLeagueRecords,
  allTime: Record<string, CategoryBreakdownItem | null>,
  propMarkets: Record<string, PropMarketRecord | null>
): { league: GateRecord | null; overall: GateRecord | null } | null {
  const toRecord = (c: Column | null | undefined, source: GateRecord["source"], propMarket?: PropMarketKey): GateRecord | null =>
    c && c.wins + c.losses > 0 ? { wins: c.wins, losses: c.losses, winPct: c.winPct, n: c.wins + c.losses, source, ...(propMarket ? { propMarket } : {}) } : null;
  const key = propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });
  if (key) {
    const r = propMarkets[propMarketRecordKey(pick.capperId, pick.leagueName, key)] ?? null;
    return { league: toRecord(r?.league, "LEAGUE", key), overall: toRecord(r?.allTime, "OVERALL", key) };
  }
  if (!pick.category) return null;
  const card = records.records[leagueRecordKey(pick.capperId, pick.leagueName, pick.category)] ?? null;
  return {
    league: toRecord(card?.league, "LEAGUE"),
    overall: toRecord(card?.overall ?? allTime[categoryRecordKey(pick.capperId, pick.category)], "OVERALL"),
  };
}

export function recordForGate(
  pick: GateInput,
  records: CapperLeagueRecords,
  allTime: Record<string, CategoryBreakdownItem | null> = {},
  z: number = GENERATOR_Z,
  propMarkets: Record<string, PropMarketRecord | null> = {}
): GateRecord | null {
  const c = gateCandidates(pick, records, allTime, propMarkets);
  if (!c) return null;
  if (!c.league || !c.overall) return c.league ?? c.overall;
  return wilsonLowerBound(c.overall.wins, c.overall.losses, z) > wilsonLowerBound(c.league.wins, c.league.losses, z) ? c.overall : c.league;
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
