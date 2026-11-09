// The Parlay Generator's run trace: how many picks survive each stage of a run,
// and why each dropped pick was dropped. Diagnostics only - the engine (generator.ts),
// the snapshot loader (generator-snapshot.ts) and Consensus Hybrid
// (hybrid-generate.ts) write to a TraceCollector as they go and never read from
// it, so a run builds exactly the same parlay with or without one.
//
// Two layers, both always complete:
//   - stage counts + reason tallies: the funnel. Each stage's count is the
//     previous stage's minus the drops tallied at it (reconcile below), whether
//     or not per-pick detail was kept.
//   - detail: one entry per dropped pick (pick id, label, stage, reason), capped
//     at MAX_DETAIL_ENTRIES (detailTruncated says when). Regenerate keeps counts
//     only (`detail: false`); game-level drops (a game not targeted, a game over)
//     are tallied by their picks, not listed.
//
// A collector never throws: every method is wrapped, and a failure marks the
// trace `failed` and stops recording. Pure and client-safe (the engine runs in
// the browser; the browser sends its trace to recordGeneratorRunAction).
import { SCORING_VERSION } from "@/lib/parlay/scoring";
import { SELECTION_VERSION, type SelectionTrace } from "@/lib/parlay/selection";
export type SelectionTraceShape = SelectionTrace;

export type RunMode = "STANDARD" | "YOUR_PICKS" | "HYBRID";
// FETCH: a server-built run (the snapshot was just loaded). GENERATE / REGENERATE:
// the engine run again in the browser on a held snapshot.
export type RunTrigger = "GENERATE" | "REGENERATE" | "FETCH";
export type RunOrigin = "SERVER" | "CLIENT";

export const REASON_LABELS = {
  // Snapshot (server)
  NOT_PENDING: "Pick not pending",
  GAME_STARTED: "Game already started",
  GAME_OVER: "Game over",
  OUTSIDE_WINDOW: "Game outside the slate window",
  NOT_TARGETED: "Game not targeted",
  NO_GAME_MATCH: "Pick matched no game",
  // Standard candidates
  IS_SLIP_PICK: "Already a slip pick",
  FILTER_BET_TYPE: "Bet Types filter",
  FILTER_FAVORITES: "Favorites only (capper not a favorite)",
  NO_CATEGORY: "Pick has no record category",
  NO_RECORD: "Capper has no record in this bet",
  NO_PROP_MARKET_RECORD: "Capper has no record in this prop market",
  BELOW_GATE: "Record below the win-rate gate",
  SLIP_CONFLICT: "Conflicts with a slip pick on its game",
  SAME_GAME_CONFLICT: "Same-game rule against a chosen leg",
  MAX_PER_GAME: "Max legs per game reached",
  MIX_QUOTA: "Pick Mix share already filled",
  NOT_NEEDED: "Leg count already reached",
  NOT_DRAWN: "Fit but was not drawn",
  // Slip picks
  SLIP_GAME_OVER: "Slip pick's game is over",
  SLIP_DUPLICATE: "Slip pick duplicates another",
  SLIP_OPPOSES: "Slip pick opposes another",
  SLIP_LEFT_OUT: "Slip pick left out by max legs per game",
  SLIP_NOT_SELECTED: "Slip pick not drawn (Your picks only)",
  // Hedge / Contrarian
  OUT_OF_SCOPE: "Leg outside the Swap setting",
  ALREADY_IN_PARLAY: "Alternate already a leg",
  IN_SLIP: "Alternate is in your slip",
  NO_OPPOSITE_SIDE: "No pick the classifier pairs with this leg",
  NO_ALTERNATE: "No alternate qualified",
  NOT_MAJORITY: "Leg's side is not the majority (legacy rules)",
  NO_QUALIFYING_CONTRARIAN: "No pick on the other side of this bet qualified",
  // Consensus Hybrid
  NO_ELIGIBLE_PICKS: "No full-game side or total picks",
  NO_SIDE_PICKS: "No side picks",
  NO_TOTAL_PICKS: "No total picks",
  NOT_ENOUGH_SUPPORTERS: "No capper left on one side",
  BEYOND_LADDER_LIMIT: "Past the pricing limit",
  LADDER_UNAVAILABLE: "FanDuel lines not available",
  NO_ODDS: "No FanDuel line within limits",
  LEG_CAP: "Total legs cap reached",
  RANKED_LOWER: "Ranked below the games shown",
} as const;

export type ReasonCode = keyof typeof REASON_LABELS;
export const REASON_CODES = Object.keys(REASON_LABELS) as ReasonCode[];

export const ERROR_CODES = ["FETCH_ERROR", "LADDER_ERROR", "SNAPSHOT_ERROR", "ENGINE_ERROR", "TRACE_ERROR"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Stages, grouped in chains: within a chain each stage's count is the previous
// stage's minus the drops tallied at it.
export const STAGE_CHAINS = {
  pool: ["POOL", "IN_SCOPE_GAMES", "NOT_SLIP", "INCLUDED", "HAS_RECORD", "PASSES_GATE", "NO_SLIP_CONFLICT", "SELECTED"],
  slip: ["SLIP_TOTAL", "SLIP_LIVE", "SLIP_NO_CONFLICT", "SLIP_FITS_GAME", "SLIP_USED"],
  hybrid: ["HYB_GAMES_WITH_PICKS", "HYB_GAMES_KEPT"],
} as const;

export type StageKey = (typeof STAGE_CHAINS)[keyof typeof STAGE_CHAINS][number];
export const STAGE_KEYS = Object.values(STAGE_CHAINS).flat() as StageKey[];

export type PickRef = { id: string; label: string };
// [pick index into detail.picks, stage, reason, sub]
export type DropEntry = [number, StageKey, ReasonCode, string?];

// Hedge / Contrarian, one entry per leg (Swap = All; the other settings only count).
export type SwapLegTrace = {
  pick: PickRef;
  // SWAPPED, or why not: OUT_OF_SCOPE / NO_ALTERNATE / NOT_MAJORITY.
  result: "SWAPPED" | ReasonCode;
  // Alternate's rule when swapped.
  rule?: string;
  // Picks on the game, and where each went: left by the Bet Types filter (or, with
  // the Favorites only star on, by it - FILTER_FAVORITES, absent when the star is
  // off), already a leg or in the slip, blocked by a same-game rule against a sibling leg.
  gamePicks: number;
  excluded: { FILTER_BET_TYPE: number; FILTER_FAVORITES?: number; IN_SLIP: number; ALREADY_IN_PARLAY: number; SAME_GAME_CONFLICT: number };
  // What the classifier said about the rest against this leg: R1..R6 or INACTIVE / UNDERIVABLE /
  // UNCLASSIFIED / EXACT_DUPLICATE / NOT_SAME_GAME.
  classifier: Record<string, number>;
  // Of those the classifier pairs with this leg for this mode.
  paired: number;
  noRecord: number;
  belowGate: number;
  qualified: number;
  // Contrarian under SCORING (contrarian-match.ts): the other side of this bet within
  // the line tolerance (`opposite`), past it, or in another period; how the opposite
  // ones fared at the gate; and the one chosen with its line gap. `paired` above then
  // counts same-bet matches, not the classifier's R2/R3.
  contrarian?: { opposite: number; lineTooFar: number; periodMismatch: number; noRecord: number; belowGate: number; qualifying: number; chosen?: string; lineGap?: number };
};

// One build of Hedge or Contrarian for one Swap setting. `legs` is filled for Swap = All only (the
// other settings search a subset of the same legs); the others only say how many legs they swapped.
export type SwapModeTrace = { mode: "AUTO_HEDGE" | "CONTRARIAN"; scope: string; swapCount: number; legs: SwapLegTrace[] };

export type SnapshotLeagueStats = {
  league: string;
  boardGames: number;
  pickRowsFetched: number;
  pickRowsMatched: number;
  pickRowsUnmatched: number;
  // Matched picks that are PENDING with a datePosted.
  matchedPending: number;
  gamesWithPending: number;
  gamesKept: number;
};

export type SnapshotStats = {
  leagues: SnapshotLeagueStats[];
  // Pending picks in the games the snapshot kept (the Standard pool).
  poolPicks: number;
  // Per game: [league, label, matched picks, pending picks, kept or why not].
  games: [string, string, number, number, string][];
};

export type LadderStatus = { eventId: string; gameLabel: string; markets: string[]; status: "ok" | "not-posted" | "pricing-in-progress" | "unavailable" | "not-asked"; cause?: string };

// One leg or Hedge alternate as scoring.ts read it. A pick with no record has only
// id, role and model.
export const SCORING_ROLES = ["SLIP", "GENERATED", "HEDGE"] as const;
export const SCORING_MODELS = ["EDGE", "WIN_RATE", "NO_RECORD"] as const;
export const SCORING_LEVELS = ["LEAGUE", "OTHER_LEAGUES"] as const;
export type ScoringLegTrace = {
  id: string;
  role: (typeof SCORING_ROLES)[number];
  model: (typeof SCORING_MODELS)[number];
  // Why the win-rate model.
  fallback?: string;
  // The lowest level of the capper's own record it read; the platform tier under it.
  level?: (typeof SCORING_LEVELS)[number];
  tier?: string;
  shrunkWin?: number;
  // Edge model only.
  shrunkEdge?: number;
  edge?: number;
  price?: string;
  priceRule?: string;
  // Null at L = 0: no gate.
  requiredEdge?: number | null;
  gatePass?: boolean;
};
// platformRows: rows in platform_category_rates when the snapshot was built. 0 is an empty table: every pick on the defaults.
export type ScoringTrace = { platformRows: number; legs: ScoringLegTrace[] };

export type RunExtras = {
  snapshotBuiltAt?: string;
  buildSha?: string;
  snapshot?: SnapshotStats;
  swaps?: SwapModeTrace[];
  scoring?: ScoringTrace;
  // Standard / Your picks under GENERATOR_RULES: what selection.ts did.
  selection?: SelectionTrace;
  ladders?: LadderStatus[];
  unavailableTargets?: number;
  // Best available fell short of Total legs because too few legs clear the bar: legs built vs legs asked for.
  limited?: { have: number; need: number };
  notes?: string[];
};

export type RunTraceError = { code: ErrorCode; message: string; where?: string };

export type RunTrace = {
  mode: RunMode;
  trigger: RunTrigger;
  origin: RunOrigin;
  scoringVersion: string;
  settings: Record<string, unknown>;
  stages: { key: StageKey; count: number }[];
  // One row per (stage, reason, sub): how many picks (or games, for Hybrid).
  reasons: { stage: StageKey | "SWAP"; reason: ReasonCode; sub?: string; count: number }[];
  errors: RunTraceError[];
  extras: RunExtras;
  detail: { picks: PickRef[]; drops: DropEntry[] } | null;
  detailTruncated: boolean;
  // The collector hit an error: the funnel may be incomplete.
  failed: boolean;
  durationMs: number | null;
};

export const MAX_DETAIL_ENTRIES = 600;
export const MAX_LABEL = 140;
export const MAX_ERROR_MESSAGE = 300;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export class TraceCollector {
  private readonly stagesOut: { key: StageKey; count: number }[] = [];
  private readonly tallies = new Map<string, { stage: StageKey | "SWAP"; reason: ReasonCode; sub?: string; count: number }>();
  private readonly errorsOut: RunTraceError[] = [];
  private readonly extrasOut: RunExtras = {};
  private readonly pickIndex = new Map<string, number>();
  private readonly picks: PickRef[] = [];
  private readonly drops: DropEntry[] = [];
  private truncated = false;
  private failed = false;
  private readonly startedAt = Date.now();

  constructor(
    readonly meta: { mode: RunMode; trigger: RunTrigger; origin: RunOrigin; scoringVersion: string; settings: Record<string, unknown> },
    // Per-pick detail on or off (Regenerate: off).
    private readonly detail = true
  ) {}

  // Runs the recording step; a failure marks the trace failed and is never rethrown.
  private safe(fn: () => void): void {
    if (this.failed) return;
    try {
      fn();
    } catch (err) {
      this.failed = true;
      try {
        this.errorsOut.push({ code: "TRACE_ERROR", message: clip(err instanceof Error ? err.message : String(err), MAX_ERROR_MESSAGE) });
      } catch {
        // Nothing left to do.
      }
    }
  }

  stage(key: StageKey, count: number): void {
    this.safe(() => void this.stagesOut.push({ key, count }));
  }

  // n picks (or games) dropped at a stage, with no per-pick detail.
  tally(stage: StageKey | "SWAP", reason: ReasonCode, n = 1, sub?: string): void {
    this.safe(() => {
      if (n <= 0) return;
      const key = stage + "|" + reason + "|" + (sub ?? "");
      const row = this.tallies.get(key);
      if (row) row.count += n;
      else this.tallies.set(key, { stage, reason, ...(sub ? { sub } : {}), count: n });
    });
  }

  // One pick dropped at a stage: tallied, and listed while detail is on and under the cap.
  drop(stage: StageKey, reason: ReasonCode, pick: PickRef, sub?: string): void {
    this.tally(stage, reason, 1, sub);
    this.safe(() => {
      if (!this.detail) return;
      if (this.drops.length >= MAX_DETAIL_ENTRIES) {
        this.truncated = true;
        return;
      }
      let idx = this.pickIndex.get(pick.id);
      if (idx === undefined) {
        idx = this.picks.push({ id: pick.id, label: clip(pick.label, MAX_LABEL) }) - 1;
        this.pickIndex.set(pick.id, idx);
      }
      this.drops.push(sub ? [idx, stage, reason, clip(sub, 60)] : [idx, stage, reason]);
    });
  }

  error(code: ErrorCode, err: unknown, where?: string): void {
    // Not through safe(): an error report must survive a failed collector.
    try {
      this.errorsOut.push({ code, message: clip(err instanceof Error ? err.message : String(err), MAX_ERROR_MESSAGE), ...(where ? { where } : {}) });
    } catch {
      // Nothing left to do.
    }
  }

  extras(patch: RunExtras): void {
    this.safe(() => void Object.assign(this.extrasOut, patch));
  }

  swapMode(mode: SwapModeTrace): void {
    this.safe(() => void (this.extrasOut.swaps ??= []).push(mode));
  }

  get detailOn(): boolean {
    return this.detail;
  }

  finish(): RunTrace {
    return {
      ...this.meta,
      stages: this.stagesOut,
      reasons: Array.from(this.tallies.values()),
      errors: this.errorsOut,
      extras: this.extrasOut,
      detail: this.detail ? { picks: this.picks, drops: this.drops } : null,
      detailTruncated: this.truncated,
      failed: this.failed,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

// The funnel's arithmetic: in every chain, each stage = the previous stage minus the
// drops tallied at it. Returns the stages that don't add up (empty = reconciled).
export function reconcileTrace(trace: Pick<RunTrace, "stages" | "reasons">): { stage: StageKey; expected: number; actual: number }[] {
  const dropsAt = new Map<string, number>();
  for (const r of trace.reasons) dropsAt.set(r.stage, (dropsAt.get(r.stage) ?? 0) + r.count);
  const count = new Map(trace.stages.map((s) => [s.key, s.count]));
  const bad: { stage: StageKey; expected: number; actual: number }[] = [];
  for (const chain of Object.values(STAGE_CHAINS)) {
    for (let i = 1; i < chain.length; i++) {
      const prev = count.get(chain[i - 1]);
      const here = count.get(chain[i]);
      if (prev === undefined || here === undefined) continue;
      const expected = prev - (dropsAt.get(chain[i]) ?? 0);
      if (expected !== here) bad.push({ stage: chain[i], expected, actual: here });
    }
  }
  return bad;
}

// A Standard or Your-picks run under SCORING, with its selection layer and Contrarian's model
// (the other side of the same bet, scored like Hedge). Short: the intake keeps 80 characters.
export const CONTRARIAN_VERSION = "contra-samebet-v1";
export function standardScoringVersion(_parts: { z: number }): string {
  return `standard/${SCORING_VERSION}/${SELECTION_VERSION}/${CONTRARIAN_VERSION}`;
}

// Names the rules a run was scored under, for comparing runs across changes.
export function scoringVersionOf(parts: { recordScope: string; z: number; contrarianHeadcount: boolean }, hybrid = false): string {
  return [hybrid ? "hybrid" : "standard", parts.recordScope, "z" + parts.z, parts.contrarianHeadcount ? "headcount" : "no-headcount", "prop-market-records"].join("/");
}
