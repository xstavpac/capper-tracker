// Bot API tokens, PR 2: create / revoke / list for ONE user. The session-authenticated server actions in
// src/server/actions/api-tokens.ts resolve the user and call these; tests call them with a fixture user id.
//
// Only the SHA-256 hex of a token is stored (see src/lib/api-token-format.ts). The raw token is returned once, from
// createApiTokenForUser, and is never logged.
import { prisma } from "@/lib/prisma";
import { apiTokenPrefix, generateRawToken, hashApiToken } from "@/lib/api-token-format";

export const MAX_ACTIVE_API_TOKENS = 5;
export const API_TOKEN_NAME_MAX = 40;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateApiTokenResult =
  | { ok: true; id: string; name: string; prefix: string; createdAt: Date; rawToken: string }
  | { ok: false; error: "invalid_name" | "token_limit" };

export type RevokeApiTokenResult = { ok: true } | { ok: false; error: "not_found" };

export type ApiTokenListItem = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  picksLast7Days: number;
};

/** Trimmed name if it is 1-40 characters (code points, as VARCHAR(40) counts them), else null. */
export function normalizeApiTokenName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= API_TOKEN_NAME_MAX ? trimmed : null;
}

// At most MAX_ACTIVE_API_TOKENS non-revoked tokens per user. The count and the insert run under a per-user
// transaction-scoped advisory lock, so two creates that arrive together are serialized: the second one sees the
// first one's row and cannot also pass at 4 of 5.
// `afterCount` is a test seam only (it widens the count-to-insert gap so a race without the lock would show).
export async function createApiTokenForUser(
  userId: string,
  name: unknown,
  testHooks: { afterCount?: () => Promise<void> } = {}
): Promise<CreateApiTokenResult> {
  const clean = normalizeApiTokenName(name);
  if (clean === null) return { ok: false, error: "invalid_name" };

  const rawToken = generateRawToken();
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"api-token-create:" + userId}, 0))`;
    const active = await tx.apiToken.count({ where: { userId, revokedAt: null } });
    await testHooks.afterCount?.();
    if (active >= MAX_ACTIVE_API_TOKENS) return null;
    return tx.apiToken.create({
      data: { userId, name: clean, prefix: apiTokenPrefix(rawToken), tokenHash: hashApiToken(rawToken) },
      select: { id: true, name: true, prefix: true, createdAt: true },
    });
  });
  if (!created) return { ok: false, error: "token_limit" };
  return { ok: true, ...created, rawToken };
}

// Sets revokedAt on the caller's own token. Revoking an already revoked token is a no-op (revokedAt keeps its first
// value). Another user's token, or an id that does not exist, is "not_found" - the two are not told apart.
export async function revokeApiTokenForUser(userId: string, id: string): Promise<RevokeApiTokenResult> {
  if (typeof id !== "string" || id.length === 0) return { ok: false, error: "not_found" };
  const { count } = await prisma.apiToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 1) return { ok: true };
  const own = await prisma.apiToken.findFirst({ where: { id, userId }, select: { id: true } });
  return own ? { ok: true } : { ok: false, error: "not_found" };
}

// The user's tokens, active first (newest first), then revoked (most recently revoked first), each with its
// ACCEPTED submissions in the last 7 days. Two statements regardless of the token count: the token list and one
// GROUP BY over api_pick_submissions (served by the (tokenId, createdAt) index).
export async function listApiTokensForUser(userId: string, now: Date = new Date()): Promise<ApiTokenListItem[]> {
  const since = new Date(now.getTime() - SEVEN_DAYS_MS);
  const [tokens, counts] = await Promise.all([
    prisma.apiToken.findMany({
      where: { userId },
      select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
      orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }, { id: "asc" }],
    }),
    prisma.apiPickSubmission.groupBy({
      by: ["tokenId"],
      where: { token: { userId }, status: "ACCEPTED", createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);
  const byToken = new Map(counts.map((c) => [c.tokenId, c._count._all]));
  return tokens.map((t) => ({ ...t, picksLast7Days: byToken.get(t.id) ?? 0 }));
}
