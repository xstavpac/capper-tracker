// Pick recipients, end to end against a LOCAL database: fan-out to ACTIVE recipients only, nothing for PAUSED, no
// catch-up on resume, manual picks never fan out, review-queue approvals do, recipient copies bypass the Free-plan limit
// (and a normal insert does not), copies are excluded from platform_category_rates, and cleanup is by id scoped to the
// recipient's userId.
//
// Same determinism as telegram-ingest-acceptance-test.ts (fixed board, stubbed feeds); everything else is the real
// pipeline and the real database. Every row it creates is recorded and deleted BY ID, with before/after counts printed.
//   npx tsx src/server/data/pick-recipients-acceptance-test.ts   (DATABASE_URL must be localhost)
import { parseCatalog } from "@/lib/parse-catalog";

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

const PREFIX = "__Recip__";
const H = 3600000;
const NOW = Date.now();

type Fake = { sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string };
const at = (i: number) => new Date(NOW + (2 + i) * H).toISOString();
const BOARD: Fake[] = [
  { sportKey: "basketball_nba", homeTeam: "Los Angeles Lakers", awayTeam: "Boston Celtics", commenceTime: at(0) },
  { sportKey: "basketball_nba", homeTeam: "New York Knicks", awayTeam: "Miami Heat", commenceTime: at(1) },
  { sportKey: "americanfootball_nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers", commenceTime: at(2) },
  { sportKey: "americanfootball_nfl", homeTeam: "New York Jets", awayTeam: "Buffalo Bills", commenceTime: at(4) },
  { sportKey: "icehockey_nhl", homeTeam: "Winnipeg Jets", awayTeam: "Dallas Stars", commenceTime: at(5) },
];
const endsWith = (team: string, nick: string) => team.toLowerCase().endsWith(nick.toLowerCase());
const gameFor = (sportKey: string, ...nicks: string[]) => {
  const g = BOARD.find((b) => b.sportKey === sportKey && nicks.every((n) => endsWith(b.homeTeam, n) || endsWith(b.awayTeam, n)));
  return g ? { id: `${PREFIX}${g.homeTeam}`, ...g, status: "scheduled", doubleHeaderStatus: "N" } : null;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realOdds = require("./odds") as Record<string, unknown>;
stub("./odds", {
  ...realOdds,
  resolveGameForNickname: async (sportKey: string, nick: string) => ({ game: gameFor(sportKey, nick), doubleheaderBothLegsFinal: false }),
  resolveGameForTeams: async (sportKey: string, a: string, b: string) => ({ game: gameFor(sportKey, a, b), doubleheaderBothLegsFinal: false }),
  findFavoredSide: async () => null,
  findMarketPrice: async () => null,
  findMarketPricePoint: async () => null,
  findMarketSpreadLine: async () => null,
  findMarketTotalLine: async () => 8.5,
  createRequestOddsLoader: () => async () => [],
});
stub("./catalog-disambiguation-checks", {
  runTeamScheduleCheck: async () => ({}),
  runTeamWideScheduleCheck: async () => ({}),
  runLeagueActivityCheck: async () => ({}),
});
stub("./recover-unresolved-core", {
  recoverUnresolvedPicks: async (text: string, names: string[]) => ({ recovered: [], stillUnresolved: parseCatalog(text, names).unresolved, reasons: {} }),
});
stub("./import-feed-teams", { getImportFeedTeams: async () => [] });
stub("./nfl-roster-cache", { ...(require("./nfl-roster-cache") as Record<string, unknown>), getCachedNflRosterFullNames: async () => [] });
// A delivery that fails for ONE chosen recipient (failure isolation case). Everyone else uses the real insert.
const failDelivery = { userId: null as string | null };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDedup = require("./pick-dedup") as Record<string, unknown>;
stub("./pick-dedup", {
  ...realDedup,
  insertPicksDeduped: (userId: string, rows: unknown[], options?: { recipientCopy?: boolean }) => {
    if (options?.recipientCopy && userId === failDelivery.userId) return Promise.reject(new Error("simulated delivery failure"));
    return (realDedup.insertPicksDeduped as (...a: unknown[]) => Promise<unknown>)(userId, rows, options);
  },
});
stub("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

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
  const { ingestTelegramBatch } = await import("@/server/data/telegram-ingest");
  const { resolveReviewItem } = await import("@/server/data/ingest-review");
  const { createPick } = await import("@/server/data/picks");
  const { insertPicksDeduped } = await import("@/server/data/pick-dedup");
  const { FREE_PICK_LIMIT } = await import("@/lib/entitlements");
  const { buildPlatformRatesRecompute } = await import("@/server/data/platform-category-rates");
  const R = await import("@/server/data/pick-recipients");

  const ids = {
    src: PREFIX + "src",
    a: PREFIX + "a-active",
    b: PREFIX + "b-paused",
    c: PREFIX + "c-resumed",
    free: PREFIX + "free",
    bad: PREFIX + "bad-fails",
  };
  const userIds = Object.values(ids);
  const days = "2026-11-02";
  const allowed = new Set(["NBA", "NFL", "NHL", "MLB"]);
  const config = { userId: ids.src, allowedLeagues: allowed };
  const created = { picks: [] as string[], cappers: [] as string[], recipients: [] as string[], batches: [] as string[], subs: [] as string[], sports: [] as string[] };

  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));
  const counts = async () => ({
    users: await prisma.user.count({ where: { id: { in: userIds } } }),
    picks: await prisma.pick.count({ where: { userId: { in: userIds } } }),
    cappers: await prisma.capper.count({ where: { userId: { in: userIds } } }),
    recipients: await prisma.pickRecipient.count({ where: { sourceUserId: { in: userIds } } }),
    batches: await prisma.ingestBatch.count({ where: { channelId: PREFIX + "chan" } }),
  });
  const before = await counts();
  console.log("BEFORE:", JSON.stringify(before));

  const picksOf = (userId: string) =>
    prisma.pick.findMany({
      where: { userId },
      select: { id: true, betDetail: true, isRecipientCopy: true, sourcePickId: true, capperId: true, capper: { select: { userId: true, name: true } } },
      orderBy: { betDetail: "asc" },
    });
  const batch = async (messageId: number, text: string) => {
    const out = await ingestTelegramBatch({ channelId: PREFIX + "chan", messageId, day: days, text }, config);
    created.batches.push(out.batchId);
    return out;
  };
  const recipientRow = async (recipientUserId: string, status: "ACTIVE" | "PAUSED") => {
    const row = await prisma.pickRecipient.create({ data: { sourceUserId: ids.src, recipientUserId, status }, select: { id: true } });
    created.recipients.push(row.id);
    return row.id;
  };

  try {
    for (const id of userIds) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });

    const rowA = await recipientRow(ids.a, "ACTIVE");
    await recipientRow(ids.b, "PAUSED");
    const rowC = await recipientRow(ids.c, "PAUSED");
    await recipientRow(ids.free, "ACTIVE");

    // The Free-plan recipient: a FREE subscription and a full account (FREE_PICK_LIMIT picks).
    const sub = await prisma.subscription.create({ data: { userId: ids.free, plan: "FREE", status: "active" }, select: { id: true } });
    created.subs.push(sub.id);
    let nba = await prisma.sport.findUnique({ where: { name: "NBA" }, select: { id: true } });
    if (!nba) {
      nba = await prisma.sport.create({ data: { name: "NBA" }, select: { id: true } });
      created.sports.push(nba.id);
    }
    const filler = await prisma.capper.create({ data: { userId: ids.free, name: "Filler", source: "OTHER" }, select: { id: true } });
    created.cappers.push(filler.id);
    const fillerIds = Array.from({ length: FREE_PICK_LIMIT }, (_, i) => `${PREFIX}filler-${i}`);
    await prisma.pick.createMany({
      data: fillerIds.map((id, i) => ({
        id, userId: ids.free, capperId: filler.id, sportId: nba!.id, homeTeam: "H" + i, awayTeam: "A" + i, betType: "MONEYLINE" as const,
        odds: -110, units: 1, gameTime: new Date(NOW - 30 * 86400000 - i * 3600000),
      })),
    });
    created.picks.push(...fillerIds);

    // ---------- batch 1: imported picks fan out to ACTIVE recipients only ----------
    const b1 = await batch(1, "Alpha\nLakers -3 -110\nChiefs ML -150");
    expect("batch 1: source imported 2", b1.status === "failed" ? -1 : (b1 as { imported: number }).imported, 2);
    const srcPicks = await picksOf(ids.src);
    created.picks.push(...srcPicks.map((p) => p.id));
    expect("source picks are not marked as copies", srcPicks.map((p) => [p.isRecipientCopy, p.sourcePickId]), [[false, null], [false, null]]);
    const aPicks = await picksOf(ids.a);
    created.picks.push(...aPicks.map((p) => p.id));
    expect("ACTIVE recipient got both picks, flagged and linked to the source pick ids", aPicks.map((p) => p.isRecipientCopy), [true, true]);
    expect("copies link to the source picks", aPicks.map((p) => p.sourcePickId).sort(), srcPicks.map((p) => p.id).sort());
    expect("the copy is on the recipient's OWN capper (not the source's)", aPicks.every((p) => p.capper.userId === ids.a && p.capperId !== srcPicks[0].capperId), true);
    expect("PAUSED recipient got nothing", (await picksOf(ids.b)).length, 0);
    expect("PAUSED (not yet resumed) recipient got nothing", (await picksOf(ids.c)).length, 0);

    // ---------- Free-plan limit: copies bypass it, a normal insert does not ----------
    const freeNow = await picksOf(ids.free);
    const copiesOnFree = freeNow.filter((p) => p.isRecipientCopy);
    created.picks.push(...copiesOnFree.map((p) => p.id));
    expect("free-plan recipient at the limit still received the copies", copiesOnFree.length, 2);
    expect("free-plan recipient is now over the limit (admin-granted)", freeNow.length, FREE_PICK_LIMIT + 2);
    const normal = await insertPicksDeduped(ids.free, [
      { capperName: "Filler", sportName: "NBA", homeTeam: "X", awayTeam: "Y", betType: "MONEYLINE", odds: -110, units: 1, gameTime: new Date(NOW + 9 * H) },
    ]);
    expect("a NORMAL insert for the same user is still refused by the limit", normal.allowed, false);

    // ---------- resume: no catch-up ----------
    expect("resume succeeds", (await R.resumeRecipient(rowC)).ok, true);
    const b2 = await batch(2, "Beta\nKnicks ML -130");
    expect("batch 2: source imported 1", (b2 as { imported: number }).imported, 1);
    const cPicks = await picksOf(ids.c);
    created.picks.push(...cPicks.map((p) => p.id));
    expect("resumed recipient got ONLY the pick imported after resuming", cPicks.map((p) => p.betDetail), ["Knicks ML"]);
    const aAfter2 = await picksOf(ids.a);
    created.picks.push(...aAfter2.map((p) => p.id));
    expect("ACTIVE recipient now has 3", aAfter2.length, 3);
    expect("still-PAUSED recipient still has nothing", (await picksOf(ids.b)).length, 0);
    created.picks.push(...(await picksOf(ids.src)).map((p) => p.id));

    // ---------- manual picks never fan out ----------
    const srcCapper = srcPicks[0].capperId;
    const manual = await createPick(ids.src, { capperId: srcCapper, sportId: nba.id, homeTeam: "Manual H", awayTeam: "Manual A", betType: "MONEYLINE", betDetail: "Manual ML", odds: -120, units: 1, gameTime: new Date(NOW + 10 * H) });
    created.picks.push(manual.id);
    expect("manual pick landed on the source", (await picksOf(ids.src)).some((p) => p.betDetail === "Manual ML"), true);
    expect("manual pick did NOT fan out", (await picksOf(ids.a)).length + (await picksOf(ids.c)).length, 3 + 1);

    // ---------- review-queue approval fans out ----------
    const b3 = await batch(3, "Gamma\nJets ML -140");
    expect("batch 3: the ambiguous Jets line is parked for review", (b3 as { pendingReview: number }).pendingReview, 1);
    const item = await prisma.ingestReviewItem.findFirst({ where: { userId: ids.src }, select: { id: true, options: true } });
    const nfl = (item!.options as { choices: { id: string; sport?: string }[] }).choices.find((c) => c.sport === "NFL");
    const aBeforeReview = (await picksOf(ids.a)).length;
    const resolved = await resolveReviewItem(ids.src, item!.id, nfl!.id);
    expect("review approval inserted the source's pick", resolved.ok, true);
    if (resolved.ok) created.picks.push(resolved.pickId);
    const aAfterReview = await picksOf(ids.a);
    created.picks.push(...aAfterReview.map((p) => p.id));
    expect("review approval fanned out to the ACTIVE recipient", aAfterReview.length - aBeforeReview, 1);
    expect("...and the copy links to the approved pick", aAfterReview.some((p) => resolved.ok && p.sourcePickId === resolved.pickId && p.isRecipientCopy), true);

    // ---------- pause stops new picks, keeps delivered ones ----------
    expect("pause succeeds", (await R.pauseRecipient(rowA)).ok, true);
    const aBeforePause = (await picksOf(ids.a)).length;
    await batch(4, "Delta\nCelticsx nonsense\nHeat ML -105");
    const aPaused = await picksOf(ids.a);
    created.picks.push(...aPaused.map((p) => p.id));
    expect("paused recipient got nothing new", aPaused.length, aBeforePause);
    expect("pausing removed nothing already delivered", aPaused.length >= 4, true);
    created.picks.push(...(await picksOf(ids.src)).map((p) => p.id));
    expect("pause/resume/remove flags: second pause is refused", (await R.pauseRecipient(rowA)).ok, false);

    // ---------- copies are excluded from platform_category_rates ----------
    // Run the real recompute SQL inside a transaction that is rolled back, so the shared table is never changed.
    const winKey = { league: "NBA", betType: "MONEYLINE" };
    const knicksSrc = (await picksOf(ids.src)).find((p) => p.betDetail === "Knicks ML")!;
    const knicksCopy = (await picksOf(ids.c)).find((p) => p.betDetail === "Knicks ML")!;
    await prisma.pick.updateMany({ where: { id: { in: [knicksSrc.id, knicksCopy.id] } }, data: { status: "WIN" } });
    const probeError = new Error("rollback");
    const seen: { withBoth?: number; withoutCopy?: number; withoutEither?: number } = {};
    try {
      await prisma.$transaction(async (tx) => {
        const recompute = async () => {
          await tx.$queryRaw(buildPlatformRatesRecompute());
          const rows = await tx.platformCategoryRate.findMany({ where: winKey, select: { wins: true } });
          return rows.reduce((n, r) => n + r.wins, 0);
        };
        seen.withBoth = await recompute();
        await tx.pick.deleteMany({ where: { id: knicksCopy.id, userId: ids.c } });
        seen.withoutCopy = await recompute();
        await tx.pick.deleteMany({ where: { id: knicksSrc.id, userId: ids.src } });
        seen.withoutEither = await recompute();
        throw probeError;
      });
    } catch (err) {
      if (err !== probeError) throw err;
    }
    expect("rates: the copy added nothing (with copy == without copy)", seen.withBoth, seen.withoutCopy);
    expect("rates: the source pick still counts (one fewer without it)", (seen.withoutCopy ?? 0) - (seen.withoutEither ?? 0), 1);

    // ---------- remove stops new picks; delivered picks stay ----------
    const cCountBeforeRemove = (await picksOf(ids.c)).length;
    expect("remove succeeds", (await R.removeRecipient(rowC)).ok, true);
    await batch(5, "Epsilon\nHeat ML -105");
    expect("removed recipient got nothing new", (await picksOf(ids.c)).length, cCountBeforeRemove);
    created.picks.push(...(await picksOf(ids.c)).map((p) => p.id));
    created.picks.push(...(await picksOf(ids.src)).map((p) => p.id));

    // ---------- failure isolation: one recipient's delivery failing never hurts the source or the others ----------
    const badRow = await recipientRow(ids.bad, "ACTIVE");
    void badRow;
    failDelivery.userId = ids.bad;
    const logged: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    let isolated: Awaited<ReturnType<typeof batch>> | null = null;
    try {
      isolated = await batch(6, "Zeta\nCeltics ML -115");
    } finally {
      console.error = realConsoleError;
    }
    expect("isolation: the source import still succeeded and returned normally", [isolated?.status, (isolated as { imported?: number } | null)?.imported], ["imported", 1]);
    const zetaSrc = (await picksOf(ids.src)).filter((p) => p.betDetail === "Celtics ML");
    created.picks.push(...zetaSrc.map((p) => p.id));
    expect("isolation: the source pick is committed", zetaSrc.length, 1);
    const freeCopies = (await picksOf(ids.free)).filter((p) => p.betDetail === "Celtics ML" && p.isRecipientCopy);
    created.picks.push(...freeCopies.map((p) => p.id));
    expect("isolation: another ACTIVE recipient still got its copy", freeCopies.length, 1);
    expect("isolation: the failing recipient got nothing", (await picksOf(ids.bad)).length, 0);
    expect("isolation: the failure was logged", logged.some((l) => l.includes("[pick-recipients] delivery failed") && l.includes("simulated delivery failure")), true);
    const isolatedBatch = await prisma.ingestBatch.findUnique({ where: { id: (isolated as { batchId: string }).batchId }, select: { status: true, error: true } });
    expect("isolation: the ingest batch row records it (status stays IMPORTED)", [isolatedBatch?.status, /Recipient delivery failed for 1 copies/.test(isolatedBatch?.error ?? "")], ["IMPORTED", true]);
    failDelivery.userId = null;

    // ---------- cleanup by id, scoped to the recipient's userId ----------
    const aOwn = await prisma.pick.create({
      data: { userId: ids.a, capperId: aAfterReview[0].capperId, sportId: nba.id, homeTeam: "Own H", awayTeam: "Own A", betType: "MONEYLINE", odds: -110, units: 1, gameTime: new Date(NOW + 11 * H) },
      select: { id: true },
    });
    created.picks.push(aOwn.id);
    const copyIds = await R.listRecipientCopyIds(ids.a);
    expect("copy ids: only isRecipientCopy rows of that user", copyIds.length, aAfterReview.filter((p) => p.isRecipientCopy).length);
    expect("copy ids exclude the recipient's own pick", copyIds.includes(aOwn.id), false);
    const srcSample = (await picksOf(ids.src))[0].id;
    const removed = await R.deleteRecipientCopiesById(ids.a, [...copyIds, aOwn.id, srcSample]);
    expect("cleanup removed exactly the copies", removed, copyIds.length);
    expect("the recipient's own pick survived (even when its id was passed)", (await prisma.pick.count({ where: { id: aOwn.id } })), 1);
    expect("the source's pick survived (even when its id was passed)", (await prisma.pick.count({ where: { id: srcSample } })), 1);
    expect("the source's picks are all still there", (await picksOf(ids.src)).every((p) => !p.isRecipientCopy), true);
    expect("an empty id list deletes nothing", await R.deleteRecipientCopiesById(ids.a, []), 0);

    // ---------- admin helpers ----------
    expect("add: unknown user refused", (await R.addRecipient(ids.src, PREFIX + "nobody")).ok, false);
    expect("add: yourself refused", (await R.addRecipient(ids.src, ids.src)).ok, false);
    expect("add: duplicate refused", (await R.addRecipient(ids.src, ids.a)).ok, false);
    const addedByEmail = await R.addRecipient(ids.src, (ids.c + "@example.invalid").toUpperCase());
    expect("add: by email (case-insensitive) works", addedByEmail.ok, true);
    const row = await prisma.pickRecipient.findFirst({ where: { sourceUserId: ids.src, recipientUserId: ids.c }, select: { id: true, status: true } });
    if (row) created.recipients.push(row.id);
    expect("add: new recipient is ACTIVE", row?.status, "ACTIVE");
  } finally {
    // Delete everything this run created, BY ID. Picks first (by the recorded ids plus any still on the fixture users,
    // found by id), then cappers, recipient rows, batches, subscriptions, users, and any sport this run created.
    const strayPicks = await prisma.pick.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const pickIds = Array.from(new Set([...created.picks, ...strayPicks.map((p) => p.id)]));
    for (let i = 0; i < pickIds.length; i += 500) await prisma.pick.deleteMany({ where: { id: { in: pickIds.slice(i, i + 500) }, userId: { in: userIds } } });
    const capperIds = Array.from(new Set([...created.cappers, ...(await prisma.capper.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((c) => c.id)]));
    await prisma.importSkippedLine.deleteMany({ where: { id: { in: (await prisma.importSkippedLine.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((r) => r.id) } } });
    await prisma.importRun.deleteMany({ where: { id: { in: (await prisma.importRun.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((r) => r.id) } } });
    await prisma.capper.deleteMany({ where: { id: { in: capperIds }, userId: { in: userIds } } });
    const recIds = Array.from(new Set([...created.recipients, ...(await prisma.pickRecipient.findMany({ where: { sourceUserId: { in: userIds } }, select: { id: true } })).map((r) => r.id)]));
    await prisma.pickRecipient.deleteMany({ where: { id: { in: recIds } } });
    await prisma.ingestBatch.deleteMany({ where: { id: { in: created.batches } } });
    await prisma.subscription.deleteMany({ where: { id: { in: created.subs } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    const sportsNow = await prisma.sport.findMany({ select: { id: true, name: true } });
    await prisma.sport.deleteMany({ where: { id: { in: sportsNow.filter((s) => !sportsBefore.has(s.name)).map((s) => s.id) } } });
    const after = await counts();
    console.log("AFTER:", JSON.stringify(after));
    expect("cleanup: nothing of this test's rows is left (users, picks, cappers, recipients, batches)", Object.values(after), [0, 0, 0, 0, 0]);
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
