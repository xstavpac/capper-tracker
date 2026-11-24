// Bot API tokens PR 6, the query half: getPendingReviewCards against a LOCAL database. Each card carries where its
// item came from (Telegram, a named token, "API token" once the token is revoked or deleted) and its time, from one
// LEFT JOIN each on ingest_batches / api_tokens: still one row per card. Ambiguous-team choices carry only their
// stored game's two short team names, which side the choice's team is, and the start time; no stored pick, and
// nothing for a choice with no game or for another question type. Run with:
//   npx tsx src/server/data/review-queue-source-acceptance-test.ts   (DATABASE_URL must be localhost)
export {};

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const PREFIX = "__ReviewSource__";
const KICKOFF = "2026-11-26T17:30:00.000Z"; // Thu 12:30 PM in New York
const storedPick = (homeTeam: string, awayTeam: string) => ({
  capperName: "Five Star",
  sportName: "NFL",
  homeTeam,
  awayTeam,
  betType: "MONEYLINE",
  odds: -110,
  units: 1,
  gameTime: KICKOFF,
  pickedSide: "HOME",
});
const TEAM_OPTIONS = {
  choices: [
    { id: "opt:0", label: "Detroit Lions (NFL)", sport: "NFL", nickname: "detroit lions", capperName: "Five Star", pick: storedPick("Detroit Lions", "Green Bay Packers") },
    { id: "opt:1", label: "Detroit Pistons (NBA)", sport: "NBA", nickname: "detroit pistons", capperName: "Five Star", pick: storedPick("Boston Celtics", "Detroit Pistons") },
    { id: "opt:2", label: "Detroit Tigers (MLB)", sport: "MLB", nickname: "detroit tigers", capperName: "Five Star", pick: null, unmatched: "no MLB game today" },
  ],
};
const TOTAL_OPTIONS = {
  choices: [{ id: "confirm", label: "Use the market line 8.5", inferredLine: 8.5, lineReason: "missing", pick: storedPick("Chicago Cubs", "St. Louis Cardinals") }],
};

async function main() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* no .env */
    }
  }
  if (!isLocal(process.env.DATABASE_URL)) {
    console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures.");
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const queue = await import("@/server/data/ingest-review-queue");
  const userId = PREFIX + "user";
  const tokenIds: string[] = [];
  const batchIds: string[] = [];

  try {
    await prisma.user.create({ data: { id: userId, supabaseId: userId + "-sb", email: userId + "@example.invalid" } });
    const token = async (name: string, n: number) => {
      const t = await prisma.apiToken.create({ data: { userId, name, prefix: "bv_live_" + n, tokenHash: PREFIX + "hash" + n }, select: { id: true } });
      tokenIds.push(t.id);
      return t.id;
    };
    const named = await token("Telegram bot token", 1);
    const revoked = await token("Old bot", 2);
    const deleted = await token("Gone bot", 3);
    await prisma.apiToken.update({ where: { id: revoked }, data: { revokedAt: new Date() } });

    const batch = async (data: { sourceType?: "TELEGRAM" | "API_TOKEN"; channelId?: string; messageId?: number; tokenId?: string; sourceKey?: string }) => {
      const b = await prisma.ingestBatch.create({ data: { ...data, day: "2026-11-26", text: "fixture" }, select: { id: true } });
      batchIds.push(b.id);
      return b.id;
    };
    const tg = await batch({ channelId: PREFIX + "chan", messageId: 1 });
    const tNamed = await batch({ sourceType: "API_TOKEN", tokenId: named, sourceKey: `tok:${named}:${PREFIX}1` });
    const tRevoked = await batch({ sourceType: "API_TOKEN", tokenId: revoked, sourceKey: `tok:${revoked}:${PREFIX}2` });
    const tDeleted = await batch({ sourceType: "API_TOKEN", tokenId: deleted, sourceKey: `tok:${deleted}:${PREFIX}3` });

    const base = Date.parse("2026-11-26T07:14:00.000Z");
    const item = (ingestBatchId: string, i: number, capperName: string, questionType: "AMBIGUOUS_TEAM" | "MISSING_TOTAL_LINE", options: object) => ({
      ingestBatchId,
      userId,
      capperName,
      lineText: "Detroit ML -110 #" + i,
      day: "2026-11-26",
      questionType,
      options,
      createdAt: new Date(base + i * 60_000),
    });
    await prisma.ingestReviewItem.createMany({
      data: [
        item(tg, 0, "Godfather", "AMBIGUOUS_TEAM", TEAM_OPTIONS),
        item(tNamed, 1, "Five Star", "AMBIGUOUS_TEAM", TEAM_OPTIONS),
        item(tNamed, 2, "Five Star", "MISSING_TOTAL_LINE", TOTAL_OPTIONS),
        item(tRevoked, 3, "Five Star", "AMBIGUOUS_TEAM", TEAM_OPTIONS),
        item(tDeleted, 4, "Five Star", "AMBIGUOUS_TEAM", TEAM_OPTIONS),
      ],
    });
    // Deleting the token nulls the batch's tokenId (onDelete: SetNull); the batch and its items stay.
    await prisma.apiToken.delete({ where: { id: deleted } });
    expect("deleted token: the batch's tokenId is now null", (await prisma.ingestBatch.findUnique({ where: { id: tDeleted }, select: { tokenId: true } }))?.tokenId, null);

    const cards = await queue.getPendingReviewCards(userId);
    expect("one row per card (5 items, a batch with two items, multi-choice options)", cards.length, 5);
    expect("no card repeated", new Set(cards.map((c) => c.id)).size, 5);
    expect(
      "source per card: Telegram / named token (x2) / revoked -> no name / deleted -> no name",
      cards.map((c) => c.source),
      [
        { type: "TELEGRAM" },
        { type: "API_TOKEN", tokenName: "Telegram bot token" },
        { type: "API_TOKEN", tokenName: "Telegram bot token" },
        { type: "API_TOKEN", tokenName: null },
        { type: "API_TOKEN", tokenName: null },
      ]
    );
    expect("createdAt is the item's ISO time, oldest first", cards.map((c) => c.createdAt), [0, 1, 2, 3, 4].map((i) => new Date(base + i * 60_000).toISOString()));

    const team = cards[1].choices;
    expect("team choice at home: short names, HOME side, start time", team[0].game, { home: "DET", away: "GB", side: "HOME", startsAt: KICKOFF });
    expect("team choice on the road: AWAY side", team[1].game, { home: "BOS", away: "DET", side: "AWAY", startsAt: KICKOFF });
    expect("team choice with no stored game: no game", [team[2].game, team[2].playable, team[2].unmatched], [undefined, false, "no MLB game today"]);
    expect("a total-line card carries no game even though its choice has a stored pick", cards[2].choices[0].game, undefined);
    const json = JSON.stringify(cards);
    expect("the stored pick never leaves the database (odds, bet type, full team names)", /"pick"|gameTime|homeTeam|"odds"|MONEYLINE|Green Bay Packers/.test(json), false);
    console.log("card payload bytes (5 cards):", json.length);
  } finally {
    const itemIds = (await prisma.ingestReviewItem.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id);
    console.log("cleanup ids:", JSON.stringify({ user: userId, items: itemIds.length, batches: batchIds.length, tokens: tokenIds.length }));
    await prisma.ingestReviewItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.ingestBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.apiToken.deleteMany({ where: { id: { in: tokenIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
