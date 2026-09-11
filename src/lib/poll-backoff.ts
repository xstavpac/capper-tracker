// Pure scheduling math for the safe client-side polling hook (use-safe-poll.ts).
//
// Split out from the hook itself for the same reason buildGamePulsePanelRows
// is split from getGamePulsePanelRows: the decision logic - "how long until
// the next poll, and should we stop entirely" - is where the bugs that cause a
// request storm live, so it needs to be exercised directly by an acceptance
// test with a controllable clock rather than only through a React effect.
//
// The failure this exists to prevent: a downed upstream turning every poll
// tick into an immediate full-speed retry (the classic uncapped
// retry-on-failure loop). Every path here either backs off or stops.

export type PollBackoffConfig = {
  /** Delay between polls when the last attempt succeeded, ms. */
  baseIntervalMs: number;
  /** Upper bound on any computed delay, ms - backoff never exceeds this. */
  maxBackoffMs: number;
  /**
   * Consecutive failures after which polling stops permanently (the loop
   * gives up rather than retrying forever). The consumer surfaces this as a
   * "signal unavailable" state; a full reload restarts it.
   */
  maxConsecutiveFailures: number;
};

export const DEFAULT_POLL_BACKOFF: PollBackoffConfig = {
  baseIntervalMs: 30_000,
  maxBackoffMs: 5 * 60_000,
  maxConsecutiveFailures: 5,
};

/**
 * Clamp a caller-supplied config into sane bounds. A misconfigured hook (a
 * zero interval, a negative failure ceiling) must never be able to produce a
 * tight loop, so this is applied before any other function here is used.
 */
export function normalizeBackoffConfig(partial: Partial<PollBackoffConfig>): PollBackoffConfig {
  const baseIntervalMs = clampNumber(partial.baseIntervalMs, DEFAULT_POLL_BACKOFF.baseIntervalMs, 1_000, 3_600_000);
  const maxBackoffMs = clampNumber(
    partial.maxBackoffMs,
    DEFAULT_POLL_BACKOFF.maxBackoffMs,
    baseIntervalMs,
    3_600_000
  );
  const maxConsecutiveFailures = Math.round(
    clampNumber(partial.maxConsecutiveFailures, DEFAULT_POLL_BACKOFF.maxConsecutiveFailures, 1, 100)
  );
  return { baseIntervalMs, maxBackoffMs, maxConsecutiveFailures };
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * True once the loop must stop scheduling any further polls: either the
 * consumer signalled it (game went final) or the failure ceiling was hit.
 */
export function shouldStopPolling(args: {
  consecutiveFailures: number;
  stopRequested: boolean;
  config: PollBackoffConfig;
}): boolean {
  if (args.stopRequested) return true;
  return args.consecutiveFailures >= args.config.maxConsecutiveFailures;
}

/**
 * Milliseconds to wait before the next poll.
 *
 *  - success (consecutiveFailures === 0)  -> baseIntervalMs
 *  - Nth consecutive failure              -> baseIntervalMs * 2^N, capped at
 *    maxBackoffMs, then +/- up to 20% jitter so a fleet of clients that all
 *    failed against the same upstream at the same moment don't retry in
 *    lockstep.
 *
 * `retryAfterMs`, when provided (from a 429 Retry-After header), is treated as
 * a floor: we wait at least that long regardless of where exponential backoff
 * currently sits, but jitter and the max cap still apply.
 *
 * `rand` is injectable for deterministic tests; defaults to Math.random.
 */
export function nextPollDelayMs(args: {
  consecutiveFailures: number;
  config: PollBackoffConfig;
  retryAfterMs?: number | null;
  rand?: () => number;
}): number {
  const { config } = args;
  const rand = args.rand ?? Math.random;
  const failures = Math.max(0, Math.floor(args.consecutiveFailures));

  if (failures === 0 && !args.retryAfterMs) {
    return config.baseIntervalMs;
  }

  // 2^failures grows fast; Math.min against the cap before the multiply keeps
  // it from overflowing to Infinity for a large failure count.
  const exponential =
    failures === 0
      ? config.baseIntervalMs
      : Math.min(config.maxBackoffMs, config.baseIntervalMs * 2 ** Math.min(failures, 20));

  const floor = args.retryAfterMs && args.retryAfterMs > 0 ? args.retryAfterMs : 0;
  const base = Math.min(config.maxBackoffMs, Math.max(exponential, floor));

  // +/-20% jitter.
  const jitterFactor = 0.8 + rand() * 0.4;
  return Math.min(config.maxBackoffMs, Math.round(base * jitterFactor));
}
