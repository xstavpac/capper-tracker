// Bot API tokens: bearer authentication + the per-token rate limit, for POST /api/v1/picks (PR 4).
//
//   const auth = await authenticateBearer(request);
//   if (!auth.ok) return auth.response;     // 401 {error:"invalid_token"} or 429 {error:"rate_limited", retryAfterSeconds}
//   auth.tokenId, auth.userId
//
// One DB round-trip per request: a single UPDATE finds the token by hash (non-revoked only), advances its fixed
// one-minute window (reset to 1 when the minute has passed, else +1) and stamps lastUsedAt, RETURNING what the
// caller needs. More than API_TOKEN_REQUESTS_PER_MINUTE in a window is a 429.
//
// Guessing: failed attempts (missing, malformed, unknown or revoked token) are counted per client IP in an in-memory
// RateLimiter (src/lib/rate-limit.ts). An IP over that limit is refused BEFORE any DB work, and a malformed header
// never reaches the DB at all, so token guessing does not turn into DB writes. Per-instance memory, like every
// RateLimiter here; the Vercel Firewall is the global backstop.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashApiToken, parseBearerToken } from "@/lib/api-token-format";
import { RateLimiter, rateLimitResponse } from "@/lib/rate-limit";

export const API_TOKEN_REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
export const BEARER_FAILURES_PER_IP_PER_MINUTE = 20;

const defaultFailureLimiter = new RateLimiter({
  name: "api-bearer-failures-per-ip",
  limit: BEARER_FAILURES_PER_IP_PER_MINUTE,
  windowMs: WINDOW_MS,
});

export type BearerAuthResult = { ok: true; tokenId: string; userId: string } | { ok: false; response: Response };

type RawDb = { $queryRaw: typeof prisma.$queryRaw };

export type BearerAuthOptions = {
  /** Tests pin these; production passes none. */
  now?: Date;
  failureLimiter?: RateLimiter;
  db?: RawDb;
};

export function invalidTokenResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
  });
}

/** The caller's IP for the failure limiter: Vercel's x-real-ip, else the first x-forwarded-for hop. */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

/**
 * The single statement: authenticate (hash match, not revoked), apply the fixed window, stamp lastUsedAt. `now` and
 * `windowCutoff` (now - 1 minute) come from the app clock so tests can step time.
 *
 * The columns are TIMESTAMP(3) holding UTC wall-clock time (how Prisma writes DateTime). A JS Date binds as
 * timestamptz, which Postgres would convert using the session TimeZone; `AT TIME ZONE 'UTC'` pins the conversion so
 * the statement is right whatever the session's zone (prod is UTC; a local dev server may not be).
 */
export function bearerAuthUpdate(tokenHash: string, now: Date): Prisma.Sql {
  const nowUtc = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
  const windowCutoff = Prisma.sql`(${new Date(now.getTime() - WINDOW_MS)}::timestamptz AT TIME ZONE 'UTC')`;
  return Prisma.sql`
    UPDATE api_tokens SET
      "windowStart" = CASE WHEN "windowStart" <= ${windowCutoff} THEN ${nowUtc} ELSE "windowStart" END,
      "windowCount" = CASE WHEN "windowStart" <= ${windowCutoff} THEN 1 ELSE "windowCount" + 1 END,
      "lastUsedAt"  = ${nowUtc}
    WHERE "tokenHash" = ${tokenHash} AND "revokedAt" IS NULL
    RETURNING id, "userId", "windowCount", "windowStart"`;
}

export async function authenticateBearer(request: Request, opts: BearerAuthOptions = {}): Promise<BearerAuthResult> {
  const failures = opts.failureLimiter ?? defaultFailureLimiter;
  const ip = clientIp(request);

  const blocked = failures.peek(ip);
  if (!blocked.ok) return { ok: false, response: rateLimitResponse(blocked.retryAfterSeconds) };

  const rawToken = parseBearerToken(request.headers.get("authorization"));
  if (!rawToken) {
    failures.check(ip);
    return { ok: false, response: invalidTokenResponse() };
  }

  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const rows = await db.$queryRaw<{ id: string; userId: string; windowCount: number; windowStart: Date }[]>(
    bearerAuthUpdate(hashApiToken(rawToken), now)
  );
  const row = rows[0];
  if (!row) {
    failures.check(ip);
    return { ok: false, response: invalidTokenResponse() };
  }

  if (row.windowCount > API_TOKEN_REQUESTS_PER_MINUTE) {
    const retryAfterSeconds = Math.max(1, Math.ceil((row.windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000));
    return { ok: false, response: rateLimitResponse(retryAfterSeconds) };
  }
  return { ok: true, tokenId: row.id, userId: row.userId };
}
