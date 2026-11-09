// The Parlay Generator's pick-by-pick reveal (presentation only): the timing and
// the status lines for showing a parlay the engine already built, one leg at a
// time. Nothing here chooses, orders or prices a leg - the sequencer walks the
// real `legs` array in its order, and the card prices the legs shown so far with
// combine-odds.ts as it always has.

// The analyzing step lasts at least this long, or until the server answers.
export const ANALYZE_MIN_MS = 1000;
// Per-leg gap: 780ms, shrinking for big parlays so the legs never take more than 6.5s:
// clamp(6500 / N, 260, 780) - 260ms x 25 legs (the cap) is exactly 6.5s.
export const GAP_MAX_MS = 780;
export const GAP_MIN_MS = 260;
export const BUILD_BUDGET_MS = 6500;
// The status line changes this far into a gap (about 55% of it before the leg lands).
export const STATUS_AT = 0.45;
// The odds tween and the leg's landing / highlight fade (the CSS matches these).
export const ODDS_TWEEN_MS = 520;
export const LAND_MS = 340;
export const HIGHLIGHT_FADE_MS = 1900;

export function revealGap(legCount: number): number {
  if (legCount <= 0) return GAP_MAX_MS;
  return Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, BUILD_BUDGET_MS / legCount));
}

export type RevealPhase = "analyzing" | "building" | "complete";

export const ANALYZING_STATUS = "Analyzing eligible picks…";
const MIDDLE_STATUS = ["Finding next pick…", "Checking markets and capper records…", "Scanning remaining games…", "Comparing eligible picks…"];

// What the status line says while finding leg `index` (0-based) of `total`. Generic
// process text only: never a team, a player or a capper.
export function findingStatus(index: number, total: number): string {
  if (index === 0) return "Finding strongest available pick…";
  if (index === total - 1) return "Finding final pick…";
  return MIDDLE_STATUS[(index - 1) % MIDDLE_STATUS.length];
}

// The status line once leg `n` (1-based) is in.
export const addedStatus = (n: number) => `Adding selection ${n} · Calculating combined odds`;

// The PARLAY COMPLETE banner's line. Short of Total legs: says only that many matched.
export function completeText(legs: number, requested: number): string {
  const all = `All ${legs} selection${legs === 1 ? "" : "s"} assembled.`;
  return legs < requested ? `${all} Only ${legs} eligible pick${legs === 1 ? "" : "s"} matched your filters.` : all;
}

// One step of the schedule, in ms after the build (not the analyzing step) starts.
export type RevealStep = { at: number; kind: "status"; index: number } | { at: number; kind: "land"; index: number } | { at: number; kind: "complete" };

// The whole build for `total` legs: the status line before each leg, each leg landing,
// and completion once the last leg has landed and its price has settled.
export function revealSchedule(total: number): RevealStep[] {
  const gap = revealGap(total);
  const steps: RevealStep[] = [];
  for (let i = 0; i < total; i++) {
    steps.push({ at: Math.round(i * gap + gap * STATUS_AT), kind: "status", index: i });
    steps.push({ at: Math.round((i + 1) * gap), kind: "land", index: i });
  }
  steps.push({ at: Math.round(total * gap + Math.max(LAND_MS, ODDS_TWEEN_MS)), kind: "complete" });
  return steps;
}

// Ease-out cubic, for the odds tween.
export const easeOut = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
