// Bot API tokens, PR 4: POST /api/v1/picks (route + server/data/api-picks.ts) against a LOCAL database.
//   1. route: 401 / 429 from authenticateBearer pass through; validation errors are 400 {error, detail}; a valid
//      request is 200 {results}.
//   2. a mixed request: accepted / needs_review / rejected, results in request order; a final game the same day is
//      accepted; game_not_scheduled_yet vs no_game_found; submissions + one API_TOKEN batch (tokenId, sourceKey).
//   3. resending: ACCEPTED returns its stored result unchanged (no new batch line); NEEDS_REVIEW dismisses the old
//      item and replaces it; REJECTED is reprocessed.
//   4. the review queue: resolving makes the submission ACCEPTED (a resend returns that pick); dismissing makes it
//      DISMISSED (a resend reprocesses it); "Picks (7d)" counts the ACCEPTED ones.
//   5. no recipient fan-out (the active-recipient fixture from ingest-batch-acceptance-test.ts).
//
// Deterministic: the same fixed board and stubs as ingest-batch-acceptance-test.ts (the REAL day-rule matcher over a
// board built around today's Eastern date). Writes fixtures under throwaway users and deletes them by id. Run with:
//   npx tsx src/server/data/api-picks-acceptance-test.ts   (DATABASE_URL must be localhost)
import { parseCatalog } from "@/lib/parse-catalog";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { addDaysToDateKey, easternDateKey, easternWallTime } from "@/lib/dates";
import { teamNameEndsWith } from "@/lib/team-name-match";
import { tokenRequestDay } from "@/lib/ingest-line-outcome";
import { canonicalApiPickResult, type ApiPickResult } from "@/lib/api-pick-result";
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

const PREFIX = "__ApiPicks__";
const TODAY = tokenRequestDay(new Date());
const at = (dayOffset: number, hour: number, minute = 0) => new Date(easternWallTime(addDaysToDateKey(TODAY, dayOffset), hour).getTime() + minute * 60000).toISOString();
const WEEKDAY = (offset: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(addDaysToDateKey(TODAY, offset) + "T12:00:00Z"));

// ---- the fixed board (as in ingest-batch-acceptance-test.ts) ----
type Fixture = { sportKey: string; id: string; home: string; away: string; commenceTime: string; status: ScoreGame["status"] | "odds" };
const BOARD: Fixture[] = [
  { sportKey: "basketball_nba", id: "lakers-today", home: "Los Angeles Lakers", away: "Golden State Warriors", commenceTime: at(0, 22), status: "preview" },
  { sportKey: "basketball_nba", id: "knicks-today", home: "New York Knicks", away: "Miami Heat", commenceTime: at(0, 19, 30), status: "preview" },
  // Today's Celtics game is already FINAL; the bot API still takes it (same-day final).
  { sportKey: "basketball_nba", id: "celtics-today-final", home: "Boston Celtics", away: "Orlando Magic", commenceTime: at(0, 0, 5), status: "final" },
  // NBA games are stored for today and tomorrow only (tomorrow: Celtics at Bulls) - nothing from day +2 on.
  { sportKey: "basketball_nba", id: "celtics-tomorrow", home: "Chicago Bulls", away: "Boston Celtics", commenceTime: at(1, 20), status: "preview" },
  { sportKey: "americanfootball_nfl", id: "bills-plus3", home: "Buffalo Bills", away: "Pittsburgh Steelers", commenceTime: at(3, 13), status: "odds" },
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
// What leagueDaySlateStored answers over this board (the endpoint's split of no_game_found).
const boardHasGamesOnDay = async (sportKey: string, day: string) => BOARD.some((b) => b.sportKey === sportKey && easternDateKey(new Date(b.commenceTime)) === day);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realOdds = require("./odds") as typeof import("./odds");
type Opts = { gameNumber?: 1 | 2 | null; excludeFinal?: boolean; day?: TokenDayMatch };
const match = (sportKey: string, matches: (g: { homeTeam: string; awayTeam: string }) => boolean, opts: Opts = {}) =>
  opts.day
    ? realOdds.resolveTokenDayGameFromFeeds(scoresFor(sportKey), oddsFor(sportKey), matches, new Date(), opts.gameNumber ?? null, opts.day, [], sportKey)
    : realOdds.resolveScheduleGameFromFeeds(scoresFor(sportKey), oddsFor(sportKey), matches, new Date(), opts.gameNumber ?? null, [], { excludeFinal: opts.excludeFinal, sportKey });
const ends = (sportKey: string, nick: string) => (g: { homeTeam: string; awayTeam: string }) =>
  teamNameEndsWith(g.homeTeam, nick, sportKey) || teamNameEndsWith(g.awayTeam, nick, sportKey);
stub("./odds", {
  ...realOdds,
  resolveGameForNickname: async (sportKey: string, nick: string, opts?: Opts) => match(sportKey, ends(sportKey, nick), opts),
  resolveGameForTeams: async (sportKey: string, a: string, b: string, opts?: Opts) =>
    match(sportKey, (g) => ends(sportKey, a)(g) && ends(sportKey, b)(g), opts),
  leagueDaySlateStored: boardHasGamesOnDay,
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
  delete process.env.INGEST_ALLOWED_LEAGUES; // the default allowlist

  const { prisma } = await import("@/lib/prisma");
  const { submitApiPicks } = await import("@/server/data/api-picks");
  const { resolveReviewItem, dismissReviewItem } = await import("@/server/data/ingest-review");
  const { createApiTokenForUser, listApiTokensForUser } = await import("@/server/data/api-tokens");
  const { parseAllowedLeagues } = await import("@/lib/ingest-filters");
  const route = await import("@/app/api/v1/picks/route");
  const allowedLeagues = parseAllowedLeagues(undefined);

  const users = { main: PREFIX + "main", recipient: PREFIX + "recipient" };
  const ids = [users.main, users.recipient];
  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));

  const cleanup = async () => {
    const idsOf = async (rows: Promise<{ id: string }[]>) => (await rows).map((r) => r.id);
    const tokenIds = await idsOf(prisma.apiToken.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const batchIds = await idsOf(prisma.ingestBatch.findMany({ where: { tokenId: { in: tokenIds } }, select: { id: true } }));
    const subIds = await idsOf(prisma.apiPickSubmission.findMany({ where: { tokenId: { in: tokenIds } }, select: { id: true } }));
    const itemIds = await idsOf(prisma.ingestReviewItem.findMany({ where: { OR: [{ userId: { in: ids } }, { ingestBatchId: { in: batchIds } }] }, select: { id: true } }));
    const skippedIds = await idsOf(prisma.importSkippedLine.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const runIds = await idsOf(prisma.importRun.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const pickIds = await idsOf(prisma.pick.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    const capperIds = await idsOf(prisma.capper.findMany({ where: { userId: { in: ids } }, select: { id: true } }));
    if (subIds.length) await prisma.apiPickSubmission.deleteMany({ where: { id: { in: subIds } } });
    if (itemIds.length) await prisma.ingestReviewItem.deleteMany({ where: { id: { in: itemIds } } });
    if (batchIds.length) await prisma.ingestBatch.deleteMany({ where: { id: { in: batchIds } } });
    if (tokenIds.length) await prisma.apiToken.deleteMany({ where: { id: { in: tokenIds } } });
    if (skippedIds.length) await prisma.importSkippedLine.deleteMany({ where: { id: { in: skippedIds } } });
    if (runIds.length) await prisma.importRun.deleteMany({ where: { id: { in: runIds } } });
    if (pickIds.length) await prisma.pick.deleteMany({ where: { id: { in: pickIds } } });
    if (capperIds.length) await prisma.capper.deleteMany({ where: { id: { in: capperIds } } });
    await prisma.pickRecipient.deleteMany({ where: { sourceUserId: users.main, recipientUserId: users.recipient } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    const sportIds = (await prisma.sport.findMany({ select: { id: true, name: true } })).filter((s) => !sportsBefore.has(s.name)).map((s) => s.id);
    if (sportIds.length) await prisma.sport.deleteMany({ where: { id: { in: sportIds } } });
  };
  await cleanup();

  const post = (body: unknown, authorization: string | null) => {
    const headers = new Headers({ "content-type": "application/json", "x-real-ip": "198.51.100.4" });
    if (authorization) headers.set("authorization", authorization);
    return route.POST(new Request("https://example.invalid/api/v1/picks", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  };
  const sub = (tokenId: string, clientId: string) =>
    prisma.apiPickSubmission.findUnique({
      where: { tokenId_clientId: { tokenId, clientId } },
      select: { status: true, pickId: true, reviewItemId: true, reason: true, batchId: true, result: true },
    });
  const summary = (r: ApiPickResult) => [r.client_id, r.status, r.status === "accepted" ? r.pick.league : r.reason];

  try {
    for (const id of ids) await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    await prisma.pickRecipient.create({ data: { sourceUserId: users.main, recipientUserId: users.recipient, status: "ACTIVE" } });
    const created = await createApiTokenForUser(users.main, "test bot");
    if (!created.ok) throw new Error("token fixture failed");
    const token = { id: created.id, bearer: "Bearer " + created.rawToken };
    const auth = { tokenId: token.id, userId: users.main };
    const submit = (capper: string, picks: { client_id: string; text: string }[]) =>
      submitApiPicks(auth, { capper, picks }, { allowedLeagues, hasGamesOnDay: boardHasGamesOnDay });

    // ---------- 1. route: auth pass-through, validation, a valid request ----------
    {
      const okBody = { capper: "Route Capper", picks: [{ client_id: "r1", text: "Knicks ML -130" }] };
      const noAuth = await post(okBody, null);
      expect("no Authorization header -> 401 invalid_token (authenticateBearer's response)", [noAuth.status, await noAuth.json()], [401, { error: "invalid_token" }]);
      const badAuth = await post(okBody, "Bearer bv_live_" + "x".repeat(43));
      expect("unknown token -> 401 invalid_token", [badAuth.status, await badAuth.json()], [401, { error: "invalid_token" }]);

      const invalid = async (label: string, body: unknown) => {
        const r = await post(body, token.bearer);
        const j = (await r.json()) as { error?: string; detail?: string };
        expect(`400 invalid_request: ${label}`, [r.status, j.error, typeof j.detail === "string" && j.detail.length > 0], [400, "invalid_request", true]);
      };
      await invalid("malformed JSON", "{nope");
      await invalid("not an object", [1]);
      await invalid("capper missing", { picks: okBody.picks });
      await invalid("capper empty", { ...okBody, capper: "  " });
      await invalid("capper over 100 characters", { ...okBody, capper: "c".repeat(101) });
      await invalid("no picks", { ...okBody, picks: [] });
      await invalid("51 picks", { ...okBody, picks: Array.from({ length: 51 }, (_, i) => ({ client_id: "p" + i, text: "Knicks ML" })) });
      await invalid("client_id empty", { ...okBody, picks: [{ client_id: "", text: "Knicks ML" }] });
      await invalid("client_id over 100 characters", { ...okBody, picks: [{ client_id: "i".repeat(101), text: "Knicks ML" }] });
      await invalid("text empty", { ...okBody, picks: [{ client_id: "a", text: " " }] });
      await invalid("text over 500 characters", { ...okBody, picks: [{ client_id: "a", text: "t".repeat(501) }] });
      await invalid("text not a string", { ...okBody, picks: [{ client_id: "a", text: 5 }] });
      await invalid("client_id repeated in one request", { ...okBody, picks: [{ client_id: "a", text: "Knicks ML" }, { client_id: "a", text: "Lakers ML" }] });
      await invalid("body over 64 KB", { ...okBody, pad: "x".repeat(65 * 1024) });
      expect("no batch was written by a refused request", await prisma.ingestBatch.count({ where: { tokenId: token.id } }), 0);

      const ok = await post(okBody, token.bearer);
      const okJson = (await ok.json()) as { results: ApiPickResult[] };
      expect("valid request -> 200 with one result, accepted", [ok.status, okJson.results.map(summary)], [200, [["r1", "accepted", "NBA"]]]);

      // 429: the token's minute window is full.
      await prisma.apiToken.update({ where: { id: token.id }, data: { windowCount: 60, windowStart: new Date() } });
      const limited = await post(okBody, token.bearer);
      expect("61st request in the minute -> 429 rate_limited (authenticateBearer's response)", [limited.status, ((await limited.json()) as { error: string }).error], [429, "rate_limited"]);
      await prisma.apiToken.update({ where: { id: token.id }, data: { windowCount: 0 } });
    }

    // ---------- 2. a mixed request ----------
    const mixed = [
      { client_id: "c-lakers", text: "Lakers -3 -110" }, // accepted
      { client_id: "c-jets", text: "Jets ML -140" }, // needs_review (NFL or NHL)
      { client_id: "c-chiefs", text: "Chiefs ML -150" }, // no Chiefs game, no day named -> no_game_found
      { client_id: "c-celtics", text: "Celtics ML -120" }, // today's FINAL game -> accepted
      { client_id: "c-later", text: `${WEEKDAY(3)} Lakers ML -150` }, // day +3: no NBA game stored that day -> game_not_scheduled_yet
      { client_id: "c-knicks-tmrw", text: `${WEEKDAY(1)} Knicks ML -130` }, // day +1: NBA games stored, none for the Knicks -> no_game_found
      { client_id: "c-junk", text: "zzqq nonsense line 99" }, // unparseable
    ];
    const first = await submit("Bot Capper", mixed);
    console.log("results:", JSON.stringify(first.map(summary)));
    expect("one result per pick, in request order", first.map((r) => r.client_id), mixed.map((p) => p.client_id));
    expect(
      "statuses and reasons",
      first.map((r) => [r.status, r.status === "accepted" ? "ok" : r.reason]),
      [
        ["accepted", "ok"],
        ["needs_review", "ambiguous_team"],
        ["rejected", "no_game_found"],
        ["accepted", "ok"],
        ["rejected", "game_not_scheduled_yet"],
        ["rejected", "no_game_found"],
        ["rejected", "unparseable"],
      ]
    );
    const celtics = first[3];
    expect(
      "a final game the same day is accepted, with its game",
      celtics.status === "accepted" ? [celtics.pick.game, celtics.pick.market, celtics.pick.odds] : null,
      [{ away: "Orlando Magic", home: "Boston Celtics", startsAt: at(0, 0, 5) }, "MONEYLINE", -120]
    );
    const lakers = first[0];
    const lakersRow = lakers.status === "accepted" ? await prisma.pick.findUnique({ where: { id: lakers.pick.pickId }, select: { userId: true, homeTeam: true, line: true } }) : null;
    expect("accepted pickId is the real pick", [lakersRow?.userId, lakersRow?.homeTeam, lakers.status === "accepted" ? lakers.pick.line : null], [users.main, "Los Angeles Lakers", -3]);
    const jets = first[1];
    expect(
      "needs_review lists the candidates with their games",
      jets.status === "needs_review" ? jets.candidates.map((c) => [c.league, c.game?.home ?? null]).sort() : null,
      [["NFL", "New York Jets"], ["NHL", "Winnipeg Jets"]]
    );

    const jetsSub = await sub(token.id, "c-jets");
    const lakersSub = await sub(token.id, "c-lakers");
    const chiefsSub = await sub(token.id, "c-chiefs");
    expect("submissions: statuses", [lakersSub?.status, jetsSub?.status, chiefsSub?.status], ["ACCEPTED", "NEEDS_REVIEW", "REJECTED"]);
    expect("submissions: pickId / reason / result snapshot", [lakersSub?.pickId === (lakers.status === "accepted" ? lakers.pick.pickId : 0), chiefsSub?.reason, JSON.stringify(canonicalApiPickResult(lakersSub?.result as ApiPickResult)) === JSON.stringify(lakers)], [true, "no_game_found", true]);
    const jetsItem = jetsSub?.reviewItemId ? await prisma.ingestReviewItem.findUnique({ where: { id: jetsSub.reviewItemId }, select: { status: true, ingestBatchId: true } }) : null;
    expect("needs_review submission names its PENDING review item in the same batch", [jetsItem?.status, jetsItem?.ingestBatchId === jetsSub?.batchId], ["PENDING", true]);
    const batch = await prisma.ingestBatch.findUnique({ where: { id: lakersSub!.batchId }, select: { sourceType: true, tokenId: true, sourceKey: true, text: true } });
    expect(
      "one API_TOKEN batch: tokenId set, sourceKey tok:<tokenId>:<uuid>, text = capper + one line per pick",
      [batch?.sourceType, batch?.tokenId, /^tok:[^:]+:[0-9a-f-]{36}$/.test(batch?.sourceKey ?? "") && batch?.sourceKey?.startsWith(`tok:${token.id}:`), batch?.text.split("\n").length],
      ["API_TOKEN", token.id, true, 1 + mixed.length]
    );

    // ---------- 3. resending ----------
    const batchesBefore = await prisma.ingestBatch.count({ where: { tokenId: token.id } });
    const picksBefore = await prisma.pick.count({ where: { userId: users.main } });
    const again = await submit("Bot Capper", [mixed[0], mixed[1], mixed[2]]);
    expect("resend: ACCEPTED returns its stored result unchanged", JSON.stringify(again[0]), JSON.stringify(first[0]));
    expect("resend: no new pick for the accepted one", await prisma.pick.count({ where: { userId: users.main } }), picksBefore);
    const oldItem = await prisma.ingestReviewItem.findUnique({ where: { id: jetsSub!.reviewItemId! }, select: { status: true } });
    expect("resend: the NEEDS_REVIEW pick's old review item is DISMISSED", oldItem?.status, "DISMISSED");
    const jetsSub2 = await sub(token.id, "c-jets");
    expect("resend: ...and it is replaced by a new PENDING item", [again[1].status, jetsSub2?.status, jetsSub2?.reviewItemId !== jetsSub?.reviewItemId], ["needs_review", "NEEDS_REVIEW", true]);
    expect("resend: the PENDING count for the user is 1 (the badge dropped the old one)", await prisma.ingestReviewItem.count({ where: { userId: users.main, status: "PENDING" } }), 1);
    const chiefsSub2 = await sub(token.id, "c-chiefs");
    expect("resend: REJECTED is reprocessed (a new batch)", [again[2].status, chiefsSub2?.batchId !== chiefsSub?.batchId], ["rejected", true]);
    const resendBatches = await prisma.ingestBatch.findMany({ where: { tokenId: token.id }, select: { text: true }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(
      "resend: one new batch, holding only the reprocessed picks",
      [(await prisma.ingestBatch.count({ where: { tokenId: token.id } })) - batchesBefore, resendBatches[0]?.text],
      [1, ["Bot Capper", "Jets ML -140", "Chiefs ML -150"].join("\n")]
    );

    // ---------- 4. the review queue keeps submissions in sync ----------
    const resolved = await resolveReviewItem(users.main, jetsSub2!.reviewItemId!, "opt:0");
    expect("resolving the item succeeds", resolved.ok, true);
    const jetsSub3 = await sub(token.id, "c-jets");
    const resolvedResult = jetsSub3?.result as ApiPickResult | undefined;
    expect(
      "resolve -> submission ACCEPTED with the pickId and an accepted result snapshot",
      [jetsSub3?.status, resolved.ok && jetsSub3?.pickId === resolved.pickId, resolvedResult?.status, resolvedResult?.client_id, resolvedResult?.status === "accepted" ? resolvedResult.pick.pickId === jetsSub3?.pickId : false],
      ["ACCEPTED", true, "accepted", "c-jets", true]
    );
    const afterResolve = await submit("Bot Capper", [mixed[1]]);
    expect("a resend after resolving returns the resolved pick", JSON.stringify(afterResolve[0]), JSON.stringify(canonicalApiPickResult(jetsSub3?.result as ApiPickResult)));

    const zeta = await submit("Zeta Sharp", [{ client_id: "z-jets", text: "Jets ML -150" }]);
    expect("second capper's Jets pick -> needs_review", zeta[0].status, "needs_review");
    const zetaSub = await sub(token.id, "z-jets");
    const dismissed = await dismissReviewItem(users.main, zetaSub!.reviewItemId!);
    expect("dismissing the item succeeds", dismissed.ok, true);
    expect("dismiss -> submission DISMISSED", (await sub(token.id, "z-jets"))?.status, "DISMISSED");
    const zetaAgain = await submit("Zeta Sharp", [{ client_id: "z-jets", text: "Jets ML -150" }]);
    const zetaSub2 = await sub(token.id, "z-jets");
    expect("a resend after dismissing is reprocessed (new item)", [zetaAgain[0].status, zetaSub2?.status, zetaSub2?.reviewItemId !== zetaSub?.reviewItemId], ["needs_review", "NEEDS_REVIEW", true]);

    // Picks (7d): r1, c-lakers, c-celtics and the resolved c-jets.
    const listed = await listApiTokensForUser(users.main);
    expect("Picks (7d) counts the ACCEPTED submissions, the resolved one included", listed.find((t) => t.id === token.id)?.picksLast7Days, 4);

    // ---------- 5. no recipient fan-out ----------
    expect("the active recipient received none of the token's picks (direct or resolved)", await prisma.pick.count({ where: { userId: users.recipient } }), 0);
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
