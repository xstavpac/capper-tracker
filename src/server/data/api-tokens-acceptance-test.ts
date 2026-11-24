// Bot API tokens, PR 2: create / revoke / list (src/server/data/api-tokens.ts) against a LOCAL migrated database.
//   - create: name trimmed, 1-40 characters; only the hash is stored; raw token returned once
//   - at most 5 active tokens per user, also when creates race (the per-user advisory lock)
//   - revoke: owner only, twice is a no-op, frees a slot
//   - list: active first then revoked; ACCEPTED submissions in the last 7 days per token, in one GROUP BY
// Writes fixtures under throwaway users and deletes them by id. Run with:
//   npx tsx src/server/data/api-tokens-acceptance-test.ts   (DATABASE_URL must be localhost)
import { prisma } from "@/lib/prisma";
import { hashApiToken } from "@/lib/api-token-format";
import { createApiTokenForUser, listApiTokensForUser, normalizeApiTokenName, revokeApiTokenForUser } from "./api-tokens";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const PREFIX = "__ApiTokActions__";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("DATABASE_URL must point at a local database");

  const [u1, u2, u3] = [PREFIX + "u1", PREFIX + "u2", PREFIX + "u3"];
  const userIds = [u1, u2, u3];
  const sourceKeyPrefix = PREFIX + "batch:";
  const cleanup = async () => {
    const batches = await prisma.ingestBatch.findMany({ where: { sourceKey: { startsWith: sourceKeyPrefix } }, select: { id: true } });
    if (batches.length > 0) await prisma.ingestBatch.deleteMany({ where: { id: { in: batches.map((b) => b.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  };
  await cleanup();

  try {
    for (const id of userIds) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });

    // ---- names ----
    expect("name is trimmed", normalizeApiTokenName("  My bot  "), "My bot");
    expect("empty / whitespace-only name refused", [normalizeApiTokenName(""), normalizeApiTokenName("   ")], [null, null]);
    expect("40 characters allowed, 41 refused", [normalizeApiTokenName("x".repeat(40)), normalizeApiTokenName("x".repeat(41))], ["x".repeat(40), null]);
    expect("40 emoji (code points) allowed", normalizeApiTokenName("🤖".repeat(40)) !== null, true);
    expect("non-string refused", normalizeApiTokenName(42), null);
    expect("create with a 41-character name -> invalid_name", await createApiTokenForUser(u1, "y".repeat(41)), { ok: false, error: "invalid_name" });

    // ---- create ----
    const first = await createApiTokenForUser(u1, "  Discord bot ");
    if (!first.ok) throw new Error("first create failed");
    expect("create returns the trimmed name", first.name, "Discord bot");
    expect("create returns bv_live_ prefix of the raw token", [first.prefix.length, first.rawToken.startsWith(first.prefix)], [12, true]);
    const stored = await prisma.apiToken.findUnique({ where: { id: first.id }, select: { tokenHash: true, prefix: true, userId: true } });
    expect("stored tokenHash is the SHA-256 of the raw token", stored?.tokenHash, hashApiToken(first.rawToken));
    expect("stored row never holds the raw token", JSON.stringify(stored).includes(first.rawToken), false);
    expect("stored under the creating user", stored?.userId, u1);

    // ---- the 5-active limit ----
    for (let i = 2; i <= 5; i++) await createApiTokenForUser(u1, `bot ${i}`);
    expect("6th active token -> token_limit", await createApiTokenForUser(u1, "bot 6"), { ok: false, error: "token_limit" });
    expect("still exactly 5 rows", await prisma.apiToken.count({ where: { userId: u1 } }), 5);

    // ---- revoke ----
    expect("another user cannot revoke u1's token -> not_found", await revokeApiTokenForUser(u2, first.id), { ok: false, error: "not_found" });
    expect("...and it is still active", (await prisma.apiToken.findUnique({ where: { id: first.id }, select: { revokedAt: true } }))?.revokedAt, null);
    expect("unknown id -> not_found", await revokeApiTokenForUser(u1, PREFIX + "nope"), { ok: false, error: "not_found" });
    expect("owner revokes", await revokeApiTokenForUser(u1, first.id), { ok: true });
    const revokedAt1 = (await prisma.apiToken.findUnique({ where: { id: first.id }, select: { revokedAt: true } }))?.revokedAt;
    expect("revokedAt is set", revokedAt1 instanceof Date, true);
    await new Promise((r) => setTimeout(r, 15));
    expect("revoking twice is ok", await revokeApiTokenForUser(u1, first.id), { ok: true });
    const revokedAt2 = (await prisma.apiToken.findUnique({ where: { id: first.id }, select: { revokedAt: true } }))?.revokedAt;
    expect("...and a no-op (revokedAt unchanged)", revokedAt2?.getTime(), revokedAt1?.getTime());
    const sixth = await createApiTokenForUser(u1, "bot 6");
    expect("a revoke frees a slot: the 6th row is created (5 active)", [sixth.ok, await prisma.apiToken.count({ where: { userId: u1, revokedAt: null } })], [true, 5]);

    // ---- concurrent creates: separate connections, so the advisory lock is what serializes them ----
    // u2 at 4 active: two simultaneous creates must not both pass.
    for (let i = 1; i <= 4; i++) await createApiTokenForUser(u2, `u2 bot ${i}`);
    // The shared client's pool has several connections, so these run in parallel on separate sessions.
    {
      // afterCount holds each transaction open between its count and its insert: without the lock both would count 4.
      const slow = { afterCount: () => new Promise<void>((r) => setTimeout(r, 200)) };
      const raced = await Promise.all([createApiTokenForUser(u2, "race a", slow), createApiTokenForUser(u2, "race b", slow)]);
      expect("4 active + 2 racing creates: exactly one succeeds", raced.filter((r) => r.ok).length, 1);
      expect("...and the other gets token_limit", raced.filter((r) => !r.ok).map((r) => (r as { error: string }).error), ["token_limit"]);
      expect("u2 ends with exactly 5 active", await prisma.apiToken.count({ where: { userId: u2, revokedAt: null } }), 5);

      // Eight racing creates from 0 of 5 (u3); the pool has several connections, so they really run in parallel.
      const quick = { afterCount: () => new Promise<void>((r) => setTimeout(r, 60)) };
      const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => createApiTokenForUser(u3, `burst ${i}`, quick)));
      expect("0 active + 8 racing creates: exactly 5 succeed", burst.filter((r) => r.ok).length, 5);
      expect("u3 ends with exactly 5 active", await prisma.apiToken.count({ where: { userId: u3, revokedAt: null } }), 5);
    }

    // ---- list ----
    const now = new Date();
    const u1Tokens = await prisma.apiToken.findMany({ where: { userId: u1 }, select: { id: true, name: true } });
    const byName = new Map(u1Tokens.map((t) => [t.name, t.id]));
    const bot2 = byName.get("bot 2")!;
    const bot3 = byName.get("bot 3")!;
    const batch = await prisma.ingestBatch.create({
      data: { sourceType: "API_TOKEN", tokenId: bot2, sourceKey: sourceKeyPrefix + "1", day: "2026-11-24", text: "x" },
      select: { id: true },
    });
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const subs: { tokenId: string; status: "ACCEPTED" | "NEEDS_REVIEW" | "REJECTED" | "DISMISSED"; createdAt: Date }[] = [
      { tokenId: bot2, status: "ACCEPTED", createdAt: daysAgo(0) },
      { tokenId: bot2, status: "ACCEPTED", createdAt: daysAgo(3) },
      { tokenId: bot2, status: "ACCEPTED", createdAt: daysAgo(6.9) },
      { tokenId: bot2, status: "ACCEPTED", createdAt: daysAgo(7.1) }, // outside 7 days
      { tokenId: bot2, status: "NEEDS_REVIEW", createdAt: daysAgo(1) }, // not ACCEPTED
      { tokenId: bot2, status: "REJECTED", createdAt: daysAgo(1) },
      { tokenId: bot3, status: "ACCEPTED", createdAt: daysAgo(2) },
      { tokenId: first.id, status: "ACCEPTED", createdAt: daysAgo(1) }, // revoked token still counts its history
    ];
    let n = 0;
    for (const s of subs) {
      await prisma.apiPickSubmission.create({ data: { ...s, clientId: `${PREFIX}c${n++}`, batchId: batch.id, result: {} } });
    }
    // u2's submissions must not leak into u1's counts.
    const u2Token = (await prisma.apiToken.findFirst({ where: { userId: u2 }, select: { id: true } }))!.id;
    await prisma.apiPickSubmission.create({ data: { tokenId: u2Token, clientId: PREFIX + "u2c", status: "ACCEPTED", batchId: batch.id, result: {} } });

    // A second revoked token, revoked later than `first`, to pin revoked ordering.
    await new Promise((r) => setTimeout(r, 15));
    await revokeApiTokenForUser(u1, bot3);

    const list = await listApiTokensForUser(u1, now);
    expect("list has all 6 of u1's tokens", list.length, 6);
    const activeCount = list.filter((t) => t.revokedAt === null).length;
    expect("active tokens come first", list.slice(0, activeCount).every((t) => t.revokedAt === null) && list.slice(activeCount).every((t) => t.revokedAt !== null), true);
    expect("active tokens newest first", list.slice(0, activeCount).map((t) => t.name), ["bot 6", "bot 5", "bot 4", "bot 2"]);
    expect("revoked tokens most recently revoked first", list.slice(activeCount).map((t) => t.name), ["bot 3", "Discord bot"]);
    const counts = Object.fromEntries(list.map((t) => [t.name, t.picksLast7Days]));
    expect("7-day ACCEPTED counts per token", counts, { "bot 6": 0, "bot 5": 0, "bot 4": 0, "bot 2": 3, "bot 3": 1, "Discord bot": 1 });
    expect(
      "list items carry exactly the display fields (no hash)",
      Object.keys(list[0]).sort(),
      ["createdAt", "id", "lastUsedAt", "name", "picksLast7Days", "prefix", "revokedAt"]
    );
    const u1Ids = new Set(list.map((t) => t.id));
    const u2List = await listApiTokensForUser(u2, now);
    expect("u2's list: its own 5 tokens, none of u1's", [u2List.length, u2List.some((t) => u1Ids.has(t.id))], [5, false]);
    expect("u2's 7-day counts: only its own submission", u2List.map((t) => t.picksLast7Days).reduce((a, b) => a + b, 0), 1);
  } finally {
    await cleanup();
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
