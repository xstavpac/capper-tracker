// The win-rate gate a generated leg (and a Hedge / Contrarian alternate) must
// clear. 55 is the default; the Generator card lets a user move it. Client-safe
// and import-free: the server (parseRequest), the engine and the card all read
// the same bounds and the same normalizer, so a bad value is 55 everywhere.
export const GATE_DEFAULT = 55;
export const GATE_MIN = 0;
export const GATE_MAX = 75;
export const GATE_STEP = 1;
// Hybrid mode keeps its own coarser grid (its card and request check).
export const HYBRID_GATE_STEP = 5;

// The value if it is a whole step from GATE_MIN..GATE_MAX, else the default.
export function normalizeMinWinPct(x: unknown): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < GATE_MIN || x > GATE_MAX || (x - GATE_MIN) % GATE_STEP !== 0) return GATE_DEFAULT;
  return x;
}

// The note under the control once the gate sits below the default. Empty at 55 and above.
// The Parlay Generator's line under Minimum capper win rate, and the longer version
// behind its info icon (scoring.ts: the in-league record shrunk toward the other
// leagues, then the edge against the price, then the long-shot rule).
export const WIN_RATE_HELP = "Judged on each capper's record in that bet type, weighted toward the same league.";
export const WIN_RATE_HELP_MORE =
  "Every league counts, with this league's picks counting most. The pick also has to beat its price: a 10-10 capper betting +200 underdogs can qualify; 10-10 at −150 won't. A long shot also needs a raw record that clears its own price.";

// The Standard generator's version (record-score.ts): a combined win %, odds out of it.
export const RECORD_WIN_RATE_HELP = "Judged on each capper's record in that bet type, weighted toward the same league, plus their last 20 picks.";
export const RECORD_WIN_RATE_HELP_MORE =
  "Combined win %: the capper's all-time record in the bet type, this league's picks counting most, blended 80/20 with their last 20 picks. Small records are pulled toward 50%. Odds don't affect who qualifies; they only set the payout.";

export function gateRiskNote(value: number): string {
  if (value >= GATE_DEFAULT) return "";
  return ` Under ${GATE_DEFAULT}% means more risk. At 0%, any capper with a graded record in that bet type counts; cappers with no record are still left out.`;
}

// Per-user, best-effort: the card remembers the value apart from the slip.
const STORAGE_PREFIX = "parlay-gate:";

export function readStoredGate(userId: string): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + userId);
    return raw === null ? GATE_DEFAULT : normalizeMinWinPct(Number(raw));
  } catch {
    return GATE_DEFAULT;
  }
}

export function writeStoredGate(userId: string, value: number): void {
  try {
    if (value === GATE_DEFAULT) window.localStorage.removeItem(STORAGE_PREFIX + userId);
    else window.localStorage.setItem(STORAGE_PREFIX + userId, String(value));
  } catch {
    // Storage full or unavailable - the value still holds for this visit.
  }
}
