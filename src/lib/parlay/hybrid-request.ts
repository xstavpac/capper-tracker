// Consensus Hybrid's request, validated. The browser sends league scope, targeted
// games, Include Picks and the hybrid settings; nothing about a pick, a game, a
// price or a ladder comes from it. Bad input comes back as a ParlayRejection
// (returned, not thrown: a production build strips a thrown error's message).
// Pure and client-safe.
import { GATE_DEFAULT, GATE_MAX, GATE_MIN, GATE_STEP } from "@/lib/parlay/gate";
import { hasUsablePrice } from "@/lib/parlay/combine-odds";
import { HYBRID_MAX_LEGS, HYBRID_MIN_LEG_PRICE, type HybridWidth } from "@/lib/parlay/hybrid";
import { selectedCategories, toIncludeSelection, type IncludeSelection } from "@/lib/parlay/include-picks";
import { MAX_POOL_REQUEST_PICKS, type ParlayRejection } from "@/lib/parlay/leg-cap";

export type HybridGenerateSettings = {
  // American odds, targetMin <= targetMax (-140 .. -110).
  targetMin: number;
  targetMax: number;
  width: HybridWidth;
  perLegRange: { min: number; max: number } | null;
  maxLegs: number;
  // The win-% gate (gate.ts, #327): 45-75 in steps of 5, default 55.
  minWinPct: number;
};

export type HybridGenerateRequest = {
  leagues: string[];
  targets: { gameId: string; leagueName: string }[];
  include: IncludeSelection;
  settings: HybridGenerateSettings;
};

const MAX_ID_LENGTH = 64;
const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const reject = (error: string): ParlayRejection => ({ error });

export const HYBRID_INVALID_REQUEST = "That request isn't valid - refresh the page and try again.";

function price(v: unknown): number | null {
  return typeof v === "number" && hasUsablePrice(v) && Math.abs(v) <= 100000 ? v : null;
}

// `liveLabels`: the league labels the Live board carries (LIVE_SPORTS).
export function parseHybridRequest(raw: unknown, liveLabels: ReadonlySet<string>): HybridGenerateRequest | ParlayRejection {
  if (typeof raw !== "object" || raw === null) return reject(HYBRID_INVALID_REQUEST);
  const { leagues, targets, include, settings } = raw as Record<string, unknown>;
  if (!Array.isArray(leagues) || !leagues.every((l) => typeof l === "string" && liveLabels.has(l))) return reject(HYBRID_INVALID_REQUEST);
  if (!Array.isArray(targets)) return reject(HYBRID_INVALID_REQUEST);
  if (targets.length > MAX_POOL_REQUEST_PICKS) return reject(`Too many games in one request - ${MAX_POOL_REQUEST_PICKS} at most.`);
  const parsedTargets: HybridGenerateRequest["targets"] = [];
  for (const t of targets) {
    if (typeof t !== "object" || t === null) return reject(HYBRID_INVALID_REQUEST);
    const { gameId, leagueName } = t as Record<string, unknown>;
    if (!okId(gameId) || typeof leagueName !== "string" || !liveLabels.has(leagueName)) return reject(HYBRID_INVALID_REQUEST);
    if (!parsedTargets.some((p) => p.gameId === gameId)) parsedTargets.push({ gameId, leagueName });
  }
  const uniqueLeagues = Array.from(new Set(leagues as string[]));
  if (uniqueLeagues.length === 0 && parsedTargets.length === 0) return reject("Pick at least one league or game.");

  // Moneyline / Spread / Totals only: props are not part of a hybrid.
  const selection = toIncludeSelection(include);
  const markets = selectedCategories(selection).filter((c) => c !== "PROPS");
  if (markets.length === 0) return reject("Consensus Hybrid uses Moneyline, Spread and Totals picks - include at least one of them.");
  const cleanInclude: IncludeSelection = selection === "ALL" ? "ALL" : markets;

  if (typeof settings !== "object" || settings === null) return reject(HYBRID_INVALID_REQUEST);
  const s = settings as Record<string, unknown>;
  const targetMin = price(s.targetMin);
  const targetMax = price(s.targetMax);
  if (targetMin === null || targetMax === null) return reject("The target odds must be American odds like -140 or +120.");
  if (targetMin > targetMax) return reject(`The target range is backwards: ${targetMin} is higher than ${targetMax}. Put the longer price second (e.g. -140 to -110).`);

  if (s.width !== "balanced" && s.width !== "wider") return reject("Width must be \"balanced\" or \"wider\".");

  const maxLegs = s.maxLegs;
  if (typeof maxLegs !== "number" || !Number.isInteger(maxLegs) || maxLegs < 2 || maxLegs > HYBRID_MAX_LEGS) {
    return reject(`Legs must be a whole number from 2 to ${HYBRID_MAX_LEGS}.`);
  }

  let minWinPct = GATE_DEFAULT;
  if (s.minWinPct !== undefined && s.minWinPct !== null) {
    const g = s.minWinPct;
    if (typeof g !== "number" || !Number.isInteger(g) || g < GATE_MIN || g > GATE_MAX || (g - GATE_MIN) % GATE_STEP !== 0) {
      return reject(`The win-% gate must be ${GATE_MIN} to ${GATE_MAX} in steps of ${GATE_STEP}.`);
    }
    minWinPct = g;
  }

  let perLegRange: HybridGenerateSettings["perLegRange"] = null;
  if (s.perLegRange !== undefined && s.perLegRange !== null) {
    if (typeof s.perLegRange !== "object") return reject(HYBRID_INVALID_REQUEST);
    const min = price((s.perLegRange as Record<string, unknown>).min);
    const max = price((s.perLegRange as Record<string, unknown>).max);
    if (min === null || max === null) return reject("The per-leg price range must be American odds like -300 or +150.");
    if (min > max) return reject(`The per-leg range is backwards: ${min} is higher than ${max}.`);
    // Every leg is priced at or above the floor already; a range wholly below it admits nothing.
    if (max < HYBRID_MIN_LEG_PRICE) return reject(`No leg is priced shorter than ${HYBRID_MIN_LEG_PRICE}, so a per-leg range ending at ${max} can't match anything.`);
    perLegRange = { min, max };
  }

  return {
    leagues: uniqueLeagues,
    targets: parsedTargets,
    include: cleanInclude,
    settings: { targetMin, targetMax, width: s.width, perLegRange, maxLegs, minWinPct },
  };
}
