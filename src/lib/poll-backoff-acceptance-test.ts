// Proof for poll-backoff.ts - the scheduling math behind use-safe-poll.ts.
// Run: npx tsx src/lib/poll-backoff-acceptance-test.ts
// Exits non-zero if any assertion fails.
//
// The point of these assertions: no input can produce a sub-second delay, no
// failure streak retries at full speed, and the loop always stops after the
// configured ceiling.

import {
  normalizeBackoffConfig,
  shouldStopPolling,
  nextPollDelayMs,
  DEFAULT_POLL_BACKOFF,
  type PollBackoffConfig,
} from "./poll-backoff";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const cfg: PollBackoffConfig = normalizeBackoffConfig({
  baseIntervalMs: 30_000,
  maxBackoffMs: 300_000,
  maxConsecutiveFailures: 5,
});

// ---- normalizeBackoffConfig clamps hostile input ----
{
  const n = normalizeBackoffConfig({ baseIntervalMs: 0, maxBackoffMs: -1, maxConsecutiveFailures: -3 });
  check("zero interval is clamped up to >= 1000ms", n.baseIntervalMs >= 1_000, `got ${n.baseIntervalMs}`);
  check("maxBackoff never below base", n.maxBackoffMs >= n.baseIntervalMs, `got ${n.maxBackoffMs}`);
  check("failure ceiling clamped to >= 1", n.maxConsecutiveFailures >= 1, `got ${n.maxConsecutiveFailures}`);

  const huge = normalizeBackoffConfig({ baseIntervalMs: 9e9, maxConsecutiveFailures: 9e9 });
  check("absurd interval clamped to <= 1h", huge.baseIntervalMs <= 3_600_000, `got ${huge.baseIntervalMs}`);
  check("absurd failure ceiling clamped to <= 100", huge.maxConsecutiveFailures <= 100, `got ${huge.maxConsecutiveFailures}`);

  const missing = normalizeBackoffConfig({});
  check(
    "empty config falls back to defaults",
    missing.baseIntervalMs === DEFAULT_POLL_BACKOFF.baseIntervalMs &&
      missing.maxConsecutiveFailures === DEFAULT_POLL_BACKOFF.maxConsecutiveFailures
  );
}

// ---- success case: always exactly the base interval ----
{
  const d = nextPollDelayMs({ consecutiveFailures: 0, config: cfg });
  check("success -> base interval, no jitter", d === 30_000, `got ${d}`);
}

// ---- failures back off exponentially, never below base, capped ----
{
  // rand fixed at 0.5 -> jitter factor exactly 1.0, so we can assert the raw curve.
  const rand = () => 0.5;
  const d1 = nextPollDelayMs({ consecutiveFailures: 1, config: cfg, rand });
  const d2 = nextPollDelayMs({ consecutiveFailures: 2, config: cfg, rand });
  const d3 = nextPollDelayMs({ consecutiveFailures: 3, config: cfg, rand });
  const d10 = nextPollDelayMs({ consecutiveFailures: 10, config: cfg, rand });

  check("1 failure -> 60s", d1 === 60_000, `got ${d1}`);
  check("2 failures -> 120s", d2 === 120_000, `got ${d2}`);
  check("3 failures -> 240s", d3 === 240_000, `got ${d3}`);
  check("10 failures -> capped at maxBackoff (300s)", d10 === 300_000, `got ${d10}`);
  check("backoff is monotonic up to the cap", d1 < d2 && d2 < d3 && d3 <= d10);
}

// ---- jitter stays within +/-20% and never breaches the cap or floor ----
{
  let minSeen = Infinity;
  let maxSeen = -Infinity;
  for (let i = 0; i < 5000; i++) {
    const d = nextPollDelayMs({ consecutiveFailures: 2, config: cfg }); // ideal 120s
    minSeen = Math.min(minSeen, d);
    maxSeen = Math.max(maxSeen, d);
  }
  check("jittered delay >= 80% of ideal", minSeen >= 120_000 * 0.8 - 1, `min ${minSeen}`);
  check("jittered delay <= 120% of ideal", maxSeen <= 120_000 * 1.2 + 1, `max ${maxSeen}`);

  // Every delay for any failure count must clear a hard 1s floor - this is the
  // property that makes a request storm impossible no matter the state.
  let everSubSecond = false;
  for (let f = 0; f <= 25; f++) {
    for (let i = 0; i < 200; i++) {
      if (nextPollDelayMs({ consecutiveFailures: f, config: cfg }) < 1_000) everSubSecond = true;
    }
  }
  check("no failure count ever yields a sub-1s delay", !everSubSecond);
}

// ---- 429 Retry-After acts as a floor ----
{
  const rand = () => 0.5;
  const d = nextPollDelayMs({ consecutiveFailures: 1, config: cfg, retryAfterMs: 200_000, rand });
  check("Retry-After (200s) overrides a smaller backoff (60s)", d === 200_000, `got ${d}`);

  const d2 = nextPollDelayMs({ consecutiveFailures: 4, config: cfg, retryAfterMs: 5_000, rand });
  check("Retry-After below current backoff is ignored", d2 === 300_000, `got ${d2}`);

  const dCap = nextPollDelayMs({ consecutiveFailures: 0, config: cfg, retryAfterMs: 9_999_999, rand });
  check("Retry-After above maxBackoff is capped", dCap === 300_000, `got ${dCap}`);
}

// ---- shouldStopPolling ----
{
  check("stops when stop requested", shouldStopPolling({ consecutiveFailures: 0, stopRequested: true, config: cfg }));
  check(
    "stops at the failure ceiling",
    shouldStopPolling({ consecutiveFailures: 5, stopRequested: false, config: cfg })
  );
  check(
    "keeps going below the ceiling",
    !shouldStopPolling({ consecutiveFailures: 4, stopRequested: false, config: cfg })
  );
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
