// The Parlay Generator's one engine: your slip picks, plus the best legs from
// the games you targeted (or the full slate), as one parlay with its Hedge and
// Contrarian. Replaces Auto-Generate's Parlay A + alternates and the slip's
// "Build from slip"; nothing here reads the database.
//
// It runs over a SNAPSHOT - the pool of games and picks plus both record maps,
// loaded once by the server action. Generate, Regenerate, Hedge and Contrarian
// all run on the same snapshot: Regenerate is this function again with a new
// seed and history, never a new fetch (snapshotIsStale says when a refetch is
// due instead).
//
// Rules, in order:
//   1. Slip picks are always in the parlay, whatever the filters or the leg
//      count. Two slip picks that can't both be legs (opposing, or the same bet,
//      at any line - blocks(), build-my-picks.ts) compete: the better record
//      stays, then the better line. The other is listed in `dropped`. A slip
//      pick whose game is over is dropped too (a live game's picks stay). When "max legs per game" is
//      lower than the picks you chose on one game, the best of them (the same
//      ranking) stay and the rest are listed in `dropped` as left out, with
//      why - they stay in your slip, they are only not used in this parlay.
//   2. Targets: with any, generated legs come only from the targeted games
//      plus the games of your picks. Without, from every game in the snapshot.
//   3. SCORING (GENERATOR_RULES): a generated leg and a Hedge alternate are
//      gated and ranked by lib/parlay/scoring.ts, and slip picks are ranked by
//      it. Which gated legs are taken is lib/parlay/selection.ts, reading the
//      edge (rankScore, in points) directly. The record a leg shows is still
//      recordForGate's. Contrarian keeps Wilson and the raw gate. The rest of
//      this rule is WILSON_RULES, and Contrarian under either:
//      a generated leg must clear the 55% gate (qualifies, qualification-
//      core.ts) on its capper's record for this bet: the better of their
//      record in its market in its league and their all-time record in the
//      market, by Wilson lower bound at the rules' z (a tie goes to the
//      league; recordForGate, pick-record.ts) - the same record Hedge and
//      Contrarian gate and rank on. It must also
//      pass the Include Picks filter (include-picks.ts: All Picks, or any of
//      Moneyline / Spread / Totals / Props - betCategory, period ignored).
//      Slip picks are never gated or filtered. No minimum sample: candidates
//      are ranked by Wilson lower bound (compareByWilson) at the generator's
//      own, softer z (GENERATOR_Z - the shared default, 1.96, is what the
//      Live category panel uses and stays there): a small sample still ranks
//      below a large one at the same win %, but a mid-volume record (18-4) is
//      no longer buried under a huge one (100-30). Every leg carries its
//      record and which one it is (basis) so the sample size shows. Last 20
//      is never a gate or a rank. LEGACY_RULES is the engine as it was before
//      (all-leagues market record, z=1.96, Contrarian headcount), for
//      comparison.
//   4. One generated leg per game first, best games first. Only when games run
//      out are same-game legs added, up to "max legs per game" counted with any
//      slip picks on that game - across every category and every period (a
//      1H / F5 / quarter pick is on its game's board card, so it counts toward
//      that game). A generated leg never breaks a same-game rule
//      (same-game-rules.ts) against any leg on its game - not opposing, not a
//      duplicate at any line, not a second side or game total.
//   5. A Pick Mix (two or more categories selected) splits the whole parlay
//      between them by share, scaled to the leg count by largest remainder.
//      The slip's own legs count toward their category's share, the generated
//      legs fill what is left of each, then any shortfall from the other
//      selected categories by normal ranking - a mix never shortens a parlay
//      and never beats max legs per game or a same-game rule. A category that
//      came up short is said (mixNotes). An unclassified pick (All Picks only)
//      counts toward no share.
//   6. Fill from = Your picks only with more usable slip picks than the leg
//      count (more than rule 1 would put in): the parlay is the leg count of
//      them, not all of them. Every slip pick whose game isn't over is a
//      candidate - two that can't both be legs (blocks(), as in rule 1) are
//      either/or, so both sides of an opposing pair can appear across builds -
//      and max legs per game holds. Generate takes the strongest; Regenerate
//      draws (selection.ts) and never repeats a combination already shown on
//      the result card - "No other parlays" only when every valid combination
//      has been shown. The picks not used are listed in `dropped` as
//      not_selected. Pick Mix and Include Picks never shape this mode: slip
//      picks are never filtered. With no more usable picks than the leg count,
//      rule 1 holds unchanged: every one is in.
//
// Generate (no `variation`) is deterministic: the same snapshot and settings
// always give the same parlay. Regenerate (`variation`) gives another parlay:
// under GENERATOR_RULES a weighted draw without replacement, weight
// exp(beta x edge) x a reuse penalty for recently shown legs, beta from the
// selection mode (selection.ts); the same constraints hold in every draw. Nothing
// outside the gate is ever drawn. Slip picks and targets are the same in every
// build. WILSON_RULES / LEGACY_RULES keep the old Wilson bands and draws
// (rollback only).
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { PropMarketKey } from "@/lib/prop-market-key";
import { categoryRecordKey } from "@/lib/record-keys";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { GeneratorGame, GeneratorPick, SwapMode } from "@/lib/parlay/auto-generate";
import { bestAvailableRecord, rankPoolPicks, recordForGate, type RankRecordSource } from "@/lib/parlay/pick-record";
import { compareScores, EMPTY_PLATFORM_RATES, passesGate, scorePick, type PickScore, type PlatformRates } from "@/lib/parlay/scoring";
import {
  betKeyOf,
  DEFAULT_SELECTION_MODE,
  deriveSeed,
  enumerateCombos,
  fillLegs,
  legTrace,
  orderCandidates,
  SELECTION_BETA,
  seededRng as selectionRng,
  selectLegs,
  STANDARD_DRAW_TRIES,
  SUBSET_DRAW_TRIES,
  type FillRules,
  type Ranked,
  type RecentLeg,
  type SelectionCandidate,
  type SelectionLegTrace,
  type SelectionMode,
  type SelectionTrace,
} from "@/lib/parlay/selection";
import {
  compareByWilson,
  contrarianHeadcountPasses,
  qualifies,
  rankCandidatesBy,
  rankCandidatesByRecord,
  rankCandidatesByScore,
  toParlayCandidate,
  toParlayLeg,
  wilsonLowerBound,
} from "@/lib/parlay/qualification-core";
import { GATE_DEFAULT, normalizeMinWinPct } from "@/lib/parlay/gate";
import { GENERATOR_Z } from "@/lib/parlay/generator-z";
import { inSwapScope, SWAP_SCOPES, type SwapScope } from "@/lib/parlay/swap-scope";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { blocks, selectConflictFreeLegs } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { betCategory, type BetCategoryResult } from "@/lib/parlay/bet-category";
import {
  keepsPick,
  mixCounts,
  mixShortNote,
  selectedCategories,
  toIncludeSelection,
  toPickMix,
  type IncludeSelection,
  type PickMix,
} from "@/lib/parlay/include-picks";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { legSetKey } from "@/lib/parlay/parlay-set";
import { hasKickedOff, isGameOver, type GameClock } from "@/lib/parlay/game-over";
import type { Rule } from "@/lib/parlay/relationship-classifier";
import type { SwapLegTrace, TraceCollector } from "@/lib/parlay/run-trace";
import { conflictSub, noRecordReason, pickRef, traceScoring, traceSelection, traceSlip, traceSwapLeg } from "@/lib/parlay/generator-trace";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export type FillFrom = "BEST_AVAILABLE" | "YOUR_PICKS_ONLY";

export type GeneratorSnapshot = {
  // When the pool was read, for snapshotIsStale.
  builtAt: string;
  // Every game generated legs may come from: the in-scope leagues' unstarted
  // games, the targeted games, and the games of the slip's picks (a targeted
  // or slip game may be live). Pending picks only.
  games: GeneratorGame[];
  // The slip's picks, read server-side.
  slipPicks: GeneratorPick[];
  // Targeted game ids. A target missing from `games` (over, or off the
  // board) is reported in `unavailableTargets`.
  targets: string[];
  // Every slip pick's and candidate's card (in-league and all-time market
  // records): what slip picks show (bestAvailableRecord) and what candidates
  // are gated and ranked on (recordForGate).
  leagueRecords: CapperLeagueRecords;
  // Every candidate's all-leagues market record: recordForGate's all-time
  // record when a pick has no card, and LEGACY_RULES' gate.
  categoryRecords: Record<string, CategoryBreakdownItem | null>;
  // Every candidate player prop's per-market record (propMarketRecordKey):
  // what recordForGate gates and ranks a prop with a market key on, in place
  // of its category's. Optional: a snapshot built before it existed has none,
  // and its props then have no record.
  propMarketRecords?: Record<string, PropMarketRecord | null>;
  // The platform totals scoring falls back on, trimmed to this snapshot's picks,
  // and how many rows the whole table had (0: empty, every pick scored on the
  // defaults). Absent from a snapshot built for Consensus Hybrid.
  platformRates?: PlatformRates;
  platformRateRows?: number;
};

// Which record gates and ranks a generated leg and a Hedge / Contrarian
// alternate, how hard a small sample is marked down, how close counts as a
// tie for Regenerate, and whether Contrarian needs your pick's side to be the
// majority.
export type GeneratorRules = {
  // SCORING: lib/parlay/scoring.ts gates and ranks generated legs and Hedge, and
  // ranks slip picks. WILSON: recordScope's record, the raw gate, Wilson.
  // Contrarian is WILSON under both.
  scorer: "SCORING" | "WILSON";
  // LEAGUE_FIRST: recordForGate. ALL_TIME: the all-leagues market record.
  recordScope: "LEAGUE_FIRST" | "ALL_TIME";
  contrarianHeadcount: boolean;
  // Wilson lower bound's z for the ranking (never the gate).
  z: number;
  // Regenerate's bands, in Wilson points at this z (PICK_TIE_BAND, GAME_BAND).
  // Read only under WILSON: SCORING selects through selection.ts.
  pickTieBand: number;
  gameBand: number;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// The generator's Wilson z (generator-z.ts): 1.5, softer than the shared 1.96.
export { GENERATOR_Z };
// Picks within this many Wilson points (at GENERATOR_Z) of their game's best
// are interchangeable.
export const PICK_TIE_BAND = 0.035;
// Games whose best leg is within this of the last game that makes the cut can
// rotate in. Both bands were 0.03 / 0.05 at z=1.96; at GENERATOR_Z they cover
// the same share of near-ties in the snapshot replay (13.9% of same-game
// pairs, 29.8% of games past the cut - parlay-generator-replay.ts).
export const GAME_BAND = 0.055;

export const GENERATOR_RULES: GeneratorRules = { scorer: "SCORING", recordScope: "LEAGUE_FIRST", contrarianHeadcount: false, z: GENERATOR_Z, pickTieBand: PICK_TIE_BAND, gameBand: GAME_BAND };
// The engine before scoring.ts: best-of-two, the raw gate, Wilson.
export const WILSON_RULES: GeneratorRules = { ...GENERATOR_RULES, scorer: "WILSON" };
// The engine before record scope changed: all-leagues market record, Wilson at
// z=1.96 with its bands, the 55% gate, Contrarian only from the majority side.
export const LEGACY_RULES: GeneratorRules = { scorer: "WILSON", recordScope: "ALL_TIME", contrarianHeadcount: true, z: 1.96, pickTieBand: 0.03, gameBand: 0.05 };

export type GeneratorSettings = {
  legCount: number;
  maxLegsPerGame: number;
  include: IncludeSelection;
  // A Pick Mix's share per selected category, or null. Read only with two or
  // more categories selected.
  mix: PickMix | null;
  fillFrom: FillFrom;
  // The win-rate gate (lib/parlay/gate.ts), 55 by default. Absent or invalid
  // is 55; LEGACY_RULES ignores it.
  minWinPct?: number;
};

// A Regenerate: the seed to draw with, and the generated legs (pick ids) of
// the parlays already shown, newest first. Under GENERATOR_RULES also:
//   mode       - Best / Diversified / Explore (selection.ts), Diversified when absent;
//   recentLegs - legs to weigh down (betKey + when shown), none when absent;
//   shown      - every combination (legSetKey) shown on this result card, which
//                Your picks only never repeats; `history`'s when absent.
//   enumerationBudget - tests only: a smaller node / time budget for Your picks only's enumeration.
export type Variation = {
  seed: number;
  history: string[][];
  mode?: SelectionMode;
  recentLegs?: RecentLeg[];
  shown?: string[];
  enumerationBudget?: { nodes?: number; ms?: number };
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type LegRecord = { wins: number; losses: number; n: number; winPct: number };

export type EngineLeg = {
  pick: GeneratorPick;
  gameId: string;
  gameLabel: string;
  gameTime: string;
  source: "SLIP" | "GENERATED";
  // A slip pick: the record its card shows (bestAvailableRecord, `basis` says
  // which). A generated leg: the record it was gated and ranked on - LEAGUE or
  // OVERALL (recordForGate), MARKET under LEGACY_RULES.
  record: LegRecord | null;
  basis: RankRecordSource | "MARKET" | null;
  // Generated legs only.
  wilsonLowerBound: number | null;
  // A generated leg under SCORING: its edge in percentage points (rankScore x 100),
  // what selection orders and weighs it by.
  score?: number;
  // True when its game has another leg in this parlay (an SGP).
  sameGame: boolean;
  // A generated player prop gated on its per-market record (recordForGate):
  // which market, so the record is labelled with it. Absent otherwise.
  propMarket?: PropMarketKey;
};

export type DroppedSlipPick = {
  pickId: string;
  label: string;
  // not_selected: Your picks only with more picks than legs (rule 6) - not
  // drawn into this parlay; another build may use it.
  reason: "duplicate" | "opposes" | "over" | "left_out" | "not_selected";
  // The slip pick that stayed (duplicate / opposes / left out).
  against: { pickId: string; label: string } | null;
  // "duplicates Capper — Over 53.5 — not used"
  note: string;
};

export type EngineSwapLeg = {
  original: EngineLeg;
  swap: {
    pick: GeneratorPick;
    rule: Rule;
    record: LegRecord;
    wilsonLowerBound: number;
    // Which record it was gated on (recordForGate). Absent under LEGACY_RULES:
    // the all-leagues market record.
    basis?: "LEAGUE" | "OVERALL";
    // As EngineLeg.propMarket.
    propMarket?: PropMarketKey;
  } | null;
  // OUT_OF_SCOPE: the Swap setting leaves this leg alone (a slip pick under
  // Suggested, a generated leg under Your picks). NOT_MAJORITY: LEGACY_RULES only.
  unchangedReason: "OUT_OF_SCOPE" | "NO_ALTERNATE" | "NOT_MAJORITY" | null;
};

export type EngineSwap = { mode: SwapMode; legs: EngineSwapLeg[]; swapCount: number };

export type GeneratedParlay = {
  // Grouped by game (earliest first), slip picks first within a game.
  legs: EngineLeg[];
  // The leg count asked for - or the slip's size, when the slip alone is more
  // (never under Your picks only, rule 6: it is the leg count).
  requested: number;
  fromSlip: number;
  // Slip picks whose game isn't over, and how many of them are in this parlay
  // (fromSlip) - "7 of your 20 picks used". The most legs they can make is
  // `capacity` under Your picks only.
  slipTotal: number;
  slipUsed: number;
  generated: number;
  gamesUsed: number;
  // Games with two or more legs.
  sameGameGames: number;
  // The most legs this snapshot can supply with these settings (an upper
  // bound: same-game rules can still leave it short), and why.
  capacity: number;
  capacityText: string;
  // Why the parlay is short of `requested` - empty when it isn't - and, with
  // targets, every targeted game that had nothing to give.
  shortfall: string[];
  // Best available came up short of Total legs because too few legs clear the bar (gate, Bet Types, Max legs per game); null otherwise.
  // Display only: the gate is never lowered to fill the parlay.
  limited: { have: number; need: number } | null;
  // Each Pick Mix category that couldn't fill its share (the other selected
  // categories made up the rest).
  mixNotes: string[];
  // Targeted game ids that are not in the snapshot (over or off the board).
  unavailableTargets: string[];
  dropped: DroppedSlipPick[];
  // Hedge and Contrarian for each Swap setting (swap-scope.ts), all built with
  // the parlay so switching the setting is never a rebuild: the Primary - and
  // a Regenerate's draw - stays exactly as shown.
  hedge: Record<SwapScope, EngineSwap>;
  contrarian: Record<SwapScope, EngineSwap>;
  // BEST: Generate's parlay. VARIED: a Regenerate that differs from the parlays
  // in its history. NO_ALTERNATIVE: a Regenerate that found nothing else of
  // comparable strength (its legs are Generate's; the UI keeps what it shows
  // and says so).
  variety: "BEST" | "VARIED" | "NO_ALTERNATIVE";
  // Why a NO_ALTERNATIVE: ALL_PICKS_USED - nothing could vary, every usable
  // slip pick is already in and no leg is generated; NO_COMPARABLE - the
  // draws found nothing new of comparable strength. Null otherwise.
  noAlternativeReason: "ALL_PICKS_USED" | "NO_COMPARABLE" | null;
  // The legs a Regenerate varies - the generated legs, or the slip picks drawn
  // under rule 6 - which the client adds to its history, and their legSetKey.
  historyIds: string[];
  generatedKey: string;
  // The same legs' betKeys (selection.ts): what the next Regenerate weighs down.
  // GENERATOR_RULES only (absent under WILSON_RULES, whose output stays as it was).
  historyBetKeys?: string[];
};

// How many recent parlays' legs weigh less, and by how much (WILSON_RULES; under
// GENERATOR_RULES the session passes those legs as Variation.recentLegs).
export const RECENT_PARLAYS = 3;
export const RECENT_WEIGHT = 0.35;
// Draws a Regenerate tries before settling for one that only differs from the last parlay.
const VARIATION_TRIES = 12;
// WILSON_RULES only (rollback; PR 9 removes it, with the bands and varyDraw).
// Rule 6's draw weight is Wilson lower bound to this power: Wilson alone barely
// separates a 70% record from a 55% one (0.627 vs 0.475 at 100 picks), so a
// subset would be close to uniform. At 8 the 70% pick weighs ~9x the 55% one,
// and 20 Regenerates of 7 from 20 picks still give 20 different parlays with
// every pick appearing; from 12 up one side of an opposing pair stops
// appearing, from 15 up taps repeat (generator-subset-acceptance-test.ts).
export const SUBSET_SHARPEN = 8;
// A snapshot older than this is reloaded before the next build.
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;

// Reload when the pool is old, a game in it is over, or a game the full slate
// drew from has kicked off (a live game stays in only as a target or a slip
// pick's game).
export function snapshotIsStale(snapshot: Pick<GeneratorSnapshot, "builtAt" | "games" | "slipPicks" | "targets">, now: Date): boolean {
  if (now.getTime() - new Date(snapshot.builtAt).getTime() > SNAPSHOT_MAX_AGE_MS) return true;
  const kept = new Set([...snapshot.targets, ...snapshot.slipPicks.map((p) => p.gameId)]);
  return (
    snapshot.games.some((g) => isGameOver(g, now) || (hasKickedOff(g.gameTime, now) && !kept.has(g.gameId))) ||
    snapshot.slipPicks.some((p) => isGameOver(p, now))
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
type Rng = () => number;

// mulberry32: small, seedable, good enough to shuffle a slate.
function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted order without replacement (Efraimidis-Spirakis keys).
function weightedOrder<T>(items: T[], weight: (t: T) => number, rng: Rng): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(Math.max(rng(), 1e-12), 1 / Math.max(weight(item), 1e-6)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

type Candidate = {
  pick: GeneratorPick;
  game: GeneratorGame;
  record: LegRecord;
  basis: "LEAGUE" | "OVERALL" | "MARKET";
  propMarket?: PropMarketKey;
  wilsonLowerBound: number;
  // What selection reads: the edge in points (rankScore x 100) under SCORING, else Wilson.
  score: number;
  // SCORING only.
  pickScore: PickScore | null;
  category: BetCategoryResult;
};

const byRank = (a: Candidate, b: Candidate) =>
  a.pickScore && b.pickScore
    ? compareScores(a.pickScore, b.pickScore)
    : compareByWilson({ pickId: a.pick.pickId, wilsonLowerBound: a.wilsonLowerBound, record: a.record }, { pickId: b.pick.pickId, wilsonLowerBound: b.wilsonLowerBound, record: b.record });

// One score per pick per build. The gate and the fallback rates come from this build.
function scorerFor(snapshot: GeneratorSnapshot, gate: number): (pick: GeneratorPick) => PickScore {
  const ctx = {
    leagueRecords: snapshot.leagueRecords,
    categoryRecords: snapshot.categoryRecords,
    propMarketRecords: snapshot.propMarketRecords,
    platformRates: snapshot.platformRates ?? EMPTY_PLATFORM_RATES,
    minWinPct: gate,
  };
  const scores = new Map<string, PickScore>();
  return (pick) => {
    let s = scores.get(pick.pickId);
    if (!s) scores.set(pick.pickId, (s = scorePick(pick, ctx)));
    return s;
  };
}

// The slip's picks, best first: by score, then picks with no record in their old
// order (bestAvailableRecord can still read them a last-20 record).
function rankSlip(picks: GeneratorPick[], records: CapperLeagueRecords, scoreOf: ((p: GeneratorPick) => PickScore) | null): GeneratorPick[] {
  const ranked = rankPoolPicks(picks, records);
  if (!scoreOf) return ranked;
  const scored = ranked.filter((p) => scoreOf(p).status === "SCORED").sort((a, b) => compareScores(scoreOf(a), scoreOf(b)));
  return [...scored, ...ranked.filter((p) => scoreOf(p).status !== "SCORED")];
}

// A slip pick for the conflict walk: under SCORING two picks count as equal for
// "the better line takes over" when their scores are.
function slipBuildCandidate(p: GeneratorPick, records: CapperLeagueRecords, scoreOf: ((p: GeneratorPick) => PickScore) | null) {
  const c = toBuildCandidate(p, records);
  const s = scoreOf?.(p);
  return s?.status === "SCORED" ? { ...c, standing: { winPct: s.rankScore * 100, n: s.decided } } : c;
}

const asCandidate = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
const pickLabel = (p: GeneratorPick) => `${p.capperName} — ${p.betDetail}`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// A doubleheader's board can't tell which game a pick with no game number is
// on, so two legs are only paired on such a game when both say (sureOfGame in
// auto-generate.ts).
const sureOfGame = (game: GeneratorGame | undefined, pick: GeneratorPick) => !game?.doubleheader || pick.gameNumber != null;

function marketRecord(pick: GeneratorPick, records: Record<string, CategoryBreakdownItem | null>): CategoryBreakdownItem | null {
  return pick.category ? (records[categoryRecordKey(pick.capperId, pick.category)] ?? null) : null;
}

// The record a candidate is gated and ranked on, and which one it is.
function gateRecord(
  pick: GeneratorPick,
  snapshot: GeneratorSnapshot,
  rules: GeneratorRules
): { record: { wins: number; losses: number; winPct: number }; basis: Candidate["basis"]; propMarket?: PropMarketKey } | null {
  if (rules.recordScope === "ALL_TIME") {
    const record = marketRecord(pick, snapshot.categoryRecords);
    return record ? { record, basis: "MARKET" } : null;
  }
  const record = recordForGate(pick, snapshot.leagueRecords, snapshot.categoryRecords, rules.z, snapshot.propMarketRecords);
  return record ? { record, basis: record.source, ...(record.propMarket ? { propMarket: record.propMarket } : {}) } : null;
}

// The gate a build applies: the setting, or 55 under LEGACY_RULES (which is the
// engine as it was, whatever the setting says).
function effectiveGate(settings: GeneratorSettings, rules: GeneratorRules): number {
  return rules.recordScope === "ALL_TIME" ? GATE_DEFAULT : normalizeMinWinPct(settings.minWinPct ?? GATE_DEFAULT);
}

const toLegRecord = (r: { wins: number; losses: number; winPct: number }): LegRecord => ({ wins: r.wins, losses: r.losses, n: r.wins + r.losses, winPct: r.winPct });

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------
export function buildGeneratedParlay(
  snapshot: GeneratorSnapshot,
  settings: GeneratorSettings,
  variation: Variation | null,
  now: Date,
  rules: GeneratorRules = GENERATOR_RULES,
  // Diagnostics only (run-trace.ts): written to, never read from - the parlay is the same with or without one.
  trace?: TraceCollector
): GeneratedParlay {
  const gate = effectiveGate(settings, rules);
  const scoreOf = rules.scorer === "SCORING" ? scorerFor(snapshot, gate) : null;
  // A trace step that throws (even while building its arguments) is reported on the trace, never into the build.
  const traced = (fn: (t: TraceCollector) => void): void => {
    if (!trace) return;
    try {
      fn(trace);
    } catch (err) {
      trace.error("TRACE_ERROR", err, "engine");
    }
  };
  const over = (g: GameClock) => isGameOver(g, now);
  const include = toIncludeSelection(settings.include);
  const categories = selectedCategories(include);
  const mix = toPickMix(settings.mix, categories);
  const maxPerGame = Math.min(MAX_LEGS_PER_GAME, Math.max(1, Math.floor(settings.maxLegsPerGame) || 1));
  const legCount = Math.min(MAX_PARLAY_LEGS, Math.max(1, Math.floor(settings.legCount) || 1));

  // ---- 1. Slip picks ------------------------------------------------------
  const dropped: DroppedSlipPick[] = [];
  const liveSlip: GeneratorPick[] = [];
  for (const p of snapshot.slipPicks) {
    if (over(p)) dropped.push({ pickId: p.pickId, label: pickLabel(p), reason: "over", against: null, note: "game over — not used" });
    else liveSlip.push(p);
  }
  const slipById = new Map(liveSlip.map((p) => [p.pickId, p]));
  const settled = selectConflictFreeLegs(
    rankSlip(liveSlip, snapshot.leagueRecords, scoreOf).map((p) => slipBuildCandidate(p, snapshot.leagueRecords, scoreOf)),
    Number.POSITIVE_INFINITY
  );
  for (const s of settled.skipped) {
    const reason = s.reason === "duplicate" ? "duplicate" : "opposes";
    dropped.push({
      pickId: s.pickId,
      label: s.label,
      reason,
      against: s.conflictsWith,
      note: `${reason === "duplicate" ? "duplicates" : "opposes"} ${s.conflictsWith.label} — not used`,
    });
  }
  // Max legs per game applies to the slip's own picks too: of the picks chosen
  // on one game, the best (settled.legs is already best first) stay and the
  // rest are named as left out. Nothing leaves the slip itself.
  const allInLegs: GeneratorPick[] = [];
  const keptOnGame = new Map<string, GeneratorPick[]>();
  for (const c of settled.legs) {
    const p = slipById.get(c.pickId)!;
    const kept = keptOnGame.get(p.gameId) ?? [];
    if (kept.length >= maxPerGame) {
      dropped.push({
        pickId: p.pickId,
        label: pickLabel(p),
        reason: "left_out",
        against: { pickId: kept[0].pickId, label: pickLabel(kept[0]) },
        note: `left out — max legs per game is ${maxPerGame}; ${kept.map(pickLabel).join(", ")} rank${kept.length === 1 ? "s" : ""} higher on this game — not used`,
      });
      continue;
    }
    keptOnGame.set(p.gameId, [...kept, p]);
    allInLegs.push(p);
  }

  // ---- 1b. Your picks only, more picks than legs (rule 6) -------------------
  // allInLegs is every slip pick that fits one parlay; when that is more than
  // the leg count, the leg count of them are drawn instead, and every live
  // slip pick not drawn is not_selected (the conflicts and per-game cap above
  // are only either/or here, not a loss).
  const subset = settings.fillFrom === "YOUR_PICKS_ONLY" && allInLegs.length > legCount;
  let slipLegs = allInLegs;
  let subsetVariety: GeneratedParlay["variety"] = "BEST";
  // Under SCORING: what selection did, for the run log (filled in below).
  let selectionTrace: SelectionTrace | null = null;
  const mode: SelectionMode = variation?.mode ?? DEFAULT_SELECTION_MODE;
  const beta = SELECTION_BETA[mode];
  const recentLegs = variation?.recentLegs ?? [];
  const shownKeys = new Set(variation ? (variation.shown ?? variation.history.map((ids) => legSetKey(ids))) : []);
  const onScreen = variation && variation.history.length > 0 ? legSetKey(variation.history[0]) : null;
  const drawAt = (i: number) => ({ rng: selectionRng(deriveSeed(variation!.seed, i)), beta, recentLegs, now: now.getTime() });
  const baseTrace = (): SelectionTrace => ({
    trigger: variation ? "REGENERATE" : "GENERATE",
    mode: variation ? mode : null,
    beta: variation ? beta : null,
    seed: variation ? variation.seed : null,
    legs: [],
    reuseHits: 0,
  });
  const finishTrace = (tr: SelectionTrace, picked: Ranked<unknown>[]) => {
    tr.legs = picked.map(legTrace);
    tr.reuseHits = picked.filter((r) => r.reuse < 1).length;
    return tr;
  };
  if (subset) {
    // Two slip picks that can't both be legs, worked out once (only picks on
    // one game ever block each other).
    const buildOf = new Map(liveSlip.map((p) => [p.pickId, toBuildCandidate(p, snapshot.leagueRecords)]));
    const blocked = new Set<string>();
    for (const a of liveSlip)
      for (const b of liveSlip)
        if (a !== b && a.gameId === b.gameId && blocks(buildOf.get(a.pickId)!, buildOf.get(b.pickId)!).blocked) blocked.add(a.pickId + "|" + b.pickId);
    if (scoreOf) {
      const v = subsetSelection(liveSlip, scoreOf, blocked, legCount, maxPerGame, variation, shownKeys, onScreen, drawAt);
      slipLegs = v.chosen.map((r) => r.item);
      subsetVariety = v.variety;
      selectionTrace = finishTrace({ ...baseTrace(), ...v.trace }, v.chosen);
    } else {
    const options = liveSlip
      .map((pick) => {
        const r = bestAvailableRecord(pick, snapshot.leagueRecords);
        const wilson = r ? wilsonLowerBound(r.wins, r.losses, rules.z) : 0;
        return { pick, build: buildOf.get(pick.pickId)!, wilsonLowerBound: wilson, score: wilson, record: { n: r?.n ?? 0 } };
      });
    options.sort((a, b) => compareByWilson({ pickId: a.pick.pickId, ...a }, { pickId: b.pick.pickId, ...b }));
    const draw = (rng: Rng | null, recent: ReadonlySet<string>): GeneratorPick[] => {
      const order = rng
        ? weightedOrder(options, (o) => Math.pow(o.score, SUBSET_SHARPEN) * (recent.has(o.pick.pickId) ? RECENT_WEIGHT : 1), rng)
        : options;
      const taken: GeneratorPick[] = [];
      for (const { pick } of order) {
        if (taken.length >= legCount) break;
        const onGame = taken.filter((t) => t.gameId === pick.gameId);
        if (onGame.length >= maxPerGame || onGame.some((t) => blocked.has(pick.pickId + "|" + t.pickId))) continue;
        taken.push(pick);
      }
      return taken;
    };
    const pickIdsKey = (ps: GeneratorPick[]) => legSetKey(ps.map((p) => p.pickId));
    if (!variation) slipLegs = draw(null, new Set());
    else {
      const v = varyDraw(variation, draw, pickIdsKey, () => draw(null, new Set()));
      slipLegs = v.chosen;
      subsetVariety = v.varied ? "VARIED" : "NO_ALTERNATIVE";
    }
    }
    const used = new Set(slipLegs.map((p) => p.pickId));
    dropped.splice(0, dropped.length, ...dropped.filter((d) => d.reason === "over"));
    for (const p of liveSlip) {
      if (used.has(p.pickId)) continue;
      dropped.push({ pickId: p.pickId, label: pickLabel(p), reason: "not_selected", against: null, note: `not in this parlay — Total legs is ${legCount}` });
    }
  }
  const target = Math.max(legCount, slipLegs.length);
  const fillFrom: FillFrom = slipLegs.length === 0 ? "BEST_AVAILABLE" : settings.fillFrom;

  // ---- 2. Games -----------------------------------------------------------
  const allSlipIds = new Set(snapshot.slipPicks.map((p) => p.pickId));
  const gameById = new Map(snapshot.games.filter((g) => !over(g)).map((g) => [g.gameId, g]));
  const slipGameIds = new Set(slipLegs.map((p) => p.gameId));
  const targeted = snapshot.targets.length > 0;
  const unavailableTargets = targeted ? snapshot.targets.filter((id) => !gameById.has(id)) : [];
  const eligible: GeneratorGame[] = targeted
    ? Array.from(new Set([...snapshot.targets, ...slipGameIds]))
        .map((id) => gameById.get(id))
        .filter((g): g is GeneratorGame => g !== undefined)
    : Array.from(gameById.values());

  // ---- 3. Candidates: gated, filtered, ranked ------------------------------
  const slipOnGame = new Map<string, GeneratorPick[]>();
  for (const p of slipLegs) slipOnGame.set(p.gameId, [...(slipOnGame.get(p.gameId) ?? []), p]);
  const candidatesOf = new Map<string, Candidate[]>();
  // How many picks passed each step, for the run trace.
  const passed = { scope: 0, notSlip: 0, included: 0, record: 0, gate: 0, noConflict: 0 };
  for (const game of eligible) {
    const onGame = slipOnGame.get(game.gameId) ?? [];
    const list: Candidate[] = [];
    for (const pick of game.picks) {
      passed.scope++;
      if (allSlipIds.has(pick.pickId)) {
        traced((t) => t.drop("NOT_SLIP", "IS_SLIP_PICK", pickRef(pick)));
        continue;
      }
      passed.notSlip++;
      if (!keepsPick(include, pick)) {
        traced((t) => t.drop("INCLUDED", "FILTER_BET_TYPE", pickRef(pick), betCategory(pick)));
        continue;
      }
      passed.included++;
      const gated = gateRecord(pick, snapshot, rules);
      if (!gated) {
        traced((t) => t.drop("HAS_RECORD", noRecordReason(pick), pickRef(pick), pick.propMarket ?? pick.category ?? undefined));
        continue;
      }
      passed.record++;
      const pickScore = scoreOf?.(pick) ?? null;
      if (pickScore ? !passesGate(pickScore, gate) : !qualifies(gated.record, gate)) {
        traced((t) =>
          t.drop(
            "PASSES_GATE",
            "BELOW_GATE",
            pickRef(pick),
            pickScore?.status === "SCORED"
              ? `edge ${(pickScore.rankScore * 100).toFixed(1)} < ${((pickScore.gate.requiredEdge ?? 0) * 100).toFixed(1)} (${gate}%)`
              : `${Math.round(gated.record.winPct)}% (${gated.record.wins}-${gated.record.losses}) < ${gate}%`
          )
        );
        continue;
      }
      passed.gate++;
      const { record, basis, propMarket } = gated;
      // Never against a slip pick on its game.
      if (onGame.some((s) => !(sureOfGame(game, s) && sureOfGame(game, pick)) || sameGameConflict(asCandidate(pick), asCandidate(s)) !== null)) {
        traced((t) => t.drop("NO_SLIP_CONFLICT", "SLIP_CONFLICT", pickRef(pick), conflictSub(game, pick, onGame) ?? undefined));
        continue;
      }
      passed.noConflict++;
      const wilson = wilsonLowerBound(record.wins, record.losses, rules.z);
      list.push({
        pick,
        game,
        record: toLegRecord(record),
        basis,
        ...(propMarket ? { propMarket } : {}),
        wilsonLowerBound: wilson,
        score: pickScore?.status === "SCORED" ? pickScore.rankScore * 100 : wilson,
        pickScore,
        category: betCategory(pick),
      });
    }
    list.sort(byRank);
    candidatesOf.set(game.gameId, list);
  }

  // ---- 4. Capacity ----------------------------------------------------------
  const roomOn = (gameId: string) => Math.max(0, maxPerGame - (slipOnGame.get(gameId)?.length ?? 0));
  const gamesWithCandidates = eligible.filter((g) => (candidatesOf.get(g.gameId)?.length ?? 0) > 0);
  const generatable = fillFrom === "YOUR_PICKS_ONLY" ? 0 : eligible.reduce((s, g) => s + Math.min(roomOn(g.gameId), candidatesOf.get(g.gameId)!.length), 0);
  // Under rule 6 the slip can make more legs than this parlay has: allInLegs.
  const capacity = Math.max(allInLegs.length, Math.min(MAX_PARLAY_LEGS, slipLegs.length + generatable));
  const capacityText =
    fillFrom === "YOUR_PICKS_ONLY"
      ? `${capacity} max from your picks only`
      : targeted
        ? `${capacity} max with ${plural(snapshot.targets.length, "game")} targeted`
        : `${capacity} max from ${plural(gamesWithCandidates.length, "game")} with qualified picks`;

  // ---- 5. Selection -----------------------------------------------------------
  const need = fillFrom === "YOUR_PICKS_ONLY" ? 0 : target - slipLegs.length;
  const slipCounts = new Map<BetCategoryResult, number>();
  for (const p of slipLegs) slipCounts.set(betCategory(p), (slipCounts.get(betCategory(p)) ?? 0) + 1);
  const mixTarget = mix && mixCounts(target, mix, categories);
  const quota: Partial<Record<BetCategoryResult, number>> | null = mixTarget
    ? Object.fromEntries(categories.map((c) => [c, Math.max(0, mixTarget[c] - (slipCounts.get(c) ?? 0))]))
    : null;

  const select = (rng: Rng | null, recent: ReadonlySet<string>): Candidate[] => {
    const chosen: Candidate[] = [];
    if (need <= 0) return chosen;
    const onGame = new Map<string, GeneratorPick[]>(Array.from(slipOnGame.entries()).map(([k, v]) => [k, [...v]]));
    const left = quota ? { ...quota } : null;
    const penalty = (c: Candidate) => (recent.has(c.pick.pickId) ? RECENT_WEIGHT : 1);
    const fits = (c: Candidate) => {
      const legs = onGame.get(c.game.gameId) ?? [];
      if (legs.length >= maxPerGame) return false;
      return legs.every((l) => sureOfGame(c.game, l) && sureOfGame(c.game, c.pick) && sameGameConflict(asCandidate(c.pick), asCandidate(l)) === null);
    };
    const take = (c: Candidate) => {
      chosen.push(c);
      onGame.set(c.game.gameId, [...(onGame.get(c.game.gameId) ?? []), c.pick]);
      if (left && left[c.category] !== undefined) left[c.category]!--;
    };
    const passes: boolean[] = left ? [true, false] : [false];
    // A strict pass takes only what a share still wants. An unclassified pick
    // has no share, so it waits for the open pass.
    const allows = (c: Candidate, strict: boolean) => !strict || (left![c.category] ?? 0) > 0;

    // Pass 1: one leg per game that has none yet, best games first.
    const open = eligible
      .filter((g) => !onGame.has(g.gameId) && (candidatesOf.get(g.gameId)?.length ?? 0) > 0)
      .map((g) => ({ game: g, top: candidatesOf.get(g.gameId)![0] }))
      .sort((a, b) => byRank(a.top, b.top));
    let order = open;
    if (rng && open.length > need) {
      // Games close to the cut rotate; the rest stay in rank order behind them.
      const cut = open[Math.min(need, open.length) - 1].top.score - rules.gameBand;
      const rotating = open.filter((o) => o.top.score >= cut);
      const behind = open.filter((o) => o.top.score < cut);
      const gamePenalty = (o: (typeof open)[number]) => (candidatesOf.get(o.game.gameId)!.some((c) => recent.has(c.pick.pickId)) ? RECENT_WEIGHT : 1);
      order = [...weightedOrder(rotating, (o) => o.top.score * gamePenalty(o), rng), ...behind];
    }
    for (const strict of passes) {
      for (const { game } of order) {
        if (chosen.length >= need) break;
        if (onGame.has(game.gameId)) continue;
        const options = candidatesOf.get(game.gameId)!.filter((c) => allows(c, strict) && fits(c));
        if (options.length === 0) continue;
        if (!rng) take(options[0]);
        else {
          const band = options.filter((c) => c.score >= options[0].score - rules.pickTieBand);
          take(weightedOrder(band, (c) => c.score * penalty(c), rng)[0]);
        }
      }
    }

    // Pass 2: same-game legs, only when games ran out.
    if (chosen.length < need && maxPerGame > 1) {
      const taken = new Set(chosen.map((c) => c.pick.pickId));
      let rest = eligible.flatMap((g) => candidatesOf.get(g.gameId)!).filter((c) => !taken.has(c.pick.pickId)).sort(byRank);
      if (rng && rest.length > 0) {
        const band = rest.filter((c) => c.score >= rest[0].score - rules.pickTieBand);
        const outside = rest.filter((c) => c.score < rest[0].score - rules.pickTieBand);
        rest = [...weightedOrder(band, (c) => c.score * penalty(c), rng), ...outside];
      }
      for (const strict of passes) {
        for (const c of rest) {
          if (chosen.length >= need) break;
          if (chosen.includes(c) || !allows(c, strict) || !fits(c)) continue;
          take(c);
        }
      }
    }
    return chosen;
  };

  const keyOf = (cs: Candidate[]) => legSetKey(cs.map((c) => c.pick.pickId));
  let chosen: Candidate[] = [];
  let variety: GeneratedParlay["variety"] = "BEST";
  if (subset) {
    // The slip picks were drawn above (1b); nothing is generated.
    variety = subsetVariety;
  } else if (scoreOf) {
    // GENERATOR_RULES: selection.ts, on the edge, under the same constraints as above.
    const cands: SelectionCandidate<Candidate>[] = eligible
      .flatMap((g) => candidatesOf.get(g.gameId)!)
      .map((c) => ({ item: c, id: c.pick.pickId, betKey: betKeyOf(c.pick), gameId: c.game.gameId, score: c.score, category: c.category }));
    const fill: FillRules<Candidate, GeneratorPick> = {
      need,
      maxPerGame,
      preLegs: slipLegs.map((p) => ({ gameId: p.gameId, leg: p, betKey: betKeyOf(p) })),
      legOf: (c) => c.pick,
      conflict: (a, b, gameId) => {
        const game = gameById.get(gameId);
        return !(sureOfGame(game, a) && sureOfGame(game, b)) || sameGameConflict(asCandidate(a), asCandidate(b)) !== null;
      },
      quota,
      oneLegPerGameFirst: true,
    };
    const tr = baseTrace();
    const primary = selectLegs(orderCandidates(cands, null), fill);
    let picked = primary.chosen;
    tr.repaired = primary.repaired;
    if (variation) {
      let found: Ranked<Candidate>[] | null = null;
      let fallback: Ranked<Candidate>[] | null = null;
      let rejected = 0;
      for (let i = 0; i < STANDARD_DRAW_TRIES && !found; i++) {
        const d = selectLegs(orderCandidates(cands, drawAt(i)), fill).chosen;
        const key = legSetKey(d.map((r) => r.id));
        if (!shownKeys.has(key)) found = d;
        else {
          rejected++;
          if (!fallback && key !== onScreen) fallback = d;
        }
      }
      tr.rejectedCombos = rejected;
      const v = found ?? fallback;
      if (v) {
        picked = v;
        variety = "VARIED";
      } else variety = "NO_ALTERNATIVE";
    }
    chosen = picked.map((r) => r.item);
    selectionTrace = finishTrace(tr, picked);
  } else if (!variation) {
    chosen = select(null, new Set());
  } else {
    const v = varyDraw(variation, select, keyOf, () => select(null, new Set()));
    chosen = v.chosen;
    variety = v.varied ? "VARIED" : "NO_ALTERNATIVE";
  }
  // Nothing to draw (every usable slip pick is in and no leg is generated) is
  // not the same as nothing new of comparable strength.
  const noAlternativeReason: GeneratedParlay["noAlternativeReason"] = variety !== "NO_ALTERNATIVE" ? null : !subset && need <= 0 ? "ALL_PICKS_USED" : "NO_COMPARABLE";
  const historyIds = subset ? slipLegs.map((p) => p.pickId) : chosen.map((c) => c.pick.pickId);

  // The funnel, for the run trace: counted from what the steps above actually did.
  traced((t) => {
    const eligibleIds = new Set(eligible.map((g) => g.gameId));
    for (const g of snapshot.games) {
      if (eligibleIds.has(g.gameId)) continue;
      t.tally("IN_SCOPE_GAMES", over(g) ? "GAME_OVER" : "NOT_TARGETED", g.picks.length);
    }
    t.stage("POOL", snapshot.games.reduce((n, g) => n + g.picks.length, 0));
    t.stage("IN_SCOPE_GAMES", passed.scope);
    t.stage("NOT_SLIP", passed.notSlip);
    t.stage("INCLUDED", passed.included);
    t.stage("HAS_RECORD", passed.record);
    t.stage("PASSES_GATE", passed.gate);
    t.stage("NO_SLIP_CONFLICT", passed.noConflict);
    t.stage("SELECTED", chosen.length);
    traceSelection(t, { candidates: Array.from(candidatesOf.values()).flat(), chosen, slipOnGame, maxPerGame, need, quota });
    traceSlip(t, snapshot.slipPicks.length, dropped, slipLegs.length);
    t.extras({
      ...(unavailableTargets.length > 0 ? { unavailableTargets: unavailableTargets.length } : {}),
      notes: [
        `variety:${variety}`,
        ...(noAlternativeReason ? [`noAlternative:${noAlternativeReason}`] : []),
        `need:${need}`,
        `slipLegs:${slipLegs.length}`,
        ...(selectionTrace?.budgetExhausted ? ["selection:BUDGET_EXHAUSTED"] : []),
        ...(selectionTrace?.exhausted ? [`selection:EXHAUSTED combos=${selectionTrace.combos ?? 0}`] : []),
      ],
    });
  });

  // ---- 6. Assemble ------------------------------------------------------------
  const legs: EngineLeg[] = [
    ...slipLegs.map((p): EngineLeg => {
      const r = bestAvailableRecord(p, snapshot.leagueRecords);
      return {
        pick: p,
        gameId: p.gameId,
        gameLabel: p.gameLabel,
        gameTime: p.gameTime,
        source: "SLIP",
        record: r ? { wins: r.wins, losses: r.losses, n: r.n, winPct: r.winPct } : null,
        basis: r?.source ?? null,
        wilsonLowerBound: null,
        sameGame: false,
      };
    }),
    ...chosen.map(
      (c): EngineLeg => ({
        pick: c.pick,
        gameId: c.game.gameId,
        gameLabel: c.game.gameLabel,
        gameTime: c.game.gameTime,
        source: "GENERATED",
        record: c.record,
        basis: c.basis,
        wilsonLowerBound: c.wilsonLowerBound,
        ...(c.pickScore ? { score: c.score } : {}),
        sameGame: false,
        ...(c.propMarket ? { propMarket: c.propMarket } : {}),
      })
    ),
  ];
  const perGame = new Map<string, number>();
  for (const l of legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  for (const l of legs) l.sameGame = (perGame.get(l.gameId) ?? 0) > 1;
  const firstStart = new Map<string, number>();
  for (const l of legs) firstStart.set(l.gameId, Math.min(firstStart.get(l.gameId) ?? Infinity, new Date(l.gameTime).getTime()));
  legs.sort(
    (a, b) =>
      firstStart.get(a.gameId)! - firstStart.get(b.gameId)! ||
      (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0) ||
      (a.source === b.source ? 0 : a.source === "SLIP" ? -1 : 1) ||
      (b.score ?? b.wilsonLowerBound ?? 0) - (a.score ?? a.wilsonLowerBound ?? 0)
  );

  // ---- 7. What it couldn't do -------------------------------------------------
  const shortfall: string[] = [];
  const gamesUsed = perGame.size;
  if (legs.length < target) {
    if (subset) {
      shortfall.push(`${legs.length} of ${target} legs: no ${target}-leg mix of your picks fits Max legs per game and the same-game rules.`);
    } else if (fillFrom === "YOUR_PICKS_ONLY") {
      shortfall.push(`Your picks only: ${plural(slipLegs.length, "pick")} in your slip. Switch Fill from to Best available to add legs.`);
    } else if (targeted) {
      shortfall.push(`${legs.length} of ${target} legs: the targeted games have no more picks that clear your bar and fit.`);
    } else {
      shortfall.push(
        `${legs.length} of ${target} legs: only ${plural(gamesWithCandidates.length, "game")} ${gamesWithCandidates.length === 1 ? "has" : "have"} picks that clear your bar` +
          (maxPerGame === 1 && gamesWithCandidates.length < need ? ". Raise Max legs per game to add same-game legs." : ".")
      );
    }
  }
  const limited = legs.length < target && !subset && fillFrom === "BEST_AVAILABLE" ? { have: legs.length, need: target } : null;
  if (limited) traced((t) => t.extras({ limited }));
  const mixNotes: string[] = [];
  if (mixTarget && fillFrom === "BEST_AVAILABLE") {
    for (const c of categories) {
      const got = legs.filter((l) => betCategory(l.pick) === c).length;
      if (got < mixTarget[c]) mixNotes.push(mixShortNote(c, got, mixTarget[c]));
    }
  }
  if (targeted && fillFrom === "BEST_AVAILABLE") {
    for (const id of snapshot.targets) {
      const game = gameById.get(id);
      if (!game || (candidatesOf.get(id)?.length ?? 0) > 0 || slipOnGame.has(id)) continue;
      shortfall.push(`${game.gameLabel}: no qualified picks — ${gamesUsed} of ${eligible.length} games used`);
    }
  }

  // Hedge's alternates under SCORING go through selection.ts: the top one on
  // Generate, a mode-weighted draw (one seed per leg) on Regenerate.
  const hedgeSelect: HedgeSelect | null = scoreOf
    ? { draw: variation ? { seed: deriveSeed(variation.seed, "hedge"), beta } : null, picked: [] }
    : null;
  const hedge = bySwapScope((scope) => buildSwap(legs, gameById, include, snapshot, "AUTO_HEDGE", scope, rules, gate, scoreOf, trace, hedgeSelect));
  const contrarian = bySwapScope((scope) => buildSwap(legs, gameById, include, snapshot, "CONTRARIAN", scope, rules, gate, scoreOf, trace));
  if (scoreOf) traced((t) => t.extras({ scoring: traceScoring({ platformRows: snapshot.platformRateRows ?? 0, legs, hedge: hedge.ALL, scoreOf }) }));
  if (selectionTrace) {
    const tr: SelectionTrace = { ...selectionTrace, ...(hedgeSelect && hedgeSelect.picked.length > 0 ? { hedge: hedgeSelect.picked } : {}) };
    traced((t) => t.extras({ selection: tr }));
  }

  return {
    legs,
    requested: target,
    fromSlip: slipLegs.length,
    slipTotal: liveSlip.length,
    slipUsed: slipLegs.length,
    generated: chosen.length,
    gamesUsed,
    sameGameGames: Array.from(perGame.values()).filter((n) => n > 1).length,
    capacity,
    capacityText,
    shortfall,
    limited,
    mixNotes,
    unavailableTargets,
    dropped,
    hedge,
    contrarian,
    variety,
    noAlternativeReason,
    historyIds,
    generatedKey: legSetKey(historyIds),
    ...(scoreOf ? { historyBetKeys: subset ? slipLegs.map(betKeyOf) : chosen.map((c) => betKeyOf(c.pick)) } : {}),
  };
}

// Regenerate's draws: up to VARIATION_TRIES seeded draws, keeping the first
// that is not in the history - or, failing that, the first that at least
// differs from the last parlay. Neither: `primary`, not varied.
function varyDraw<T>(
  variation: Variation,
  draw: (rng: Rng, recent: ReadonlySet<string>) => T[],
  keyOf: (ts: T[]) => string,
  primary: () => T[]
): { chosen: T[]; varied: boolean } {
  const shown = variation.history.map((ids) => legSetKey(ids));
  const recent = new Set(variation.history.slice(0, RECENT_PARLAYS).flat());
  let fallback: T[] | null = null;
  let found: T[] | null = null;
  for (let i = 0; i < VARIATION_TRIES && !found; i++) {
    const d = draw(seededRng(variation.seed + i * 7919), recent);
    const key = keyOf(d);
    if (!shown.includes(key)) found = d;
    else if (!fallback && key !== shown[0]) fallback = d;
  }
  const chosen = found ?? fallback;
  return chosen ? { chosen, varied: true } : { chosen: primary(), varied: false };
}

// A slip pick with no record, in selection's points: below any scored pick, so it
// is drawn only when nothing else fits (Wilson^8 gave it ~0 weight the same way).
export const UNSCORED_POINTS = -100;

// Rule 6 under GENERATOR_RULES: the leg count of the slip's picks. Generate takes
// the strongest; Regenerate draws, rejects any combination already shown on the
// card, then enumerates for the first unseen one. NO_ALTERNATIVE only when the
// enumeration completes with nothing unseen; a budget running out first returns a
// valid draw that differs from the parlay on screen (BUDGET_EXHAUSTED).
function subsetSelection(
  liveSlip: GeneratorPick[],
  scoreOf: (p: GeneratorPick) => PickScore,
  blocked: ReadonlySet<string>,
  legCount: number,
  maxPerGame: number,
  variation: Variation | null,
  shown: ReadonlySet<string>,
  onScreen: string | null,
  drawAt: (i: number) => Parameters<typeof orderCandidates>[1]
): { chosen: Ranked<GeneratorPick>[]; variety: GeneratedParlay["variety"]; trace: Partial<SelectionTrace> } {
  const cands: SelectionCandidate<GeneratorPick>[] = liveSlip.map((pick) => {
    const s = scoreOf(pick);
    return { item: pick, id: pick.pickId, betKey: betKeyOf(pick), gameId: pick.gameId, score: s.status === "SCORED" ? s.rankScore * 100 : UNSCORED_POINTS };
  });
  const fill: FillRules<GeneratorPick, GeneratorPick> = {
    need: legCount,
    maxPerGame,
    preLegs: [],
    legOf: (p) => p,
    conflict: (a, b) => blocked.has(a.pickId + "|" + b.pickId) || blocked.has(b.pickId + "|" + a.pickId),
    oneLegPerGameFirst: false,
  };
  const base = orderCandidates(cands, null);
  const primary = selectLegs(base, fill);
  if (!variation) return { chosen: primary.chosen, variety: "BEST", trace: { repaired: primary.repaired } };

  const size = primary.chosen.length;
  let rejected = 0;
  let differs: Ranked<GeneratorPick>[] | null = null;
  for (let i = 0; i < SUBSET_DRAW_TRIES; i++) {
    const d = selectLegs(orderCandidates(cands, drawAt(i)), fill).chosen;
    const key = legSetKey(d.map((r) => r.id));
    if (d.length === size && !shown.has(key)) return { chosen: d, variety: "VARIED", trace: { rejectedCombos: rejected } };
    rejected++;
    if (!differs && d.length === size && key !== onScreen) differs = d;
  }
  const e = enumerateCombos(base, fill, size, shown, onScreen, variation.enumerationBudget);
  const trace: Partial<SelectionTrace> = { rejectedCombos: rejected, combos: e.combos };
  if (e.found) return { chosen: e.found, variety: "VARIED", trace };
  if (e.budgetExhausted) {
    // Never "No other parlays" on a budget: a draw that differs from the parlay on screen, else the enumeration's
    // first such combination, else one leg swapped out of Generate's (drop one, refill without it).
    let swapped: Ranked<GeneratorPick>[] | null = null;
    for (let i = primary.chosen.length - 1; i >= 0 && !differs && !e.differsFromScreen && !swapped; i--) {
      const d = fillLegs(base, fill, new Set([primary.chosen[i].id]));
      if (d.length === size && legSetKey(d.map((r) => r.id)) !== onScreen) swapped = d;
    }
    const fallback = differs ?? e.differsFromScreen ?? swapped;
    return fallback
      ? { chosen: fallback, variety: "VARIED", trace: { ...trace, budgetExhausted: true } }
      : { chosen: primary.chosen, variety: "NO_ALTERNATIVE", trace: { ...trace, budgetExhausted: true } };
  }
  return { chosen: primary.chosen, variety: "NO_ALTERNATIVE", trace: { ...trace, exhausted: true } };
}

// Hedge's selection: the draw (null on Generate) and, for the run log, what Swap = All picked.
type HedgeSelect = { draw: { seed: number; beta: number } | null; picked: SelectionLegTrace[] };

// ---------------------------------------------------------------------------
// Hedge / Contrarian: each generated leg searched for an alternate on its own
// game. Under SCORING, Hedge uses rankCandidatesByScore (the classifier, then
// scoring.ts's gate and order). Otherwise rankCandidatesByRecord (qualification-
// core.ts - classifier, 55% gate, Wilson order) on the same record as the
// generated legs (gateRecord): Contrarian always, until it moves to scoring.
// Contrarian takes any capper on the other side who clears the gate - no
// headcount, except under LEGACY_RULES. Only the legs the Swap setting covers
// (`scope`, swap-scope.ts) are searched; the others stay as they are. An
// alternate is never one of the parlay's own picks or a slip pick, and never
// breaks a same-game rule against the other legs on its game (as they stand
// after any swap already made there).
// ---------------------------------------------------------------------------
const bySwapScope = (build: (scope: SwapScope) => EngineSwap): Record<SwapScope, EngineSwap> =>
  Object.fromEntries(SWAP_SCOPES.map((scope) => [scope, build(scope)])) as Record<SwapScope, EngineSwap>;

function buildSwap(
  legs: EngineLeg[],
  gameById: Map<string, GeneratorGame>,
  include: IncludeSelection,
  snapshot: GeneratorSnapshot,
  mode: SwapMode,
  scope: SwapScope,
  rules: GeneratorRules,
  gate: number,
  scoreOf: ((pick: GeneratorPick) => PickScore) | null,
  trace?: TraceCollector,
  hedgeSelect: HedgeSelect | null = null
): EngineSwap {
  const hedgeScore = mode === "AUTO_HEDGE" ? scoreOf : null;
  // Swap = All sees every leg; the other settings search a subset of them, so only All is traced leg by leg.
  const legTraces: SwapLegTrace[] = [];
  const traceLeg = trace && scope === "ALL" ? (fn: () => SwapLegTrace) => { try { legTraces.push(fn()); } catch (err) { trace.error("TRACE_ERROR", err, "swap"); } } : null;
  const inParlay = new Set([...legs.map((l) => l.pick.pickId), ...snapshot.slipPicks.map((p) => p.pickId)]);
  const current = new Map<string, GeneratorPick>(legs.map((l) => [l.pick.pickId, l.pick]));
  const out: EngineSwapLeg[] = legs.map((leg) => {
    if (!inSwapScope(scope, leg.source)) return { original: leg, swap: null, unchangedReason: "OUT_OF_SCOPE" };
    const gamePicks = (gameById.get(leg.gameId)?.picks ?? []).filter((p) => keepsPick(include, p));
    const siblings = legs.filter((l) => l !== leg && l.gameId === leg.gameId).map((l) => current.get(l.pick.pickId)!);
    const others = gamePicks.filter((p) => !inParlay.has(p.pickId) && siblings.every((s) => sameGameConflict(asCandidate(p), asCandidate(s)) === null));
    const primary = toParlayLeg(leg.pick);
    const pickById = new Map(gamePicks.map((p) => [p.pickId, p]));
    const sameGame = gamePicks.map(toParlayLeg);
    // Read before this leg changes inParlay / current, so it is the state the search ran on.
    const analysis = traceLeg
      ? (() => {
          try {
            return traceSwapLeg({
              mode,
              leg: leg.pick,
              gamePicks,
              allGamePicks: gameById.get(leg.gameId)?.picks.length ?? 0,
              slipIds: new Set(snapshot.slipPicks.map((p) => p.pickId)),
              inParlay,
              siblings,
              recordOk: (p) => {
                const g = gateRecord(p, snapshot, rules);
                if (!g) return "NO_RECORD";
                return (hedgeScore ? passesGate(hedgeScore(p), gate) : qualifies(g.record, gate)) ? "OK" : "BELOW_GATE";
              },
            });
          } catch (err) {
            trace!.error("TRACE_ERROR", err, "swap");
            return null;
          }
        })()
      : null;
    const note = (result: SwapLegTrace["result"], rule?: string) => {
      if (analysis) traceLeg!(() => ({ pick: pickRef(leg.pick), result, ...(rule ? { rule } : {}), ...analysis }));
    };
    let best: { leg: { pickId: string }; rule: Rule; record: LegRecord; wilsonLowerBound: number; basis?: "LEAGUE" | "OVERALL"; propMarket?: PropMarketKey } | undefined;
    if (hedgeScore) {
      const gated = rankCandidatesByScore(
        primary,
        others.map(toParlayLeg),
        mode,
        (l) => {
          const s = hedgeScore(pickById.get(l.pickId)!);
          return passesGate(s, gate) ? s : null;
        },
        compareScores
      );
      let top = gated[0];
      if (hedgeSelect && gated.length > 0) {
        // selection.ts: score, then betKey, then pick id on Generate; a mode-weighted draw on Regenerate.
        const order = orderCandidates(
          gated.map((g) => ({ item: g, id: g.leg.pickId, betKey: betKeyOf(pickById.get(g.leg.pickId)!), gameId: leg.gameId, score: g.score.status === "SCORED" ? g.score.rankScore * 100 : UNSCORED_POINTS })),
          hedgeSelect.draw ? { rng: selectionRng(deriveSeed(hedgeSelect.draw.seed, leg.pick.pickId)), beta: hedgeSelect.draw.beta } : null
        );
        top = order[0].item;
        if (scope === "ALL") hedgeSelect.picked.push(legTrace(order[0]));
      }
      // Scored means it has a record: the one its row shows.
      const shown = top && recordForGate(pickById.get(top.leg.pickId)!, snapshot.leagueRecords, snapshot.categoryRecords, rules.z, snapshot.propMarketRecords);
      best = top && shown
        ? {
            leg: top.leg,
            rule: top.rule,
            record: toLegRecord(shown),
            wilsonLowerBound: wilsonLowerBound(shown.wins, shown.losses, rules.z),
            basis: shown.source,
            ...(shown.propMarket ? { propMarket: shown.propMarket } : {}),
          }
        : undefined;
    } else if (rules.recordScope === "ALL_TIME") {
      best = rankCandidatesBy(primary, others.map(toParlayLeg), mode, snapshot.categoryRecords, (l) => pickById.get(l.pickId)?.category ?? null, sameGame)[0];
    } else {
      const top = rankCandidatesByRecord(
        primary,
        others.map(toParlayLeg),
        mode,
        (l) => recordForGate(pickById.get(l.pickId)!, snapshot.leagueRecords, snapshot.categoryRecords, rules.z, snapshot.propMarketRecords),
        { contrarianHeadcount: rules.contrarianHeadcount, sameGamePicks: sameGame, z: rules.z, minWinPct: gate }
      )[0];
      best = top && {
        leg: top.leg,
        rule: top.rule,
        record: top.record,
        wilsonLowerBound: top.wilsonLowerBound,
        basis: top.gateRecord.source,
        ...(top.gateRecord.propMarket ? { propMarket: top.gateRecord.propMarket } : {}),
      };
    }
    const bestPick = best ? others.find((p) => p.pickId === best!.leg.pickId) : undefined;
    if (!best || !bestPick) {
      const notMajority = mode === "CONTRARIAN" && rules.contrarianHeadcount && !contrarianHeadcountPasses(primary, sameGame);
      note(notMajority ? "NOT_MAJORITY" : "NO_ALTERNATE");
      return { original: leg, swap: null, unchangedReason: notMajority ? "NOT_MAJORITY" : "NO_ALTERNATE" };
    }
    note("SWAPPED", best.rule);
    inParlay.add(bestPick.pickId);
    current.set(leg.pick.pickId, bestPick);
    const { basis, rule, record, propMarket } = best;
    return {
      original: leg,
      swap: { pick: bestPick, rule, record, wilsonLowerBound: best.wilsonLowerBound, ...(basis ? { basis } : {}), ...(propMarket ? { propMarket } : {}) },
      unchangedReason: null,
    };
  });
  const swapCount = out.filter((l) => l.swap !== null).length;
  if (trace) {
    try {
      trace.swapMode({ mode: mode === "AUTO_HEDGE" ? "AUTO_HEDGE" : "CONTRARIAN", scope, swapCount, legs: legTraces });
    } catch (err) {
      trace.error("TRACE_ERROR", err, "swap");
    }
  }
  return { mode, legs: out, swapCount };
}
