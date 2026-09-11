// A dependency-free, in-memory fixed-window rate limiter for API route
// handlers. This is the server-side hard ceiling: even if every client-side
// safeguard in use-safe-poll.ts is defeated by a bug, a route that calls
// enforceRateLimit() cannot process more than `limit` requests per `windowMs`
// for a given key.
//
// Scope and honest limitations:
//
//  - State is per serverless instance (a module-level Map), not global. Under
//    Vercel's Fluid compute a warm instance handles many consecutive requests
//    from the same client, so a per-instance cap still throttles a runaway
//    client hard in practice - but the true global ceiling is
//    (instances * limit). The platform-level Vercel Firewall rate-limit rule
//    is the global backstop; this is the always-on, deploy-with-the-code one.
//  - No external store (Redis/KV) on purpose: this app has no such dependency
//    and adding one for this would be a larger commitment than the threat
//    (our own polling bug) warrants. Revisit if a distributed limiter is
//    needed for something adversarial.
//
// The map is swept of expired buckets on every call and hard-capped at
// MAX_TRACKED_KEYS; if it somehow fills with live buckets the limiter fails
// CLOSED (denies) rather than open, because the situation it protects against
// is precisely "far too many distinct requests".

type Bucket = { count: number; resetAt: number };

const MAX_TRACKED_KEYS = 20_000;

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

export type RateLimitRule = {
  /** Stable identifier for this limiter (used only for logging/debugging). */
  name: string;
  /** Max requests allowed per window for one key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/**
 * A self-contained limiter with its own bucket map. Each distinct limit an
 * endpoint enforces (per-user+game, per-user, per-instance-global) gets its
 * own instance so their windows and key spaces never collide.
 *
 * `now` is injectable for deterministic tests.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rule: RateLimitRule;
  private readonly now: () => number;

  constructor(rule: RateLimitRule, now: () => number = Date.now) {
    this.rule = {
      name: rule.name,
      limit: Math.max(1, Math.floor(rule.limit)),
      windowMs: Math.max(1_000, Math.floor(rule.windowMs)),
    };
    this.now = now;
  }

  /**
   * Record one request against `key` and report whether it is allowed. Call
   * exactly once per request, before doing any real work.
   */
  check(key: string): RateLimitResult {
    const t = this.now();
    this.sweep(t);

    if (this.buckets.size >= MAX_TRACKED_KEYS && !this.buckets.has(key)) {
      // Fail closed - see file header. A short, fixed cooldown so a legitimate
      // client recovers quickly once the surge (which is what fills the map)
      // subsides.
      return { ok: false, retryAfterSeconds: 5 };
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + this.rule.windowMs });
      return { ok: true, remaining: this.rule.limit - 1 };
    }

    if (existing.count >= this.rule.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - t) / 1000)) };
    }

    existing.count += 1;
    return { ok: true, remaining: this.rule.limit - existing.count };
  }

  /** Test/debug visibility only. */
  get trackedKeys(): number {
    return this.buckets.size;
  }

  private sweep(t: number): void {
    // Cheap unconditional sweep: buckets are short-lived (windowMs), so the
    // map stays small under normal load and this loop is trivial. Under a
    // surge it's the only thing keeping the map bounded.
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= t) this.buckets.delete(k);
    }
  }
}

/**
 * Turn a denied result into the 429 Response an API route should return.
 * Centralised so every rate-limited endpoint answers identically (status,
 * Retry-After header, body shape) - the client hook keys its backoff off this.
 */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}
