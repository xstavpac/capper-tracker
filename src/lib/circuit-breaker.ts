// A minimal circuit breaker for a single upstream dependency (e.g. MLB
// StatsAPI). It sits between our route handlers and an external fetch so that
// a sustained upstream outage stops producing upstream calls entirely, rather
// than every polling client continuing to hammer a dead endpoint for the rest
// of the game.
//
// This is a second, independent layer from the per-game response cache
// (memoizeWithTtl + unstable_cache, ~25s TTL). The cache bounds upstream calls
// to ~1 per 25s per game while things are healthy; the breaker drops that to
// zero once the upstream is clearly down, and holds there through a cooldown
// before letting a single probe through.
//
// States:
//   closed    - normal. Calls pass through. Consecutive failures are counted.
//   open      - too many consecutive failures. Calls are rejected immediately
//               with no upstream request until the cooldown elapses.
//   half-open - cooldown elapsed. The next single call is allowed through as a
//               probe: success closes the breaker, failure re-opens it.

export type BreakerState = "closed" | "open" | "half-open";

export type CircuitBreakerConfig = {
  name: string;
  /** Consecutive failures that trip the breaker from closed -> open. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a probe, ms. */
  cooldownMs: number;
};

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly config: CircuitBreakerConfig;
  private readonly now: () => number;

  constructor(config: CircuitBreakerConfig, now: () => number = Date.now) {
    this.config = {
      name: config.name,
      failureThreshold: Math.max(1, Math.floor(config.failureThreshold)),
      cooldownMs: Math.max(1_000, Math.floor(config.cooldownMs)),
    };
    this.now = now;
  }

  /**
   * Run `fn` through the breaker.
   *
   *  - open (still cooling down): `fn` is NOT called; rejects with a
   *    CircuitOpenError so the caller can fall back to a stale/unavailable
   *    response.
   *  - closed / half-open: `fn` runs. Its success or failure updates state.
   *
   * Only one probe runs at a time in half-open; concurrent callers during a
   * probe are rejected as if open.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const t = this.now();

    if (this.state === "open") {
      if (t - this.openedAt < this.config.cooldownMs) {
        throw new CircuitOpenError(this.config.name, this.retryAfterMs(t));
      }
      this.state = "half-open";
    }

    if (this.state === "half-open") {
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.config.name, this.config.cooldownMs);
      }
      this.probeInFlight = true;
      try {
        const value = await fn();
        this.onSuccess();
        return value;
      } catch (err) {
        this.onFailure();
        throw err;
      } finally {
        this.probeInFlight = false;
      }
    }

    // closed
    try {
      const value = await fn();
      this.onSuccess();
      return value;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** True if a call right now would be rejected without touching the upstream. */
  isOpen(): boolean {
    if (this.state === "closed") return false;
    if (this.state === "half-open") return this.probeInFlight;
    return this.now() - this.openedAt < this.config.cooldownMs;
  }

  get snapshot(): { state: BreakerState; consecutiveFailures: number } {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  private retryAfterMs(t: number): number {
    return Math.max(0, this.config.cooldownMs - (t - this.openedAt));
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(name: string, retryAfterMs: number) {
    super(`circuit "${name}" is open`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}
