// Proof for circuit-breaker.ts - the upstream cutoff for polling routes.
// Run: npx tsx src/lib/circuit-breaker-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("upstream down"));

async function countUpstreamCalls(fn: () => Promise<unknown>, n: number, breaker: CircuitBreaker) {
  let calls = 0;
  const wrapped = () => {
    calls += 1;
    return fn();
  };
  for (let i = 0; i < n; i++) {
    try {
      await breaker.run(wrapped);
    } catch {
      /* expected while open / failing */
    }
  }
  return calls;
}

async function main() {
// ---- trips open after the threshold, then makes zero upstream calls ----
{
  let t = 0;
  const b = new CircuitBreaker({ name: "mlb", failureThreshold: 4, cooldownMs: 60_000 }, () => t);

  const callsBeforeOpen = await countUpstreamCalls(boom, 4, b);
  check("first 4 failures all hit the upstream", callsBeforeOpen === 4, `calls ${callsBeforeOpen}`);
  check("breaker is open after 4 consecutive failures", b.isOpen(), JSON.stringify(b.snapshot));

  const callsWhileOpen = await countUpstreamCalls(boom, 100, b);
  check("100 calls while open -> 0 upstream requests", callsWhileOpen === 0, `calls ${callsWhileOpen}`);
}

// ---- rejects with CircuitOpenError carrying a retry hint ----
{
  let t = 0;
  const b = new CircuitBreaker({ name: "mlb", failureThreshold: 1, cooldownMs: 30_000 }, () => t);
  await b.run(boom).catch(() => {});
  let caught: unknown;
  await b.run(ok).catch((e) => (caught = e));
  check("open breaker throws CircuitOpenError", caught instanceof CircuitOpenError);
  check(
    "error carries a positive retryAfterMs <= cooldown",
    caught instanceof CircuitOpenError && caught.retryAfterMs > 0 && caught.retryAfterMs <= 30_000,
    caught instanceof CircuitOpenError ? String(caught.retryAfterMs) : "n/a"
  );
}

// ---- half-open probe: success closes, failure re-opens ----
{
  let t = 0;
  const b = new CircuitBreaker({ name: "mlb", failureThreshold: 2, cooldownMs: 10_000 }, () => t);
  await countUpstreamCalls(boom, 2, b);
  check("open before cooldown", b.isOpen());

  t += 10_001; // cooldown elapsed
  check("not counted as open once cooldown elapsed (probe allowed)", !b.isOpen());

  // Probe fails -> back to open.
  await b.run(boom).catch(() => {});
  check("failed probe re-opens the breaker", b.isOpen());

  t += 10_001;
  // Probe succeeds -> closed, and subsequent calls flow.
  const value = await b.run(ok);
  check("successful probe returns the value", value === "ok");
  check("breaker closed after successful probe", b.snapshot.state === "closed");
  const calls = await countUpstreamCalls(ok, 5, b);
  check("closed breaker lets calls through again", calls === 5, `calls ${calls}`);
}

// ---- a single success resets the failure count (no slow creep to open) ----
{
  let t = 0;
  const b = new CircuitBreaker({ name: "mlb", failureThreshold: 3, cooldownMs: 10_000 }, () => t);
  await b.run(boom).catch(() => {});
  await b.run(boom).catch(() => {});
  await b.run(ok); // reset
  await b.run(boom).catch(() => {});
  await b.run(boom).catch(() => {});
  check("2 fail, 1 ok, 2 fail -> still closed", !b.isOpen(), JSON.stringify(b.snapshot));
}

// ---- config clamped ----
{
  const b = new CircuitBreaker({ name: "clamp", failureThreshold: 0, cooldownMs: 1 }, () => 0);
  await b.run(boom).catch(() => {});
  check("failureThreshold floored to 1 -> open after one failure", b.isOpen());
}

  console.log("\n" + "=".repeat(60));
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
