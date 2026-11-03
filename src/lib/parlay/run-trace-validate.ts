// The Parlay Generator run log's intake rules (run-trace.ts): the per-user rate limit and the validator for
// a trace the browser sends. Pure - no database - so the rules are testable on their own; the recorder that
// stores an accepted trace is server/data/generator-runs.ts.
//
// A browser trace is untrusted diagnostics: sanitizeClientTrace rebuilds it from a strict schema (known
// codes, bounded counts and strings, capped sizes) and forces its origin; whatever doesn't fit is dropped,
// not repaired. The userId never comes from the payload (the action reads it from the session).
import {
  ERROR_CODES,
  MAX_DETAIL_ENTRIES,
  MAX_ERROR_MESSAGE,
  MAX_LABEL,
  REASON_CODES,
  SCORING_LEVELS,
  SCORING_MODELS,
  SCORING_ROLES,
  STAGE_KEYS,
  type DropEntry,
  type ErrorCode,
  type ReasonCode,
  type RunTrace,
  type ScoringLegTrace,
  type ScoringTrace,
  type SelectionTraceShape,
  type StageKey,
  type SwapLegTrace,
  type SwapModeTrace,
} from "@/lib/parlay/run-trace";

// A browser trace bigger than this (serialized) is stored without its detail.
export const MAX_CLIENT_TRACE_BYTES = 150_000;
export const RATE_LIMIT_PER_MINUTE = 30;

// ---------------------------------------------------------------------------
// Rate limit: best effort, per server instance (a Map, no database read). A
// burst across instances can exceed it by a few rows; the size caps bound the rest.
// ---------------------------------------------------------------------------
const recent = new Map<string, number[]>();

export function allowTrace(userId: string, nowMs: number = Date.now()): boolean {
  const since = nowMs - 60_000;
  const hits = (recent.get(userId) ?? []).filter((t) => t > since);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    recent.set(userId, hits);
    return false;
  }
  hits.push(nowMs);
  recent.set(userId, hits);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => t <= since)) recent.delete(k);
  return true;
}

// ---------------------------------------------------------------------------
// Validation of a trace from the browser
// ---------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const count = (v: unknown, max = 1_000_000): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const stageKeys = new Set<string>(STAGE_KEYS);
const reasonCodes = new Set<string>(REASON_CODES);
const errorCodes = new Set<string>(ERROR_CODES);

function cleanSettings(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, 20)) {
    if (!/^[A-Za-z]{1,24}$/.test(k)) continue;
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean") out[k] = val;
    else if (typeof val === "string") out[k] = val.slice(0, 80);
    else if (Array.isArray(val)) out[k] = val.filter((x): x is string => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 40));
    else if (isObj(val)) {
      const inner: Record<string, number> = {};
      for (const [ik, iv] of Object.entries(val).slice(0, 8)) if (/^[A-Z_]{1,16}$/.test(ik) && typeof iv === "number" && Number.isFinite(iv)) inner[ik] = iv;
      out[k] = inner;
    }
  }
  return out;
}

function cleanSwapLeg(v: unknown): SwapLegTrace | null {
  if (!isObj(v) || !isObj(v.pick) || !isObj(v.excluded) || !isObj(v.classifier)) return null;
  const id = str(v.pick.id, 64);
  const label = str(v.pick.label, MAX_LABEL);
  const result = str(v.result, 24);
  if (!id || label === null || !result || (result !== "SWAPPED" && !reasonCodes.has(result))) return null;
  const n = (x: unknown) => count(x, 100_000);
  const gamePicks = n(v.gamePicks);
  const paired = n(v.paired);
  const noRecord = n(v.noRecord);
  const belowGate = n(v.belowGate);
  const qualified = n(v.qualified);
  const ex = v.excluded;
  const exF = n(ex.FILTER_BET_TYPE);
  const exS = n(ex.IN_SLIP);
  const exP = n(ex.ALREADY_IN_PARLAY);
  const exC = n(ex.SAME_GAME_CONFLICT);
  if ([gamePicks, paired, noRecord, belowGate, qualified, exF, exS, exP, exC].some((x) => x === null)) return null;
  const classifier: Record<string, number> = {};
  for (const [k, c] of Object.entries(v.classifier).slice(0, 16)) {
    const cc = n(c);
    if (/^[A-Z0-9_]{1,24}$/.test(k) && cc !== null) classifier[k] = cc;
  }
  const rule = str(v.rule, 4);
  return {
    pick: { id, label },
    result: result as SwapLegTrace["result"],
    ...(rule ? { rule } : {}),
    gamePicks: gamePicks!,
    excluded: { FILTER_BET_TYPE: exF!, IN_SLIP: exS!, ALREADY_IN_PARLAY: exP!, SAME_GAME_CONFLICT: exC! },
    classifier,
    paired: paired!,
    noRecord: noRecord!,
    belowGate: belowGate!,
    qualified: qualified!,
  };
}

function cleanSwaps(v: unknown): SwapModeTrace[] {
  if (!Array.isArray(v)) return [];
  const out: SwapModeTrace[] = [];
  for (const m of v.slice(0, 6)) {
    if (!isObj(m) || (m.mode !== "AUTO_HEDGE" && m.mode !== "CONTRARIAN")) continue;
    const scope = str(m.scope, 16);
    const swapCount = count(m.swapCount, 100);
    if (!scope || swapCount === null || !Array.isArray(m.legs)) continue;
    out.push({ mode: m.mode, scope, swapCount, legs: m.legs.slice(0, 25).map(cleanSwapLeg).filter((l): l is SwapLegTrace => l !== null) });
  }
  return out;
}

// A leg per parlay leg (25) plus a Hedge alternate for each.
const MAX_SCORING_LEGS = 50;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 10 ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && /^[A-Z0-9_]{1,40}$/.test(v) ? v : null);

function cleanScoringLeg(v: unknown): ScoringLegTrace | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 64);
  const role = SCORING_ROLES.find((x) => x === v.role);
  const model = SCORING_MODELS.find((x) => x === v.model);
  if (!id || !role || !model) return null;
  if (model === "NO_RECORD") return { id, role, model };
  const level = SCORING_LEVELS.find((x) => x === v.level);
  const fallback = code(v.fallback);
  const tier = code(v.tier);
  const shrunkWin = num(v.shrunkWin);
  const shrunkEdge = num(v.shrunkEdge);
  const edge = num(v.edge);
  const price = code(v.price);
  const priceRule = code(v.priceRule);
  const requiredEdge = num(v.requiredEdge);
  return {
    id,
    role,
    model,
    ...(fallback ? { fallback } : {}),
    ...(level ? { level } : {}),
    ...(tier ? { tier } : {}),
    ...(shrunkWin !== null ? { shrunkWin } : {}),
    ...(shrunkEdge !== null ? { shrunkEdge } : {}),
    ...(edge !== null ? { edge } : {}),
    ...(price ? { price } : {}),
    ...(priceRule ? { priceRule } : {}),
    ...(requiredEdge !== null || v.requiredEdge === null ? { requiredEdge } : {}),
    ...(typeof v.gatePass === "boolean" ? { gatePass: v.gatePass } : {}),
  };
}

function cleanScoring(v: unknown): ScoringTrace | null {
  if (!isObj(v) || !Array.isArray(v.legs)) return null;
  const platformRows = count(v.platformRows, 100_000);
  if (platformRows === null) return null;
  return { platformRows, legs: v.legs.slice(0, MAX_SCORING_LEGS).map(cleanScoringLeg).filter((l): l is ScoringLegTrace => l !== null) };
}

// extras.selection (selection.ts): known modes and triggers, bounded numbers, capped leg lists.
const MAX_SELECTION_LEGS = 50;
const SELECTION_MODE_NAMES = ["BEST", "DIVERSIFIED", "EXPLORE"] as const;
const finite = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
function cleanSelectionLegs(v: unknown): SelectionTraceShape["legs"] {
  if (!Array.isArray(v)) return [];
  const out: SelectionTraceShape["legs"] = [];
  for (const l of v.slice(0, MAX_SELECTION_LEGS)) {
    if (!isObj(l)) continue;
    const id = str(l.id, 64);
    const rank = count(l.rank, 100_000);
    const weight = finite(l.weight, 0, 1);
    if (!id || rank === null || weight === null) continue;
    out.push({ id, rank, weight, ...(l.reused === true ? { reused: true } : {}) });
  }
  return out;
}
function cleanSelection(v: unknown): SelectionTraceShape | null {
  if (!isObj(v)) return null;
  if (v.trigger !== "GENERATE" && v.trigger !== "REGENERATE") return null;
  const mode = SELECTION_MODE_NAMES.find((m) => m === v.mode) ?? null;
  const reuseHits = count(v.reuseHits, 1000);
  if (reuseHits === null) return null;
  const hedge = cleanSelectionLegs(v.hedge);
  const rejectedCombos = count(v.rejectedCombos, 1_000_000);
  const combos = count(v.combos, 10_000_000);
  const repaired = count(v.repaired, 1000);
  return {
    trigger: v.trigger,
    mode,
    beta: finite(v.beta, 0, 100),
    seed: count(v.seed, 4294967295),
    legs: cleanSelectionLegs(v.legs),
    ...(hedge.length > 0 ? { hedge } : {}),
    reuseHits,
    ...(rejectedCombos !== null ? { rejectedCombos } : {}),
    ...(combos !== null ? { combos } : {}),
    ...(v.budgetExhausted === true ? { budgetExhausted: true } : {}),
    ...(v.exhausted === true ? { exhausted: true } : {}),
    ...(repaired !== null ? { repaired } : {}),
  };
}

// A browser's trace as it may be stored, or null when it isn't one. Only a Standard
// or Your-picks run from the browser is accepted (Hybrid runs on the server).
export function sanitizeClientTrace(raw: unknown): RunTrace | null {
  if (!isObj(raw)) return null;
  if (raw.mode !== "STANDARD" && raw.mode !== "YOUR_PICKS") return null;
  if (raw.trigger !== "GENERATE" && raw.trigger !== "REGENERATE") return null;
  if (!Array.isArray(raw.stages) || !Array.isArray(raw.reasons)) return null;

  const stages: RunTrace["stages"] = [];
  for (const s of raw.stages.slice(0, 24)) {
    const c = isObj(s) ? count(s.count) : null;
    if (isObj(s) && typeof s.key === "string" && stageKeys.has(s.key) && c !== null) stages.push({ key: s.key as StageKey, count: c });
  }
  const reasons: RunTrace["reasons"] = [];
  for (const r of raw.reasons.slice(0, 300)) {
    if (!isObj(r)) continue;
    const c = count(r.count);
    const stageOk = r.stage === "SWAP" || (typeof r.stage === "string" && stageKeys.has(r.stage));
    if (stageOk && typeof r.reason === "string" && reasonCodes.has(r.reason) && c !== null) {
      const sub = str(r.sub, 120);
      reasons.push({ stage: r.stage as StageKey | "SWAP", reason: r.reason as ReasonCode, ...(sub ? { sub } : {}), count: c });
    }
  }
  const errors: RunTrace["errors"] = [];
  for (const e of Array.isArray(raw.errors) ? raw.errors.slice(0, 10) : []) {
    if (!isObj(e) || typeof e.code !== "string" || !errorCodes.has(e.code)) continue;
    const message = str(e.message, MAX_ERROR_MESSAGE);
    const where = str(e.where, 40);
    if (message !== null) errors.push({ code: e.code as ErrorCode, message, ...(where ? { where } : {}) });
  }

  const x = isObj(raw.extras) ? raw.extras : {};
  const extras: RunTrace["extras"] = {};
  const builtAt = str(x.snapshotBuiltAt, 40);
  if (builtAt && !Number.isNaN(Date.parse(builtAt))) extras.snapshotBuiltAt = builtAt;
  const ut = count(x.unavailableTargets, 1000);
  if (ut !== null) extras.unavailableTargets = ut;
  const limHave = isObj(x.limited) ? count(x.limited.have, 100) : null;
  const limNeed = isObj(x.limited) ? count(x.limited.need, 100) : null;
  if (limHave !== null && limNeed !== null) extras.limited = { have: limHave, need: limNeed };
  const swaps = cleanSwaps(x.swaps);
  if (swaps.length > 0) extras.swaps = swaps;
  const scoring = cleanScoring(x.scoring);
  if (scoring) extras.scoring = scoring;
  const selection = cleanSelection(x.selection);
  if (selection) extras.selection = selection;

  let detail: RunTrace["detail"] = null;
  let detailTruncated = raw.detailTruncated === true;
  if (isObj(raw.detail) && Array.isArray(raw.detail.picks) && Array.isArray(raw.detail.drops)) {
    const picks: { id: string; label: string }[] = [];
    for (const p of raw.detail.picks.slice(0, MAX_DETAIL_ENTRIES)) {
      const id = isObj(p) ? str(p.id, 64) : null;
      const label = isObj(p) ? str(p.label, MAX_LABEL) : null;
      picks.push({ id: id ?? "", label: label ?? "" });
    }
    const drops: DropEntry[] = [];
    for (const d of raw.detail.drops.slice(0, MAX_DETAIL_ENTRIES)) {
      if (!Array.isArray(d)) continue;
      const [i, stage, reason, sub] = d as unknown[];
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= picks.length) continue;
      if (typeof stage !== "string" || !stageKeys.has(stage) || typeof reason !== "string" || !reasonCodes.has(reason)) continue;
      const s = str(sub, 60);
      drops.push(s ? [i, stage as StageKey, reason as ReasonCode, s] : [i, stage as StageKey, reason as ReasonCode]);
    }
    if (raw.detail.drops.length > MAX_DETAIL_ENTRIES) detailTruncated = true;
    detail = { picks, drops };
  }

  const trace: RunTrace = {
    mode: raw.mode,
    trigger: raw.trigger,
    origin: "CLIENT",
    scoringVersion: str(raw.scoringVersion, 80) ?? "unknown",
    settings: cleanSettings(raw.settings),
    stages,
    reasons,
    errors,
    extras,
    detail,
    detailTruncated,
    failed: raw.failed === true,
    durationMs: count(raw.durationMs, 3_600_000),
  };
  // Over the size cap: keep the funnel, drop the per-pick detail.
  if (detail && JSON.stringify(trace).length > MAX_CLIENT_TRACE_BYTES) {
    trace.detail = null;
    trace.detailTruncated = true;
  }
  return trace;
}
