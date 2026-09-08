// Proof for rate-limit.ts - the server-side hard ceiling for polling routes.
// Run: npx tsx src/lib/rate-limit-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { RateLimiter, rateLimitResponse } from "./rate-limit";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- allows up to the limit, then denies within the window ----
{
  let t = 1_000_000;
  const rl = new RateLimiter({ name: "test", limit: 5, windowMs: 60_000 }, () => t);

  const results = Array.from({ length: 7 }, () => rl.check("user:1"));
  check("first 5 allowed", results.slice(0, 5).every((r) => r.ok));
  check("6th and 7th denied", !results[5].ok && !results[6].ok);
  check(
    "denied result carries a positive Retry-After",
    !results[5].ok && results[5].retryAfterSeconds > 0 && results[5].retryAfterSeconds <= 60,
    JSON.stringify(results[5])
  );
}

// ---- window resets ----
{
  let t = 0;
  const rl = new RateLimiter({ name: "test", limit: 2, windowMs: 10_000 }, () => t);
  rl.check("k");
  rl.check("k");
  check("3rd within window denied", !rl.check("k").ok);
  t += 10_001;
  check("allowed again after the window elapses", rl.check("k").ok);
}

// ---- keys are independent ----
{
  let t = 0;
  const rl = new RateLimiter({ name: "test", limit: 1, windowMs: 10_000 }, () => t);
  check("key A first call allowed", rl.check("A").ok);
  check("key A second call denied", !rl.check("A").ok);
  check("key B unaffected by key A", rl.check("B").ok);
}

// ---- a sustained storm from one key never gets through mid-window ----
{
  let t = 0;
  const rl = new RateLimiter({ name: "storm", limit: 10, windowMs: 60_000 }, () => t);
  let allowed = 0;
  // 10,000 requests in the same instant, as a runaway client would produce.
  for (let i = 0; i < 10_000; i++) {
    if (rl.check("runaway").ok) allowed++;
    t += 1; // 1ms apart - still 10s total, well inside the 60s window
  }
  check("10k rapid requests -> only 10 allowed", allowed === 10, `allowed ${allowed}`);
}

// ---- expired buckets are swept so the map stays bounded ----
{
  let t = 0;
  const rl = new RateLimiter({ name: "sweep", limit: 1, windowMs: 1_000 }, () => t);
  for (let i = 0; i < 500; i++) {
    rl.check("key-" + i);
    t += 10;
  }
  // By now the earliest ~400 buckets have expired (windowMs=1000, 10ms apart).
  check("map is swept, not unbounded", rl.trackedKeys < 200, `trackedKeys ${rl.trackedKeys}`);
}

// ---- config is clamped ----
{
  const rl = new RateLimiter({ name: "clamp", limit: 0, windowMs: 1 }, () => 0);
  check("limit floored to 1 (first call allowed)", rl.check("x").ok);
  check("limit floored to 1 (second call denied)", !rl.check("x").ok);
}

// ---- rateLimitResponse shape ----
{
  const res = rateLimitResponse(42);
  check("status 429", res.status === 429);
  check("Retry-After header set", res.headers.get("retry-after") === "42");
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
