# Live polling safeguards

Prerequisite work for the Momentum Indicator (and any future per-game live
polling feature). Momentum is the first feature that needs **per-game**
polling — an individual poll loop per open game, not one batch call per sport —
so the guardrails against a runaway polling loop were built and reviewed
*before* the feature code.

## The incident this defends against

A previous live play-by-play polling feature (earlier codebase, not in this
repo's git history — searched, not found, so no line-level post-mortem is
possible) once ran up **~76,000 requests in a short window**. The two standard
causes of that shape:

1. **Interval not torn down / stacking loops.** A `setInterval` (or effect)
   that isn't cleared on unmount, or whose effect dependencies change identity
   every render, so each render / navigation starts another concurrent loop on
   top of the old ones.
2. **Uncapped retry-on-failure.** A downed upstream turning every poll tick
   into an immediate full-speed retry, with no backoff and no ceiling.

## What already existed

`live-scoreboard.tsx` and `live-ticker.tsx` both poll with a
`setInterval` + `let cancelled = false` + `clearInterval` on cleanup pattern.
That is correct for **teardown** (cause 1) *as long as* the effect deps stay
stable, but it does **nothing** for cause 2 — the `catch` block just swallows
the error and the next tick fires at full speed — and `setInterval` allows
overlapping in-flight requests if a response outlasts the interval.

So there was a partial pattern, not a safe one. Rather than copy it, the safe
version was extracted into a reusable hook.

## Code-level protections (ship with the code, always on)

### 1. `src/lib/use-safe-poll.ts` — `useSafePoll<T>()`

The only place client-side polling is allowed to be implemented. New polling
features import this; they do not write their own loop.

- **Single instance.** The loop is a self-scheduling `setTimeout` chain, never
  `setInterval`: the next tick is scheduled only *after* the current one fully
  settles, so for one hook instance there is never more than one in-flight
  fetch and ticks cannot pile up behind a slow response. Every effect run gets
  a monotonically increasing **generation id**; a tick whose generation is
  stale exits immediately without fetching or scheduling a successor. Cleanup
  bumps the generation, clears the pending timer, and `abort()`s the in-flight
  fetch. A re-render or React StrictMode double-mount therefore cannot leave a
  second live loop running.
- **Identity-churn resistance.** `fetcher` / `stopWhen` / `timeoutMs` are read
  through refs, not effect dependencies; the backoff config is compared by
  value (`configKey`), not object identity. The effect's dependency array is
  `[enabled, pauseWhenHidden, configKey]` — all primitives — so a parent
  re-render does not rebuild the loop.
- **Backed-off failures.** Delegates to `poll-backoff.ts` (below). A failure
  never retries on the base interval; after `maxConsecutiveFailures` (default
  5) the loop **stops permanently** (`stopped: true`), surfaced to the user as
  "signal unavailable — reload to retry".
- **Visibility-gated.** While `document.visibilityState === "hidden"` the loop
  makes no fetches; it resumes with backoff reset when the tab is shown.
- **Caller stop signal.** `stopWhen(data) === true` (e.g. game went final)
  ends the loop for good for that mount — no further fetches, ever.

Integration/behaviour of the hook itself (effects, timers, visibility) needs
manual verification in-browser when the first consumer lands — the pure
decision logic it delegates to is unit-tested, the React shell is not.

### 2. `src/lib/poll-backoff.ts` — pure scheduling math

Split out so the logic where a request storm actually originates is exercised
directly by `poll-backoff-acceptance-test.ts` with a controllable clock.

- `normalizeBackoffConfig` clamps hostile input: interval floored to **1000 ms**
  (no config can produce a sub-second loop), failure ceiling to `[1, 100]`,
  `maxBackoffMs` never below the base interval, everything capped at 1 hour.
- `nextPollDelayMs`: success → exactly the base interval; Nth consecutive
  failure → `base * 2^N` capped at `maxBackoffMs` (default 5 min), then ±20%
  jitter so a fleet that all failed at once doesn't retry in lockstep. A 429
  `Retry-After` is honoured as a floor.
- `shouldStopPolling`: true on a caller stop signal or at the failure ceiling.

Test asserts: no failure count, for thousands of samples, ever yields a delay
below 1 s; backoff is monotonic to the cap; jitter stays within ±20%.

### 3. `src/lib/rate-limit.ts` — server-side hard ceiling

`RateLimiter` — dependency-free, in-memory **fixed-window** limiter for API
route handlers. Even if every client-side safeguard is defeated by a bug, a
route that calls `.check(key)` cannot process more than `limit` requests per
`windowMs` for that key; denials return a 429 with `Retry-After` via
`rateLimitResponse()`.

The momentum endpoint (when built) will enforce three keys, each its own
limiter instance:

| Key | Limit (proposed) | Guards against |
|---|---|---|
| `userId + gamePk` | 12 / 60s | one client's loop for one game going runaway (legit rate is 2/min) |
| `userId` | 40 / 60s | one client opening many game tabs |
| route-global (per instance) | 500 / 60s | anything else — the physical backstop |

**Honest limitation:** state is per serverless instance, not global, so the
true ceiling is `(instances × limit)`. Under Vercel Fluid compute a warm
instance handles many consecutive requests from one client, so a per-instance
cap still throttles a runaway client hard — but the **global** backstop is the
platform-level Firewall rule (below), not this. The map is swept of expired
buckets every call and hard-capped at 20,000 keys; if it fills with live
buckets the limiter **fails closed** (denies with a 5 s cooldown), because the
condition that fills it is exactly "far too many distinct requests".

No Redis/KV dependency was added: the threat is our own polling bug, not an
adversary, and a distributed limiter is a larger commitment than that warrants.

### 4. `src/lib/circuit-breaker.ts` — upstream cutoff

`CircuitBreaker` sits between our route handlers and the MLB StatsAPI fetch.
Independent of the per-game response cache (`memoizeWithTtl` +
`unstable_cache`, ~25 s TTL): the cache bounds upstream calls to ~1 per 25 s
per game while healthy; the breaker drops that to **zero** once the upstream is
clearly down.

- `closed` → after `failureThreshold` (proposed 4) consecutive failures →
  `open`.
- `open` → calls rejected immediately with `CircuitOpenError` (carrying a
  `retryAfterMs`), **no upstream request**, for `cooldownMs` (proposed 60 s).
- `half-open` → one probe call allowed; success closes, failure re-opens. Only
  one probe at a time.

The momentum data module will catch `CircuitOpenError` and serve the last
good payload marked `stale` (or `momentum: null` if there is none) — never a
fabricated value.

### 5. Logging / alerting

- **Per-upstream-fetch line** (already in the proposal):
  `[momentum] upstream {gamePk, ms, seriesLen, ok}` — one per *real* MLB call.
- **Per-minute rollup line** (new, added to the plan): a module-level counter
  emits `[momentum] rate {windowStart, requests, servedFromCache,
  upstreamFetches, rateLimited429, breakerOpen}` once per 60 s. A runaway is
  then one filter away in Vercel logs:
  `vercel logs --environment production --json --query "[momentum] rate"` —
  `requests` far above `upstreamFetches` and climbing is the signature.
- **Vercel alert rule** (platform, see below): threshold on request count for
  the momentum route.

## Platform-level protections (protect even against an app-code bug)

Checked on the `capper-tracker` project under the `stavros-analysis` team
(Vercel Pro) via the Vercel CLI, 2026-09-08.

### What Vercel Pro actually offers

| Capability | Available? | State now | How it's set |
|---|---|---|---|
| **Firewall custom rules with `rate_limit` action** | Yes (WAF, Pro) | **Not configured** — `Firewall: Not configured`, 0 custom rules | `vercel firewall rules add … && vercel firewall publish`, or dashboard → Firewall |
| Firewall: fixed-window or token-bucket, key by `ip` / `ja4` / header, window 10–3600 s, action deny/challenge for 1m–1h | Yes | — | as above |
| **System DDoS mitigations** | Yes, automatic | **Active** (always-on, not configurable) | n/a |
| **Attack Challenge Mode** (challenge every request) | Yes | Off | `vercel firewall attack-mode`, or dashboard — emergency lever only |
| **Usage-anomaly alerts** (built-in ML alerts on `function_invocations`, `edge_requests`, `fluid_cpu_duration`, `fast_data_transfer`) | Yes | One team-wide **"Default Alert Rule"** exists (`severity in ('medium','high')`); no metric-specific rule | `vercel alerts rules add --body <json>`, or dashboard → Observability → Alerts |
| **Custom Observability metric alerts** (threshold on `incomingRequest` count, grouped by route, 5 m granularity) | Yes | None configured | `vercel alerts rules add` with a `custom_alert` body |
| **Spend management / hard spending cap** (pause project at $X) | Yes (Pro) | **Unknown — not readable via CLI.** `vercel usage` shows current spend only (~$0 billed this period; all within plan allowances) | **Dashboard only:** Settings → Billing → Spend Management. Requires your action. |
| Per-function `maxDuration` / concurrency caps | Yes (in code / `vercel.json`) | defaults | code change |

### What needs your action (dashboard)

1. **Publish the Firewall rate-limit rule.** Staged command (review the
   threshold, then run — `add` stages a draft, `publish` makes it live):

   ```
   vercel firewall rules add "rate-limit-live-api" \
     --action rate_limit \
     --rate-limit-requests 100 --rate-limit-window 60 \
     --rate-limit-keys ip --rate-limit-algo token_bucket \
     --rate-limit-action deny --duration 15m \
     --condition '{"type":"path","op":"pre","value":"/api/live/"}' \
     --description "Defense-in-depth cap on per-IP rate to the live polling API" \
     --yes
   vercel firewall publish
   ```

   Scope note: this covers the whole `/api/live/` namespace, including the
   existing, working `/api/live/scores` endpoint. 100 req/IP/60 s is far above
   any legitimate use (a client polling every 25 s from several tabs, or a
   whole office behind one NAT IP, stays well under it) but comfortably below a
   runaway (hundreds/sec). Runs at the **edge, before the function invokes**,
   so it also protects function-invocation spend, not just the upstream.
   *(An automated agent cannot publish production firewall rules; this is
   yours to run or do in the dashboard.)*

2. **Set a spend cap / alert.** Dashboard → Settings → Billing → Spend
   Management. Set a monthly amount that trips an email (and optionally pauses
   the project). Current spend is ~$0 billed, so even a low cap ($20–50) is
   pure headroom and would catch a sustained runaway within hours. Not
   settable via CLI — needs you.

3. **Add a request-count alert on the momentum route** (once the route exists
   and its path is final). Dashboard → Observability → Alerts → custom alert:
   `incomingRequest` count, filter `route` = `/api/live/momentum`, threshold
   e.g. `> 3000 per 5 min`, notify owners. Or CLI:
   `vercel alerts rules add --body ./momentum-alert.json` (schema:
   `vercel alerts rules schema --type custom_alert`).

### MLB StatsAPI (upstream)

- Unauthenticated, no API key, **no published rate limit, no usage
  dashboard, no alerting available to consumers.** Our only visibility is our
  own logs.
- It *is* Fastly-fronted and its responses declare
  `Cache-Control: max-age=10, stale-while-revalidate=30, stale-if-error=86400`
  — so rapid repeat calls hit Fastly's edge cache rather than MLB origin, and
  Fastly will serve a stale copy for up to a day on origin error. A helpful
  natural buffer, but not something we control or can rely on.
- Our protection for this dependency is entirely our own: the ~25 s per-game
  response cache, the circuit breaker, and the per-minute rollup log.

## Protection summary — what lives where

| Layer | Control | Enforced by | Limit | Global? |
|---|---|---|---|---|
| Client | one loop per game, torn down on unmount | `useSafePoll` generation guard | 1 in-flight fetch / hook instance | per browser tab |
| Client | failure backoff + ceiling | `poll-backoff.ts` | 30 s → 60 → 120 … cap 5 min; stop after 5 fails | per browser tab |
| Client | pause when tab hidden | `useSafePoll` | 0 fetches while hidden | per browser tab |
| **Server (code)** | per-user+game request cap | `rate-limit.ts` | 12 / 60 s (proposed) | per instance |
| **Server (code)** | per-user request cap | `rate-limit.ts` | 40 / 60 s (proposed) | per instance |
| **Server (code)** | route-global request cap | `rate-limit.ts` | 500 / 60 s (proposed) | per instance |
| **Server (code)** | upstream cutoff on outage | `circuit-breaker.ts` | 0 upstream calls when open, 60 s cooldown | per instance |
| **Server (code)** | upstream call rate when healthy | `memoizeWithTtl` + `unstable_cache` | ~1 MLB call / 25 s / game | global (Vercel Data Cache) |
| **Platform (edge)** | per-IP rate limit | Vercel Firewall rule | 100 / 60 s per IP (**pending publish**) | global, pre-invocation |
| **Platform** | DDoS mitigation | Vercel system | automatic | global |
| **Platform** | usage anomaly / cost alert | Vercel alerts + Spend Management | **pending your dashboard setup** | account-wide |
| Upstream | MLB StatsAPI edge cache | Fastly (not ours) | 10 s edge TTL, stale-if-error 24 h | n/a |

The honest gap: between "client backoff" and "platform Firewall rule", the
code-level rate limiter is **per-instance, not global**. Until the Firewall
rule is published, a runaway distributed across many warm instances could
exceed `500 × instanceCount` req/min briefly before anomaly alerting fires.
The circuit breaker and the per-game cache still cap *upstream* (MLB) calls
regardless. Publishing the Firewall rule closes that gap at the edge.
