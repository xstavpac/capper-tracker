// The win-rate gate a generated leg (and a Hedge / Contrarian alternate) must
// clear. 55 is the default; the Generator card lets a user move it. Client-safe
// and import-free: the server (parseRequest), the engine and the card all read
// the same bounds and the same normalizer, so a bad value is 55 everywhere.
export const GATE_DEFAULT = 55;
export const GATE_MIN = 45;
export const GATE_MAX = 75;
export const GATE_STEP = 5;

// The value if it is a whole step from GATE_MIN..GATE_MAX, else the default.
export function normalizeMinWinPct(x: unknown): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < GATE_MIN || x > GATE_MAX || (x - GATE_MIN) % GATE_STEP !== 0) return GATE_DEFAULT;
  return x;
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
