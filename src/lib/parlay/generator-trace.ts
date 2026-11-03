// What generator.ts tells a TraceCollector (run-trace.ts) once it has built a
// parlay: the reason each candidate was left out of selection, how the slip
// picks fared, and why each Hedge / Contrarian leg found (or didn't find) an
// alternate. Everything here READS the engine's final state and re-asks the same
// pure rules (sameGameConflict, classifyPair); none of it feeds back, so the
// parlay is the same with or without a collector. Pure and client-safe.
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { BetCategoryResult } from "@/lib/parlay/bet-category";
import { classifyPair } from "@/lib/parlay/relationship-classifier";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";
import { propMarketKey } from "@/lib/prop-market-key";
import type { DroppedSlipPick, EngineLeg, EngineSwap, GeneratorSettings } from "@/lib/parlay/generator";
import type { PickRef, ReasonCode, ScoringLegTrace, ScoringTrace, SwapLegTrace, TraceCollector } from "@/lib/parlay/run-trace";
import type { PickScore } from "@/lib/parlay/scoring";

export const pickRef = (p: Pick<GeneratorPick, "pickId" | "capperName" | "betDetail">): PickRef => ({ id: p.pickId, label: `${p.capperName} — ${p.betDetail}` });

const asCandidate = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));

// A doubleheader's board can't tell which game a pick with no game number is on
// (sureOfGame in generator.ts).
const sureOfGame = (game: GeneratorGame | undefined, pick: GeneratorPick) => !game?.doubleheader || pick.gameNumber != null;

// Which same-game rule (R-A, R-B, ...) keeps `pick` off a game that holds `legs`,
// or null when none does.
export function conflictSub(game: GeneratorGame | undefined, pick: GeneratorPick, legs: GeneratorPick[]): string | null {
  for (const l of legs) {
    if (!(sureOfGame(game, l) && sureOfGame(game, pick))) return "DOUBLEHEADER";
    const c = sameGameConflict(asCandidate(pick), asCandidate(l));
    if (c !== null) return c.rule;
  }
  return null;
}

// Why gateRecord found no record for this pick.
export function noRecordReason(pick: GeneratorPick): ReasonCode {
  if (propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket })) return "NO_PROP_MARKET_RECORD";
  return pick.category ? "NO_RECORD" : "NO_CATEGORY";
}

export type TraceCandidate = { pick: GeneratorPick; game: GeneratorGame; category: BetCategoryResult };

// Every candidate that cleared the gate and the slip but is not a chosen leg, and
// the first thing that kept it out, from the legs the game ended with.
export function traceSelection(
  trace: TraceCollector,
  input: {
    candidates: TraceCandidate[];
    chosen: TraceCandidate[];
    slipOnGame: Map<string, GeneratorPick[]>;
    maxPerGame: number;
    need: number;
    quota: Partial<Record<BetCategoryResult, number>> | null;
  }
): void {
  const { chosen, slipOnGame, maxPerGame, need, quota } = input;
  const picked = new Set(chosen.map((c) => c.pick.pickId));
  const legsOn = (gameId: string): GeneratorPick[] => [...(slipOnGame.get(gameId) ?? []), ...chosen.filter((c) => c.game.gameId === gameId).map((c) => c.pick)];
  for (const c of input.candidates) {
    if (picked.has(c.pick.pickId)) continue;
    const ref = pickRef(c.pick);
    if (need <= 0) {
      trace.drop("SELECTED", "NOT_NEEDED", ref, "no legs needed");
      continue;
    }
    const legs = legsOn(c.game.gameId);
    if (legs.length >= maxPerGame) {
      trace.drop("SELECTED", "MAX_PER_GAME", ref, `${legs.length}/${maxPerGame}`);
      continue;
    }
    const rule = conflictSub(c.game, c.pick, legs);
    if (rule) {
      trace.drop("SELECTED", "SAME_GAME_CONFLICT", ref, rule);
      continue;
    }
    const share = quota?.[c.category];
    if (quota && share !== undefined && chosen.filter((x) => x.category === c.category).length >= share && chosen.length >= need) {
      trace.drop("SELECTED", "MIX_QUOTA", ref, c.category);
      continue;
    }
    trace.drop("SELECTED", chosen.length >= need ? "NOT_NEEDED" : "NOT_DRAWN", ref, chosen.length >= need ? "leg count reached" : undefined);
  }
}

const SLIP_REASON: Record<DroppedSlipPick["reason"], { stage: "SLIP_LIVE" | "SLIP_NO_CONFLICT" | "SLIP_FITS_GAME" | "SLIP_USED"; code: ReasonCode }> = {
  over: { stage: "SLIP_LIVE", code: "SLIP_GAME_OVER" },
  duplicate: { stage: "SLIP_NO_CONFLICT", code: "SLIP_DUPLICATE" },
  opposes: { stage: "SLIP_NO_CONFLICT", code: "SLIP_OPPOSES" },
  left_out: { stage: "SLIP_FITS_GAME", code: "SLIP_LEFT_OUT" },
  not_selected: { stage: "SLIP_USED", code: "SLIP_NOT_SELECTED" },
};

// The slip's own funnel, from the engine's `dropped` list.
export function traceSlip(trace: TraceCollector, slipTotal: number, dropped: DroppedSlipPick[], used: number): void {
  const at = (stage: string) => dropped.filter((d) => SLIP_REASON[d.reason].stage === stage).length;
  const live = slipTotal - at("SLIP_LIVE");
  const noConflict = live - at("SLIP_NO_CONFLICT");
  const fits = noConflict - at("SLIP_FITS_GAME");
  trace.stage("SLIP_TOTAL", slipTotal);
  trace.stage("SLIP_LIVE", live);
  trace.stage("SLIP_NO_CONFLICT", noConflict);
  trace.stage("SLIP_FITS_GAME", fits);
  // The count the engine ended with, not the arithmetic: reconcileTrace checks them against each other.
  trace.stage("SLIP_USED", used);
  for (const d of dropped) {
    const { stage, code } = SLIP_REASON[d.reason];
    trace.drop(stage, code, { id: d.pickId, label: d.label }, d.against ? `vs ${d.against.label}` : undefined);
  }
}

// One Hedge / Contrarian leg: the picks on its game, and where each went on the
// way to being an alternate. `recordOk` is the engine's own gate, passed in so
// this file stays free of the record maps.
export function traceSwapLeg(input: {
  mode: "AUTO_HEDGE" | "CONTRARIAN";
  leg: GeneratorPick;
  gamePicks: GeneratorPick[];
  allGamePicks: number;
  slipIds: Set<string>;
  inParlay: Set<string>;
  siblings: GeneratorPick[];
  recordOk: (p: GeneratorPick) => "NO_RECORD" | "BELOW_GATE" | "OK";
}): Omit<SwapLegTrace, "pick" | "result" | "rule"> {
  const out = {
    gamePicks: input.allGamePicks,
    excluded: { FILTER_BET_TYPE: input.allGamePicks - input.gamePicks.length, IN_SLIP: 0, ALREADY_IN_PARLAY: 0, SAME_GAME_CONFLICT: 0 },
    classifier: {} as Record<string, number>,
    paired: 0,
    noRecord: 0,
    belowGate: 0,
    qualified: 0,
  };
  const primary = asCandidate(input.leg);
  for (const p of input.gamePicks) {
    if (p.pickId === input.leg.pickId) continue;
    if (input.slipIds.has(p.pickId)) out.excluded.IN_SLIP++;
    else if (input.inParlay.has(p.pickId)) out.excluded.ALREADY_IN_PARLAY++;
    else if (input.siblings.some((s) => sameGameConflict(asCandidate(p), asCandidate(s)) !== null)) out.excluded.SAME_GAME_CONFLICT++;
    else {
      const o = classifyPair(primary, asCandidate(p));
      const key = o.outcome === "RULE" ? o.rule : o.outcome;
      out.classifier[key] = (out.classifier[key] ?? 0) + 1;
      if (o.outcome !== "RULE" || o.mode !== input.mode) continue;
      out.paired++;
      const r = input.recordOk(p);
      if (r === "NO_RECORD") out.noRecord++;
      else if (r === "BELOW_GATE") out.belowGate++;
      else out.qualified++;
    }
  }
  return out;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function scoringLeg(id: string, role: ScoringLegTrace["role"], s: PickScore): ScoringLegTrace {
  if (s.status !== "SCORED") return { id, role, model: "NO_RECORD" };
  return {
    id,
    role,
    model: s.model === "edge model" ? "EDGE" : "WIN_RATE",
    ...(s.fallback ? { fallback: s.fallback } : {}),
    level: s.levels.league.wins + s.levels.league.losses > 0 ? "LEAGUE" : "OTHER_LEAGUES",
    tier: s.levels.platform.tier,
    shrunkWin: r4(s.shrunkWinProb),
    ...(s.edgeModel ? { shrunkEdge: r4(s.edgeModel.shrunkEdge) } : {}),
    edge: r4(s.rankScore),
    price: s.price.status,
    priceRule: s.price.rule,
    requiredEdge: s.gate.requiredEdge === null ? null : r4(s.gate.requiredEdge),
    gatePass: s.gate.passes,
  };
}

// Each leg of the parlay and each Hedge alternate (Swap = All), as scoring.ts read them.
export function traceScoring(input: { platformRows: number; legs: EngineLeg[]; hedge: EngineSwap; scoreOf: (p: GeneratorPick) => PickScore }): ScoringTrace {
  return {
    platformRows: input.platformRows,
    legs: [
      ...input.legs.map((l) => scoringLeg(l.pick.pickId, l.source === "SLIP" ? "SLIP" : "GENERATED", input.scoreOf(l.pick))),
      ...input.hedge.legs.flatMap((l) => (l.swap ? [scoringLeg(l.swap.pick.pickId, "HEDGE", input.scoreOf(l.swap.pick))] : [])),
    ],
  };
}

// The settings a Standard run's trace records (small, primitives only).
export function traceSettings(pool: { leagues: string[]; slipPickIds: string[]; targets: unknown[] }, s: GeneratorSettings): Record<string, unknown> {
  return {
    leagues: pool.leagues,
    slipPicks: pool.slipPickIds.length,
    targets: pool.targets.length,
    legCount: s.legCount,
    maxLegsPerGame: s.maxLegsPerGame,
    include: s.include,
    ...(s.mix ? { mix: s.mix } : {}),
    fillFrom: s.fillFrom,
    minWinPct: s.minWinPct ?? null,
  };
}

export const traceModeOf = (pool: { slipPickIds: string[] }, s: GeneratorSettings): "STANDARD" | "YOUR_PICKS" =>
  s.fillFrom === "YOUR_PICKS_ONLY" && pool.slipPickIds.length > 0 ? "YOUR_PICKS" : "STANDARD";
