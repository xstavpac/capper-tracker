// Bot API tokens, PR 3: the shared ingest core (ingest-batch.ts) for API_TOKEN batches, against a LOCAL database.
//   1. skipRecipientFanOut: with an active pick recipient, a token batch's picks are never copied - neither the direct
//      import nor a review item resolved later. The same scenario as a Telegram batch still fans out.
//   2. onLineOutcome: one outcome per pick line - accepted (league, game, market, line, odds, pickId = the real row),
//      needs_review (reason, candidate games, the review item id that exists), rejected (combined_pick,
//      league_not_allowed, duplicate, duplicate_in_request, no_game_found, unparseable).
//   3. the day rule end to end: the day a line names, today's FINAL game accepted, an NFL team's next game.
//   4. API_TOKEN batch row: sourceType / tokenId / sourceKey; a resend of the same sourceKey is a duplicate.
//
// Deterministic: the game lookups run the REAL matchers (resolveTokenDayGameFromFeeds / resolveScheduleGameFromFeeds)
// over a fixed board built around today's Eastern date; prices, the ambiguous-team schedule checks and the
// network-backed recovery pass are stubbed, as in telegram-ingest-acceptance-test.ts. Writes fixtures under
// throwaway users and deletes them by id. Run with:
//   npx tsx src/server/data/ingest-batch-acceptance-test.ts   (DATABASE_URL must be localhost)
import { parseCatalog } from "@/lib/parse-catalog";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { addDaysToDateKey, easternWallTime } from "@/lib/dates";
import { teamNameEndsWith } from "@/lib/team-name-match";
import { tokenRequestDay, type LineOutcome } from "@/lib/ingest-line-outcome";
import type { OddsGame, ScoreGame, TokenDayMatch } from "./odds";

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

const PREFIX = "__IngestCore__";
const TODAY = tokenRequestDay(new Date());
const at = (dayOffset: number, hour: number, minute = 0) => new Date(easternWallTime(addDaysToDateKey(TODAY, dayOffset), hour).getTime() + minute * 60000).toISOString();
const WEEKDAY = (offset: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(addDaysToDateKey(TODAY, offset) + "T12:00:00Z"));

// ---- the fixed board, around today's Eastern date ----
type Fixture = { sportKey: string; id: string; home: string; away: string; commenceTime: string; status: ScoreGame["status"] | "odds" };
const BOARD: Fixture[] = [
  { sportKey: "basketball_nba", id: "lakers-today", home: "Los Angeles Lakers", away: "Golden State Warriors", commenceTime: at(0, 22), status: "preview" },
  { sportKey: "basketball_nba", id: "knicks-today", home: "New York Knicks", away: "Miami Heat", commenceTime: at(0, 19, 30), status: "preview" },
  // Today's Celtics game is already FINAL (it started just after midnight ET, so it is today's under any clock);
  // their next game is tomorrow. The bot API takes today's game; Telegram would roll to tomorrow's.
  { sportKey: "basketball_nba", id: "celtics-today-final", home: "Boston Celtics", away: "Orlando Magic", commenceTime: at(0, 0, 5), status: "final" },
  { sportKey: "basketball_nba", id: "celtics-tomorrow", home: "Chicago Bulls", away: "Boston Celtics", commenceTime: at(1, 20), status: "preview" },
  // Bills: no game today; next game in 3 days, another in 6 (odds feed only).
  { sportKey: "americanfootball_nfl", id: "bills-plus3", home: "Buffalo Bills", away: "Pittsburgh Steelers", commenceTime: at(3, 13), status: "odds" },
  { sportKey: "americanfootball_nfl", id: "bills-plus6", home: "Miami Dolphins", away: "Buffalo Bills", commenceTime: at(6, 13), status: "odds" },
  // Jets: an NFL game and an NHL game, both tomorrow - a question.
  { sportKey: "americanfootball_nfl", id: "jets-nfl", home: "New York Jets", away: "New England Patriots", commenceTime: at(1, 13), status: "odds" },
  { sportKey: "icehockey_nhl", id: "jets-nhl", home: "Winnipeg Jets", away: "Dallas Stars", commenceTime: at(1, 20), status: "preview" },
];
const scoresFor = (sportKey: string): ScoreGame[] =>
  BOARD.filter((b) => b.sportKey === sportKey && b.status !== "odds").map((b) => ({
    id: PREFIX + b.id,
    homeTeam: b.home,
    awayTeam: b.away,
    commenceTime: b.commenceTime,
    status: b.status as ScoreGame["status"],
    scores: null,
    inningHalf: null,
    inningOrdinal: null,
    innings: null,
  }));
const oddsFor = (sportKey: string): OddsGame[] =>
  BOARD.filter((b) => b.sportKey === sportKey && b.status === "odds").map(
    (b) => ({ id: PREFIX + b.id, sportKey, homeTeam: b.home, awayTeam: b.away, commenceTime: b.commenceTime, bookmakers: [] }) as unknown as OddsGame
  );

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realOdds = require("./odds") as typeof import("./odds");
type Opts = { gameNumber?: 1 | 2 | null; excludeFinal?: boolean; day?: TokenDayMatch };
const dayRulesSeen: TokenDayMatch[] = [];
const match = (sportKey: string, matches: (g: { homeTeam: string; awayTeam: string }) => boolean, opts: Opts = {}) => {
  if (opts.day) dayRulesSeen.push(opts.day);
  return opts.day
    ? realOdds.resolveTokenDayGameFromFeeds(scoresFor(sportKey), oddsFor(sportKey), matches, new Date(), opts.gameNumber ?? null, opts.day, [], sportKey)
    : realOdds.resolveScheduleGameFromFeeds(scoresFor(sportKey), oddsFor(sportKey), matches, new Date(), opts.gameNumber ?? null, [], { excludeFinal: opts.excludeFinal, sportKey });
};
const ends = (sportKey: string, nick: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nick, sportKey) || teamNameEndsWith(g.awayTeam, nick, sportKey);
stub("./odds", {
  ...realOdds,
  resolveGameForNickname: async (sportKey: string, nick: string, opts?: Opts) => match(sportKey, ends(sportKey, nick), opts),
  resolveGameForTeams: async (sportKey: string, a: string, b: string, opts?: Opts) =>
    match(sportKey, (g) => ends(sportKey, a)(g) && ends(sportKey, b)(g), opts),
  findFavoredSide: async () => null,
  findMarketPrice: async () => null,
  findMarketPricePoint: async () => null,
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
stub("./nfl-roster-cache", { ...(require("./nfl-roster-cache") as Record<string, unknown>), getCachedNflRosterFullNames: async () => [] });
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
  if (!isLocal(process.env.DATABASE_URL)) throw new Error("DATABASE_URL must point at a local database");

  const { prisma } = await import("@/lib/prisma");
  const { ingestBatch } = await import("@/server/data/ingest-batch");
  const { ingestTelegramBatch } = await import("@/server/data/telegram-ingest");
  const { resolveReviewItem } = await import("@/server/data/ingest-review");
  const { parseAllowedLeagues } = await import("@/lib/ingest-filters");
  const allowedLeagues = parseAllowedLeagues(undefined);

  const users = { main: PREFIX + "main", recipient: PREFIX + "recipient" };
  const ids = [users.main, users.recipient];
  const channel = PREFIX + "chan";
  const sourceKeyPrefix = PREFIX + "tok:";
  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));

  const cleanup = async () => {
    const idsOf = async (rows: Promise<{ id: string }[]>) => (await rows).map((r) => r.id);
    const batchIds = await idsOf(
      prisma.ingestBatch.findMany({ where: { OR: [{ channelId: channel }, { sourceKey: { startsWith: sourceKeyPrefix } }] }, select: { id: true } })
    );
    const itemIds = await idsOf(prisma.ingestReviewItem.findMany({ where: { OR: [{ userId: { in: ids } }, { ingestBatchId: { in: batchIds } }] }, select: { id: true } }));
    const skippedIds = await idsOf(prisma.importSkippedLine.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const runIds = await idsOf(prisma.importRun.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const pickIds = await idsOf(prisma.pick.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const capperIds = await idsOf(prisma.capper.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    if (itemIds.length) await prisma.ingestReviewItem.deleteMany({ where: { id: { in: itemIds } } });
    if (batchIds.length) await prisma.ingestBatch.deleteMany({ where: { id: { in: batchIds } } });
    if (skippedIds.length) await prisma.importSkippedLine.deleteMany({ where: { id: { in: skippedIds } } });
    if (runIds.length) await prisma.importRun.deleteMany({ where: { id: { in: runIds } } });
    if (pickIds.length) await prisma.pick.deleteMany({ where: { id: { in: pickIds } } });
    if (capperIds.length) await prisma.capper.deleteMany({ where: { id: { in: capperIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    const sportIds = (await prisma.sport.findMany({ select: { id: true, name: true } })).filter((s) => !sportsBefore.has(s.name)).map((s) => s.id);
    if (sportIds.length) await prisma.sport.deleteMany({ where: { id: { in: sportIds } } });
  };
  await cleanup();

  const picksOf = (userId: string) => prisma.pick.count({ where: { userId } });
  let seq = 0;
  const tokenBatch = (tokenId: string, text: string, extra: { onLineOutcome?: (raw: string, o: LineOutcome) => void } = {}) =>
    ingestBatch(
      { type: "API_TOKEN", tokenId, sourceKey: `${sourceKeyPrefix}${tokenId}:${++seq}` },
      { userId: users.main, day: TODAY, text },
      { allowedLeagues, realTimeIngest: false, dayRule: { requestDay: TODAY }, skipRecipientFanOut: true, rejectRepeatedLines: true, ...extra }
    );

  try {
    for (const id of ids) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    // The ingest never creates a capper from an unknown name (lib/capper-name-guard.ts): the cappers this test posts as
    // are saved first, as they would be in a real account.
    for (const name of ["Bot Capper","TG Capper"]) await prisma.capper.create({ data: { userId: users.main, name, source: "OTHER" } });
    await prisma.pickRecipient.create({ data: { sourceUserId: users.main, recipientUserId: users.recipient, status: "ACTIVE" } });
    const token = await prisma.apiToken.create({
      data: { userId: users.main, name: "test bot", prefix: "bv_live_TEST", tokenHash: PREFIX + "hash" },
      select: { id: true },
    });

    // ---------- 1. fan-out: token batches never copy, Telegram still does ----------
    {
      const res = await tokenBatch(token.id, "Bot Capper\nLakers -3 -110\nJets ML -140");
      expect("token batch: 1 imported, 1 parked for review", [res.status, "imported" in res ? res.imported : -1, "pendingReview" in res ? res.pendingReview : -1], ["partial", 1, 1]);
      const row = await prisma.ingestBatch.findUnique({ where: { id: res.batchId }, select: { sourceType: true, tokenId: true, sourceKey: true, channelId: true } });
      expect("token batch row: API_TOKEN, tokenId and sourceKey set, no channel", [row?.sourceType, row?.tokenId, row?.sourceKey?.startsWith(sourceKeyPrefix), row?.channelId], ["API_TOKEN", token.id, true, null]);
      expect("token batch, direct import: nothing copied to the active recipient", await picksOf(users.recipient), 0);
      const item = await prisma.ingestReviewItem.findFirst({ where: { ingestBatchId: res.batchId }, select: { id: true } });
      const resolved = await resolveReviewItem(users.main, item!.id, "opt:0");
      expect("token batch: the review item resolves to a pick", resolved.ok, true);
      expect("token batch, review item resolved later: still nothing copied to the recipient", await picksOf(users.recipient), 0);
      expect("token batch: both picks are the source user's", await picksOf(users.main), 2);

      const tg = await ingestTelegramBatch({ channelId: channel, messageId: 1, day: TODAY, text: "TG Capper\nLakers -3 -110\nJets ML -140" }, { userId: users.main, allowedLeagues });
      expect("Telegram batch: 1 imported, 1 parked", ["imported" in tg ? tg.imported : -1, "pendingReview" in tg ? tg.pendingReview : -1], [1, 1]);
      expect("Telegram batch, direct import: copied to the recipient (as before)", await picksOf(users.recipient), 1);
      const tgItem = await prisma.ingestReviewItem.findFirst({ where: { ingestBatchId: tg.batchId }, select: { id: true } });
      const tgResolved = await resolveReviewItem(users.main, tgItem!.id, "opt:0");
      expect("Telegram batch: the review item resolves", tgResolved.ok, true);
      expect("Telegram batch, review item resolved later: copied to the recipient (as before)", await picksOf(users.recipient), 2);
      const copies = await prisma.pick.findMany({ where: { userId: users.recipient }, select: { isRecipientCopy: true, capper: { select: { name: true } } } });
      expect("the recipient's copies are both TG Capper's, marked as copies", copies.map((c) => [c.capper.name, c.isRecipientCopy]), [["TG Capper", true], ["TG Capper", true]]);
    }

    // ---------- 2 + 3. onLineOutcome and the day rule ----------
    {
      const lines = [
        "Lakers -3 -110", // duplicate: already logged by Bot Capper in step 1
        "Celtics ML -120", // today's game is FINAL: accepted on it
        "Celtics ML -120", // duplicate_in_request
        `${WEEKDAY(6)} Bills ML -150`, // names a day: that day's game (+6), not the next one (+3)
        "Bills +3 -110", // no game today: the next game (+3)
        "Chiefs ML -150", // no Chiefs game anywhere: no_game_found
        "Jets ML -140", // NFL or NHL: needs_review
        "Bears + Cubs MLP", // combined_pick
        "Doosan Bears ML -120", // league_not_allowed (KBO)
        "zzqq nonsense line 99", // unparseable
      ];
      const seen: { raw: string; o: LineOutcome }[] = [];
      dayRulesSeen.length = 0;
      const res = await tokenBatch(token.id, ["Bot Capper", ...lines].join("\n"), { onLineOutcome: (raw, o) => seen.push({ raw, o }) });
      console.log("outcomes:", JSON.stringify(seen.map((s) => [s.raw, s.o.status, s.o.status === "rejected" || s.o.status === "needs_review" ? s.o.reason : s.o.game?.home])));

      const byLine = (raw: string) => seen.filter((s) => s.raw === raw).map((s) => s.o);
      expect("every pick line gets exactly one outcome (the repeated line two)", lines.map((l) => byLine(l).length), lines.map((l) => (l === "Celtics ML -120" ? 2 : 1)));
      expect("no outcome for the capper header", byLine("Bot Capper").length, 0);

      const status = (raw: string, k = 0) => {
        const o = byLine(raw)[k];
        return o ? [o.status, o.status === "accepted" ? "ok" : o.reason] : null;
      };
      expect("already logged -> rejected duplicate", status("Lakers -3 -110"), ["rejected", "duplicate"]);
      expect("same line twice: the first is accepted", status("Celtics ML -120", 0), ["accepted", "ok"]);
      expect("same line twice: the second is duplicate_in_request", status("Celtics ML -120", 1), ["rejected", "duplicate_in_request"]);
      expect("no game -> no_game_found", status("Chiefs ML -150"), ["rejected", "no_game_found"]);
      expect("MLP -> combined_pick", status("Bears + Cubs MLP"), ["rejected", "combined_pick"]);
      expect("KBO -> league_not_allowed", status("Doosan Bears ML -120"), ["rejected", "league_not_allowed"]);
      expect("nonsense -> unparseable", status("zzqq nonsense line 99"), ["rejected", "unparseable"]);

      // accepted: the details, and the pick they name is the real row
      const celtics = byLine("Celtics ML -120")[0];
      if (celtics?.status !== "accepted") throw new Error("Celtics line not accepted");
      expect(
        "accepted Celtics: league, game (today's FINAL game), market, line, odds",
        [celtics.league, celtics.game, celtics.market, celtics.period, celtics.line, celtics.odds],
        ["NBA", { away: "Orlando Magic", home: "Boston Celtics", startsAt: at(0, 0, 5) }, "MONEYLINE", "FULL_GAME", null, -120]
      );
      const celticsRow = await prisma.pick.findUnique({ where: { id: celtics.pickId }, select: { userId: true, homeTeam: true, gameTime: true, odds: true, betDetail: true } });
      expect("accepted pickId is the inserted row", [celticsRow?.userId, celticsRow?.homeTeam, celticsRow?.gameTime.toISOString(), celticsRow?.odds, celticsRow?.betDetail], [users.main, "Boston Celtics", at(0, 0, 5), -120, "Celtics ML"]);

      const namedBills = byLine(`${WEEKDAY(6)} Bills ML -150`)[0];
      expect(`'${WEEKDAY(6)} Bills ML' -> the game that day (+6 days), not the next one`, namedBills?.status === "accepted" ? namedBills.game : null, { away: "Buffalo Bills", home: "Miami Dolphins", startsAt: at(6, 13) });
      const nextBills = byLine("Bills +3 -110")[0];
      expect("'Bills +3' with no game today -> the next game (+3 days)", nextBills?.status === "accepted" ? [nextBills.game, nextBills.market, nextBills.line] : null, [{ away: "Pittsburgh Steelers", home: "Buffalo Bills", startsAt: at(3, 13) }, "SPREAD", 3]);

      // needs_review: the review item exists and the candidates carry their games
      const jets = byLine("Jets ML -140")[0];
      if (jets?.status !== "needs_review") throw new Error("Jets line not needs_review");
      expect("Jets -> needs_review ambiguous_team", jets.reason, "ambiguous_team");
      const item = jets.reviewItemId ? await prisma.ingestReviewItem.findUnique({ where: { id: jets.reviewItemId }, select: { ingestBatchId: true, lineText: true, status: true } }) : null;
      expect("needs_review carries the id of its PENDING review item in this batch", [item?.ingestBatchId, item?.lineText, item?.status], [res.batchId, "Jets ML -140", "PENDING"]);
      expect(
        "the candidates carry each answer's matched game",
        jets.candidates.map((c) => [c.league, c.game?.home ?? null]).sort(),
        [["NFL", "New York Jets"], ["NHL", "Winnipeg Jets"]]
      );

      // the day rule reached the matcher, with the named day read from the line
      expect("the day rule was used, with today as the request day", dayRulesSeen.length > 0 && dayRulesSeen.every((d) => d.requestDay === TODAY), true);
      expect("the named day came from the line's own text", dayRulesSeen.some((d) => d.namedDay === addDaysToDateKey(TODAY, 6)), true);

      // counts on the response agree with the outcomes
      const accepted = seen.filter((s) => s.o.status === "accepted").length;
      expect("response imported = accepted outcomes", "imported" in res ? res.imported : -1, accepted);
      expect("response pendingReview = needs_review outcomes", "pendingReview" in res ? res.pendingReview : -1, seen.filter((s) => s.o.status === "needs_review").length);
    }

    // ---------- 4. resend of the same sourceKey ----------
    {
      const key = `${sourceKeyPrefix}${token.id}:resend`;
      const first = await ingestBatch({ type: "API_TOKEN", tokenId: token.id, sourceKey: key }, { userId: users.main, day: TODAY, text: "Bot Capper\nKnicks ML -130" }, { allowedLeagues, realTimeIngest: false, dayRule: { requestDay: TODAY }, skipRecipientFanOut: true });
      const calls: string[] = [];
      const again = await ingestBatch(
        { type: "API_TOKEN", tokenId: token.id, sourceKey: key },
        { userId: users.main, day: TODAY, text: "Bot Capper\nKnicks ML -130" },
        { allowedLeagues, realTimeIngest: false, dayRule: { requestDay: TODAY }, skipRecipientFanOut: true, onLineOutcome: (raw) => calls.push(raw) }
      );
      expect("a resend of the same sourceKey is a duplicate of the first batch", [again.status, again.batchId], ["duplicate", first.batchId]);
      expect("...and reports no line outcomes", calls.length, 0);
    }

    expect("the recipient never received a token batch's pick", await prisma.pick.count({ where: { userId: users.recipient, capper: { name: "Bot Capper" } } }), 0);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures > 0 ? 1 : 0);
  });
