// Bot API tokens, PR 2: authenticateBearer (src/server/api-bearer-auth.ts) against a LOCAL migrated database.
//   - valid token -> { ok, tokenId, userId }, lastUsedAt stamped
//   - revoked / unknown / malformed / missing -> 401 {error:"invalid_token"}
//   - the 61st request in a minute -> 429 {error:"rate_limited", retryAfterSeconds}; the window resets after the minute
//   - failed attempts are limited per IP in memory: once over, refused before any DB statement; malformed never
//     reaches the DB; exactly one statement per authenticated request
// Writes fixtures under a throwaway user and deletes it by id. Run with:
//   npx tsx src/server/api-bearer-auth-acceptance-test.ts   (DATABASE_URL must be localhost)
import { prisma } from "@/lib/prisma";
import { generateRawToken } from "@/lib/api-token-format";
import { RateLimiter } from "@/lib/rate-limit";
import { createApiTokenForUser, revokeApiTokenForUser } from "@/server/data/api-tokens";
import { API_TOKEN_REQUESTS_PER_MINUTE, BEARER_FAILURES_PER_IP_PER_MINUTE, authenticateBearer, type BearerAuthResult } from "./api-bearer-auth";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const PREFIX = "__ApiBearerAuth__";

function req(authorization: string | null, ip = "203.0.113.7"): Request {
  const headers = new Headers({ "x-real-ip": ip });
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request("https://example.invalid/api/v1/picks", { method: "POST", headers });
}

// A db that counts statements and forwards them to the real client.
function countingDb(): { n: number; db: { $queryRaw: typeof prisma.$queryRaw } } {
  const counter = { n: 0, db: { $queryRaw: prisma.$queryRaw } };
  counter.db.$queryRaw = ((...args: Parameters<typeof prisma.$queryRaw>) => {
    counter.n += 1;
    return prisma.$queryRaw(...args);
  }) as typeof prisma.$queryRaw;
  return counter;
}

async function outcome(r: BearerAuthResult): Promise<unknown> {
  if (r.ok) return { ok: true };
  return { status: r.response.status, body: await r.response.json(), retryAfter: r.response.headers.get("retry-after") };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("DATABASE_URL must point at a local database");

  const userId = PREFIX + "u1";
  await prisma.user.deleteMany({ where: { id: { in: [userId] } } });

  try {
    await prisma.user.create({ data: { id: userId, supabaseId: userId + "-sb", email: userId + "@example.invalid" } });
    const created = await createApiTokenForUser(userId, "auth test");
    const revoked = await createApiTokenForUser(userId, "revoked");
    if (!created.ok || !revoked.ok) throw new Error("fixture create failed");
    await revokeApiTokenForUser(userId, revoked.id);

    // Generous failure limiter for the functional checks; the limiter itself is tested below.
    const lenient = () => new RateLimiter({ name: "t", limit: 1000, windowMs: 60_000 });
    const t0 = new Date(Date.now() + 3_600_000); // later than the row's default windowStart, so the first call resets it

    // ---- valid ----
    const c = countingDb();
    const ok = await authenticateBearer(req(`Bearer ${created.rawToken}`), { now: t0, failureLimiter: lenient(), db: c.db });
    expect("valid token -> ok with tokenId and userId", ok, { ok: true, tokenId: created.id, userId });
    expect("one DB statement for an authenticated request", c.n, 1);
    const row = await prisma.apiToken.findUnique({ where: { id: created.id }, select: { lastUsedAt: true, windowStart: true, windowCount: true } });
    expect("lastUsedAt stamped with the request time", row?.lastUsedAt?.getTime(), t0.getTime());
    expect("a stale window resets: windowStart = now, windowCount = 1", [row?.windowStart.getTime(), row?.windowCount], [t0.getTime(), 1]);

    // ---- 401s ----
    const invalid = { status: 401, body: { error: "invalid_token" }, retryAfter: null };
    expect("revoked token -> 401 invalid_token", await outcome(await authenticateBearer(req(`Bearer ${revoked.rawToken}`), { now: t0, failureLimiter: lenient() })), invalid);
    expect("unknown token -> 401 invalid_token", await outcome(await authenticateBearer(req(`Bearer ${generateRawToken()}`), { now: t0, failureLimiter: lenient() })), invalid);
    const m = countingDb();
    for (const h of [null, "", "Bearer", `Basic ${created.rawToken}`, `Bearer ${created.rawToken.slice(0, -1)}`, `Bearer bv_test_${created.rawToken.slice(8)}`]) {
      expect(`malformed ${JSON.stringify(h)} -> 401 invalid_token`, await outcome(await authenticateBearer(req(h), { now: t0, failureLimiter: lenient(), db: m.db })), invalid);
    }
    expect("malformed / missing headers never reach the DB", m.n, 0);
    const revokedRow = await prisma.apiToken.findUnique({ where: { id: revoked.id }, select: { lastUsedAt: true, windowCount: true } });
    expect("a revoked token's row is not touched", [revokedRow?.lastUsedAt, revokedRow?.windowCount], [null, 0]);
    const r401 = await authenticateBearer(req(null), { failureLimiter: lenient() });
    expect("401 carries WWW-Authenticate: Bearer", !r401.ok && r401.response.headers.get("www-authenticate")?.startsWith("Bearer"), true);

    // ---- the per-token minute window: requests 2..60 pass, the 61st is 429 ----
    let lastOk = true;
    for (let i = 2; i <= API_TOKEN_REQUESTS_PER_MINUTE; i++) {
      const at = new Date(t0.getTime() + i * 100);
      lastOk = (await authenticateBearer(req(`Bearer ${created.rawToken}`), { now: at, failureLimiter: lenient() })).ok && lastOk;
    }
    expect(`requests 1..${API_TOKEN_REQUESTS_PER_MINUTE} in one minute all pass`, lastOk, true);
    const at61 = new Date(t0.getTime() + 30_000);
    expect(
      "the 61st request in the minute -> 429 rate_limited, retry after the window's remaining 30 s",
      await outcome(await authenticateBearer(req(`Bearer ${created.rawToken}`), { now: at61, failureLimiter: lenient() })),
      { status: 429, body: { error: "rate_limited", retryAfterSeconds: 30 }, retryAfter: "30" }
    );
    const at62 = new Date(t0.getTime() + 59_500);
    expect(
      "still 429 at 59.5 s, retry after 1 s",
      await outcome(await authenticateBearer(req(`Bearer ${created.rawToken}`), { now: at62, failureLimiter: lenient() })),
      { status: 429, body: { error: "rate_limited", retryAfterSeconds: 1 }, retryAfter: "1" }
    );
    const atReset = new Date(t0.getTime() + 60_000);
    const reset = await authenticateBearer(req(`Bearer ${created.rawToken}`), { now: atReset, failureLimiter: lenient() });
    expect("once the minute has passed the window resets and the request passes", reset.ok, true);
    const afterReset = await prisma.apiToken.findUnique({ where: { id: created.id }, select: { windowStart: true, windowCount: true } });
    expect("...windowStart = that request's time, windowCount = 1", [afterReset?.windowStart.getTime(), afterReset?.windowCount], [atReset.getTime(), 1]);

    // ---- per-IP failure limiter: guessing never costs a DB write ----
    {
      const limiter = new RateLimiter({ name: "t-fail", limit: BEARER_FAILURES_PER_IP_PER_MINUTE, windowMs: 60_000 });
      const g = countingDb();
      const ip = "198.51.100.9";
      for (let i = 0; i < BEARER_FAILURES_PER_IP_PER_MINUTE; i++) {
        await authenticateBearer(req(`Bearer ${generateRawToken()}`, ip), { failureLimiter: limiter, db: g.db });
      }
      expect(`${BEARER_FAILURES_PER_IP_PER_MINUTE} unknown-token guesses each ran one statement`, g.n, BEARER_FAILURES_PER_IP_PER_MINUTE);
      const before = g.n;
      const blocked = await authenticateBearer(req(`Bearer ${generateRawToken()}`, ip), { failureLimiter: limiter, db: g.db });
      const o = (await outcome(blocked)) as { status: number; body: { error: string } };
      expect("the next attempt from that IP -> 429 rate_limited", [o.status, o.body.error], [429, "rate_limited"]);
      const blockedValid = await authenticateBearer(req(`Bearer ${created.rawToken}`, ip), { failureLimiter: limiter, db: g.db });
      expect("...even with a valid token while the IP is blocked", blockedValid.ok, false);
      expect("blocked attempts run no DB statement", g.n, before);
      const otherIp = await authenticateBearer(req(`Bearer ${created.rawToken}`, "192.0.2.1"), { failureLimiter: limiter, db: g.db });
      expect("another IP is unaffected", otherIp.ok, true);
      const successes = new RateLimiter({ name: "t-ok", limit: 2, windowMs: 60_000 });
      for (let i = 0; i < 5; i++) await authenticateBearer(req(`Bearer ${created.rawToken}`, "192.0.2.2"), { failureLimiter: successes });
      expect("successful requests do not count as failures", successes.peek("192.0.2.2").ok, true);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [userId] } } });
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
    process.exit(failures > 0 ? 1 : 0);
  });
