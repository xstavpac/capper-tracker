// Far-future hold and live entry, through the real import pipeline against a LOCAL database (2026-11-23):
//   - manual paste (importPicksForUser with holdFarFuture, as bulkImportPicksAction calls it): a pick whose game is past
//     its sport's threshold (lib/far-future-game.ts) is not saved without confirmFarFuture; within it, it is;
//   - Telegram ingest (ingestTelegramBatch): the same pick goes to the review queue as FAR_FUTURE_GAME (counted once,
//     as pending review - not also as skipped), and answering it saves the stored row;
//   - live entry: a pick matched to a game in progress is saved with enteredLive, priced from the game's last
//     pre-game price when it has none of its own (not left unpriced), with mlFavoredSide and its FAV/DOG category.
//
// Deterministic: the game lookups and price reads are a fixed board (as in telegram-ingest-acceptance-test.ts); the
// rest is the real pipeline and the real database. Fixtures live under throwaway users and are deleted by id. Run:
//   npx tsx src/server/data/import-far-future-live-entry-acceptance-test.ts   (DATABASE_URL must be localhost)
import { parseCatalog } from "@/lib/parse-catalog";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";

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

const PREFIX = "__FarFuture__";
const H = 3600000;
const NOW = Date.now();
const at = (ms: number) => new Date(NOW + ms).toISOString();

// ---- the fixed board ----
type Fake = { id: string; sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string; status: string };
const BOARD: Fake[] = [
  // In progress: tipped off an hour ago.
  { id: "suns-live", sportKey: "basketball_nba", homeTeam: "Phoenix Suns", awayTeam: "Denver Nuggets", commenceTime: at(-H), status: "live" },
  // 30 hours out: within the NBA's 36 h.
  { id: "heat-30h", sportKey: "basketball_nba", homeTeam: "Miami Heat", awayTeam: "Orlando Magic", commenceTime: at(30 * H), status: "preview" },
  // 3 days out: past the NBA's 36 h.
  { id: "knicks-3d", sportKey: "basketball_nba", homeTeam: "New York Knicks", awayTeam: "Boston Celtics", commenceTime: at(72 * H), status: "preview" },
  // 5 days out: within the NFL's 8 days.
  { id: "chiefs-5d", sportKey: "americanfootball_nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers", commenceTime: at(120 * H), status: "preview" },
  // 9 days out: past the NFL's 8 days.
  { id: "bengals-9d", sportKey: "americanfootball_nfl", homeTeam: "Cincinnati Bengals", awayTeam: "Cleveland Browns", commenceTime: at(216 * H), status: "preview" },
];
const endsWith = (team: string, nick: string) => team.toLowerCase().endsWith(nick.toLowerCase());
const gameFor = (sportKey: string, ...nicks: string[]) => {
  const g = BOARD.find((b) => b.sportKey === sportKey && nicks.every((n) => endsWith(b.homeTeam, n) || endsWith(b.awayTeam, n)));
  return g ? { ...g, scores: null, inningHalf: null, inningOrdinal: null, innings: null, doubleHeaderStatus: "N" } : null;
};
// The Suns game's last pre-game price (what #446's pre-tip listing would supply) and its h2h favorite.
const PRE_GAME_SUNS_ML = -150;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realOdds = require("./odds") as Record<string, unknown>;
stub("./odds", {
  ...realOdds,
  resolveGameForNickname: async (sportKey: string, nick: string) => ({ game: gameFor(sportKey, nick), doubleheaderBothLegsFinal: false }),
  resolveGameForTeams: async (sportKey: string, a: string, b: string) => ({ game: gameFor(sportKey, a, b), doubleheaderBothLegsFinal: false }),
  findFavoredSide: async (_sk: string, game: { id?: string }) => (game.id === "suns-live" ? "HOME" : null),
  findMarketPrice: async () => null,
  findMarketPricePoint: async (_sk: string, game: { id?: string }, betType: string) =>
    game.id === "suns-live" && betType === "MONEYLINE" ? { price: PRE_GAME_SUNS_ML, book: "fanduel", eventId: "evt-suns" } : null,
  findMarketSpreadLine: async () => null,
  findMarketTotalLine: async () => null,
  createRequestOddsLoader: () => async () => [],
});
stub("./catalog-disambiguation-checks", {
  runTeamScheduleCheck: async () => ({}),
  runTeamWideScheduleCheck: async () => ({}),
  runTeamInProgressCheck: async () => ({}),
  runLeagueActivityCheck: async () => ({}),
  runCollegeLineCheck: async () => ({}),
  runCapperLeagueHistory: async () => ({}),
});
stub("./recover-unresolved-core", {
  recoverUnresolvedPicks: async (text: string, names: string[]) => ({ recovered: [], stillUnresolved: parseCatalog(text, names).unresolved, reasons: {} }),
});
stub("./import-feed-teams", { getImportFeedTeams: async () => NCAAB_LISTED_TEAMS });
// eslint-disable-next-line @typescript-eslint/no-require-imports
stub("./nfl-roster-cache", { ...(require("./nfl-roster-cache") as Record<string, unknown>), getCachedNflRosterFullNames: async () => [] });
stub("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const LINES = ["Suns ML", "Heat -2", "Knicks -4", "Chiefs -3", "Bengals +3"];
const TEXT = "Sharp Capper\n" + LINES.join("\n") + "\n";

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
  const { importPicksForUser } = await import("@/server/data/bulk-import-core");
  const { toItem } = await import("@/server/data/catalog-import-orchestrator");
  const { ingestTelegramBatch } = await import("@/server/data/telegram-ingest");
  const { resolveReviewItem } = await import("@/server/data/ingest-review");
  const { isReviewOptions } = await import("@/lib/ingest-review-options");

  const users = { manual: PREFIX + "manual", tg: PREFIX + "telegram" };
  const ids = [users.manual, users.tg];
  const channelIds = [PREFIX + "chan"];
  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));
  const picksOf = (userId: string) =>
    prisma.pick.findMany({
      where: { userId },
      select: { betDetail: true, gameTime: true, odds: true, oddsSource: true, oddsNullReason: true, enteredLive: true, mlFavoredSide: true, pickedSide: true, category: true },
      orderBy: { betDetail: "asc" },
    });
  const log = console.log;
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };

  try {
    for (const id of ids) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });

    // ---- 1. Manual paste ----
    const parsed = parseCatalog(TEXT, ["Sharp Capper"]).picks;
    expect("fixture parses to the five picks", parsed.map((p) => p.sportName + " " + p.description), [
      "NBA Suns ML",
      "NBA Heat -2",
      "NBA Knicks -4",
      "NFL Chiefs -3",
      "NFL Bengals +3",
    ]);
    const items = parsed.map((p) => toItem(p, p.capperName));
    const first = await quiet(() => importPicksForUser(users.manual, items, [], [], { holdFarFuture: true }));
    if (!first.success) throw new Error("manual import failed: " + first.error);
    expect("manual: within each sport's threshold imported (Suns live, Heat 30 h, Chiefs NFL 5 d)", first.imported, 3);
    expect(
      "manual: past the threshold held, not saved (Knicks NBA 3 d, Bengals NFL 9 d)",
      first.farFutureHeld.map((s) => s.split(":")[0]),
      ["Sharp Capper - Knicks -4", "Sharp Capper - Bengals +3"]
    );
    expect("manual: the held line carries the warning", /^Game is 3 days away: .+\. Is this the right game\?/.test(first.farFutureHeld[0].split(": ").slice(1).join(": ")), true);
    expect("manual: the live pick is listed as a live entry", first.enteredLive, ["Sharp Capper - Suns ML"]);

    const confirmed = await quiet(() =>
      importPicksForUser(users.manual, items.filter((i) => i.description === "Knicks -4").map((i) => ({ ...i, confirmFarFuture: true })), [], [], { holdFarFuture: true })
    );
    expect("manual: the same far-future pick, confirmed, is saved", confirmed.success && [confirmed.imported, confirmed.farFutureHeld.length], [1, 0]);
    const noHold = await quiet(() => importPicksForUser(users.manual, items.filter((i) => i.description === "Bengals +3"), [], [], {}));
    expect("without holdFarFuture nothing is held (every other caller unchanged)", noHold.success && [noHold.imported, noHold.farFutureHeld.length], [1, 0]);

    const manualPicks = await picksOf(users.manual);
    const suns = manualPicks.find((p) => p.betDetail === "Suns ML");
    expect(
      "live entry: saved with enteredLive, priced from the last pre-game price, favorite side set",
      suns && { enteredLive: suns.enteredLive, odds: suns.odds, oddsSource: suns.oddsSource, oddsNullReason: suns.oddsNullReason, mlFavoredSide: suns.mlFavoredSide, pickedSide: suns.pickedSide },
      { enteredLive: true, odds: PRE_GAME_SUNS_ML, oddsSource: "MARKET", oddsNullReason: null, mlFavoredSide: "HOME", pickedSide: "HOME" }
    );
    expect("live entry: its category is stamped (favorite moneyline)", suns?.category, "FAV_ML");
    expect(
      "only the live pick is enteredLive",
      manualPicks.filter((p) => p.enteredLive).map((p) => p.betDetail),
      ["Suns ML"]
    );
    expect("the confirmed far-future pick kept its matched game", manualPicks.find((p) => p.betDetail === "Knicks -4")?.gameTime.toISOString(), BOARD[2].commenceTime);

    // ---- 2. Telegram ingest ----
    const res = await quiet(() =>
      ingestTelegramBatch({ channelId: channelIds[0], messageId: 1, day: new Date(NOW).toISOString().slice(0, 10), text: TEXT }, { userId: users.tg, allowedLeagues: new Set(["NBA", "NFL"]) })
    );
    expect(
      "telegram: 3 imported, the 2 far-future picks pending review, none counted as skipped too",
      res.status !== "duplicate" && [res.status, res.imported, res.pendingReview, res.skipped],
      ["partial", 3, 2, 0]
    );
    const items2 = await prisma.ingestReviewItem.findMany({
      where: { userId: users.tg },
      select: { id: true, questionType: true, lineText: true, options: true },
      orderBy: { lineText: "asc" },
    });
    expect("telegram: review items are FAR_FUTURE_GAME", items2.map((i) => [i.questionType, i.lineText]), [
      ["FAR_FUTURE_GAME", "Bengals +3"],
      ["FAR_FUTURE_GAME", "Knicks -4"],
    ]);
    const knicksItem = items2.find((i) => i.lineText === "Knicks -4")!;
    const choice = isReviewOptions(knicksItem.options) ? knicksItem.options.choices[0] : null;
    expect(
      "telegram: one 'yes' choice carrying the matched game and the warning",
      choice && [choice.id, choice.label.startsWith("Yes, this game: Boston Celtics @ New York Knicks, Game is 3 days away: "), choice.pick?.gameTime],
      ["confirm", true, BOARD[2].commenceTime]
    );
    const answered = await quiet(() => resolveReviewItem(users.tg, knicksItem.id, "confirm"));
    expect("telegram: answering yes saves the pick", answered.ok, true);
    const tgPicks = await picksOf(users.tg);
    expect("telegram: saved picks", tgPicks.map((p) => p.betDetail), ["Chiefs -3", "Heat -2", "Knicks -4", "Suns ML"]);
    expect("telegram: the live pick is enteredLive there too", tgPicks.filter((p) => p.enteredLive).map((p) => p.betDetail), ["Suns ML"]);
  } finally {
    const idsOf = async (rows: Promise<{ id: string }[]>) => (await rows).map((r) => r.id);
    const batchIds = await idsOf(prisma.ingestBatch.findMany({ where: { channelId: { in: channelIds } }, select: { id: true } }));
    const itemIds = await idsOf(prisma.ingestReviewItem.findMany({ where: { OR: [{ userId: { in: ids } }, { ingestBatchId: { in: batchIds } }] }, select: { id: true } }));
    const skippedIds = await idsOf(prisma.importSkippedLine.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const runIds = await idsOf(prisma.importRun.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const pickIds = await idsOf(prisma.pick.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const capperIds = await idsOf(prisma.capper.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const sportsNow = await prisma.sport.findMany({ select: { id: true, name: true } });
    const sportIds = sportsNow.filter((s) => !sportsBefore.has(s.name)).map((s) => s.id);
    await prisma.ingestReviewItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.ingestBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.importSkippedLine.deleteMany({ where: { id: { in: skippedIds } } });
    await prisma.importRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.pick.deleteMany({ where: { id: { in: pickIds } } });
    await prisma.capper.deleteMany({ where: { id: { in: capperIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.sport.deleteMany({ where: { id: { in: sportIds } } });
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
