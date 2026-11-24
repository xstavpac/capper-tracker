// Bot API tokens, PR 1 (schema only): the migration 20261124120000_add_api_tokens, checked against a LOCAL migrated
// database.
//   - ingest_batches: a batch written exactly as the Telegram ingest writes it (no sourceType) is TELEGRAM; the
//     (channelId, messageId) duplicate rule still holds; every existing row is TELEGRAM with both keys set.
//   - ingest_batches_source_check: TELEGRAM needs channelId + messageId, API_TOKEN needs sourceKey.
//   - api_tokens / api_pick_submissions / screenshot_read_usage: the unique keys, the 40-char name, RLS on.
//   - deleting a user removes their tokens and submissions and keeps the token batch (tokenId set to null).
// Writes fixtures under throwaway users and deletes them by id. Run with:
//   npx tsx src/server/data/api-tokens-schema-acceptance-test.ts   (DATABASE_URL must be localhost)
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

// The Postgres error a refused write raised: a Prisma known-request code, or the raw SQLSTATE for a CHECK violation
// (Prisma has no code of its own for that).
async function refusal(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "accepted";
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = err.meta as { code?: string } | undefined;
      return err.code === "P2010" || err.code === "P2004" ? `sqlstate:${meta?.code ?? "?"}` : err.code;
    }
    const m = err instanceof Error ? err.message : String(err);
    if (/ingest_batches_source_check/.test(m)) return "check:ingest_batches_source_check";
    return "error:" + m.slice(0, 120);
  }
}

const PREFIX = "__ApiTokSchema__";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("DATABASE_URL must point at a local database");

  const userIds = [PREFIX + "u1", PREFIX + "u2"];
  const channel = PREFIX + "chan";
  const batchIds: string[] = [];

  // Leftovers from an interrupted run: looked up first, then deleted by id only.
  const leftover = await prisma.ingestBatch.findMany({
    where: { OR: [{ channelId: channel }, { sourceKey: { startsWith: PREFIX } }] },
    select: { id: true },
  });
  if (leftover.length > 0) await prisma.ingestBatch.deleteMany({ where: { id: { in: leftover.map((b) => b.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  try {
    for (const id of userIds) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });

    // ---- ingest_batches: the Telegram write is unchanged ----
    const tg = await prisma.ingestBatch.create({
      data: { channelId: channel, messageId: 1, day: "2026-11-24", text: "Alpha\nLakers -3 -110" },
      select: { id: true, sourceType: true, tokenId: true, sourceKey: true },
    });
    batchIds.push(tg.id);
    expect("a batch written as the Telegram ingest writes it is TELEGRAM, no token, no sourceKey", [tg.sourceType, tg.tokenId, tg.sourceKey], ["TELEGRAM", null, null]);
    expect(
      "re-writing the same (channelId, messageId) is still a duplicate (P2002)",
      await refusal(() => prisma.ingestBatch.create({ data: { channelId: channel, messageId: 1, day: "2026-11-24", text: "x" } })),
      "P2002"
    );
    const found = await prisma.ingestBatch.findUnique({ where: { channelId_messageId: { channelId: channel, messageId: 1 } }, select: { id: true } });
    expect("findUnique by (channelId, messageId) still finds the Telegram batch", found?.id, tg.id);

    // Every row that existed before the migration: backfilled to TELEGRAM, both keys set (so the CHECK holds).
    const [legacy] = await prisma.$queryRaw<{ bad: bigint }[]>`
      SELECT count(*) AS bad FROM "ingest_batches"
      WHERE "sourceType" = 'TELEGRAM' AND ("channelId" IS NULL OR "messageId" IS NULL)`;
    expect("no TELEGRAM batch is missing channelId or messageId", Number(legacy.bad), 0);
    const [constraint] = await prisma.$queryRaw<{ validated: boolean }[]>`
      SELECT convalidated AS validated FROM pg_constraint WHERE conname = 'ingest_batches_source_check'`;
    expect("ingest_batches_source_check exists and is validated against every row", constraint?.validated, true);

    // ---- the CHECK ----
    expect(
      "TELEGRAM without channelId is refused",
      await refusal(() => prisma.ingestBatch.create({ data: { messageId: 2, day: "2026-11-24", text: "x" } })),
      "check:ingest_batches_source_check"
    );
    expect(
      "TELEGRAM without messageId is refused",
      await refusal(() => prisma.ingestBatch.create({ data: { channelId: channel, day: "2026-11-24", text: "x" } })),
      "check:ingest_batches_source_check"
    );

    // ---- api_tokens ----
    const hash = (n: number) => (PREFIX + n).padEnd(64, "0");
    const token = await prisma.apiToken.create({
      data: { userId: userIds[0], name: "Five Star bot", prefix: "bv_live_7Kq2", tokenHash: hash(1) },
      select: { id: true, windowCount: true, lastUsedAt: true, revokedAt: true },
    });
    expect("a new token starts with an empty window, never used, not revoked", [token.windowCount, token.lastUsedAt, token.revokedAt], [0, null, null]);
    expect(
      "tokenHash is unique (P2002)",
      await refusal(() => prisma.apiToken.create({ data: { userId: userIds[1], name: "other", prefix: "bv_live_7Kq2", tokenHash: hash(1) } })),
      "P2002"
    );
    expect(
      "a 41-character name is refused by the column",
      await refusal(() => prisma.apiToken.create({ data: { userId: userIds[0], name: "n".repeat(41), prefix: "bv_live_abcd", tokenHash: hash(2) } })),
      "P2000"
    );
    const forty = await prisma.apiToken.create({ data: { userId: userIds[0], name: "n".repeat(40), prefix: "bv_live_abcd", tokenHash: hash(3) }, select: { id: true } });
    expect("a 40-character name is accepted", typeof forty.id, "string");

    // ---- API_TOKEN batches ----
    expect(
      "API_TOKEN without sourceKey is refused",
      await refusal(() => prisma.ingestBatch.create({ data: { sourceType: "API_TOKEN", tokenId: token.id, day: "2026-11-24", text: "x" } })),
      "check:ingest_batches_source_check"
    );
    const apiBatch = await prisma.ingestBatch.create({
      data: { sourceType: "API_TOKEN", tokenId: token.id, sourceKey: `${PREFIX}tok:${token.id}:r1`, day: "2026-11-24", text: "Five Star\nLakers -3" },
      select: { id: true, channelId: true, messageId: true },
    });
    batchIds.push(apiBatch.id);
    expect("an API_TOKEN batch has no channelId / messageId", [apiBatch.channelId, apiBatch.messageId], [null, null]);
    const apiBatch2 = await prisma.ingestBatch.create({
      data: { sourceType: "API_TOKEN", tokenId: token.id, sourceKey: `${PREFIX}tok:${token.id}:r2`, day: "2026-11-24", text: "x" },
      select: { id: true },
    });
    batchIds.push(apiBatch2.id);
    expect("a second API_TOKEN batch (both keys null) does not collide on (channelId, messageId)", typeof apiBatch2.id, "string");
    expect(
      "sourceKey is unique (P2002)",
      await refusal(() => prisma.ingestBatch.create({ data: { sourceType: "API_TOKEN", tokenId: token.id, sourceKey: `${PREFIX}tok:${token.id}:r1`, day: "2026-11-24", text: "x" } })),
      "P2002"
    );

    // ---- api_pick_submissions ----
    const sub = await prisma.apiPickSubmission.create({
      data: { tokenId: token.id, clientId: "c-1", status: "ACCEPTED", batchId: apiBatch.id, result: { status: "accepted" } },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    expect("a submission row is written", typeof sub.id, "string");
    expect(
      "(tokenId, clientId) is unique (P2002)",
      await refusal(() => prisma.apiPickSubmission.create({ data: { tokenId: token.id, clientId: "c-1", status: "REJECTED", batchId: apiBatch2.id, result: {} } })),
      "P2002"
    );
    const otherToken = await prisma.apiToken.create({ data: { userId: userIds[1], name: "u2 bot", prefix: "bv_live_wxyz", tokenHash: hash(4) }, select: { id: true } });
    const otherBatch = await prisma.ingestBatch.create({
      data: { sourceType: "API_TOKEN", tokenId: otherToken.id, sourceKey: `${PREFIX}tok:${otherToken.id}:r1`, day: "2026-11-24", text: "x" },
      select: { id: true },
    });
    batchIds.push(otherBatch.id);
    const sameClientOtherToken = await prisma.apiPickSubmission.create({
      data: { tokenId: otherToken.id, clientId: "c-1", status: "NEEDS_REVIEW", batchId: otherBatch.id, result: {} },
      select: { id: true },
    });
    expect("the same client_id under another token is a separate submission", typeof sameClientOtherToken.id, "string");
    for (const status of ["REJECTED", "DISMISSED"] as const) {
      const r = await prisma.apiPickSubmission.update({ where: { tokenId_clientId: { tokenId: token.id, clientId: "c-1" } }, data: { status }, select: { status: true } });
      expect(`status can move to ${status} (resend reprocesses it in a later PR)`, r.status, status);
    }

    // ---- screenshot_read_usage ----
    await prisma.screenshotReadUsage.create({ data: { userId: userIds[0], day: "2026-11-24", count: 1 } });
    expect(
      "(userId, day) is the primary key (P2002)",
      await refusal(() => prisma.screenshotReadUsage.create({ data: { userId: userIds[0], day: "2026-11-24" } })),
      "P2002"
    );
    const nextDay = await prisma.screenshotReadUsage.create({ data: { userId: userIds[0], day: "2026-11-25" }, select: { count: true } });
    expect("a new day starts at 0", nextDay.count, 0);

    // ---- RLS on, no policies ----
    const rls = await prisma.$queryRaw<{ relname: string; on: boolean; policies: bigint }[]>`
      SELECT c.relname, c.relrowsecurity AS on,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('api_tokens', 'api_pick_submissions', 'screenshot_read_usage')
      ORDER BY c.relname`;
    expect(
      "RLS on with no policies for the three new tables",
      rls.map((r) => [r.relname, r.on, Number(r.policies)]),
      [["api_pick_submissions", true, 0], ["api_tokens", true, 0], ["screenshot_read_usage", true, 0]]
    );

    // ---- deleting a user ----
    // Cascades to api_tokens, then to api_pick_submissions; the token's batches stay, with tokenId set to null. The
    // CHECK must not refuse that SET NULL, or deleting any user with a token batch would fail.
    await prisma.user.delete({ where: { id: userIds[0] } });
    expect("the user's tokens are deleted", await prisma.apiToken.count({ where: { userId: userIds[0] } }), 0);
    expect("the token's submissions are deleted", await prisma.apiPickSubmission.count({ where: { tokenId: token.id } }), 0);
    expect("the user's screenshot counts are deleted", await prisma.screenshotReadUsage.count({ where: { userId: userIds[0] } }), 0);
    const kept = await prisma.ingestBatch.findUnique({ where: { id: apiBatch.id }, select: { sourceType: true, tokenId: true, sourceKey: true } });
    expect("the token batch is kept, tokenId set to null, sourceKey intact", [kept?.sourceType, kept?.tokenId, kept?.sourceKey], ["API_TOKEN", null, `${PREFIX}tok:${token.id}:r1`]);
    expect("the other user's token and submission are untouched", await prisma.apiPickSubmission.count({ where: { tokenId: otherToken.id } }), 1);

    // Deleting a batch removes its submissions.
    await prisma.ingestBatch.delete({ where: { id: otherBatch.id } });
    expect("deleting a batch deletes its submissions", await prisma.apiPickSubmission.count({ where: { batchId: otherBatch.id } }), 0);
  } finally {
    await prisma.ingestBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
