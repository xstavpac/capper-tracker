// Telegram ingest, end to end against a LOCAL database: the route (auth, validation, 503, duplicate, FAILED), the
// unattended import of a two-capper fixture batch (filters, review queue), and resolveReviewItem /
// dismissReviewItem.
//
// Deterministic: the game lookups (resolveGameForNickname / ForTeams and the market-price reads) are replaced with a
// fixed board, the ambiguous-team schedule checkers answer "can't tell", and the network-backed recovery pass and feed
// reads are stubbed. Everything else is the real pipeline and the real database. Writes fixtures under throwaway
// users and deletes them by id. Run with:
//   npx tsx src/server/data/telegram-ingest-acceptance-test.ts   (DATABASE_URL must be localhost)
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

const PREFIX = "__Ingest__";
const H = 3600000;
const NOW = Date.now();

// ---- the fixed board ----
type Fake = { sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string };
const at = (i: number) => new Date(NOW + (2 + i) * H).toISOString();
const BOARD: Fake[] = [
  { sportKey: "basketball_nba", homeTeam: "Los Angeles Lakers", awayTeam: "Boston Celtics", commenceTime: at(0) },
  { sportKey: "basketball_nba", homeTeam: "New York Knicks", awayTeam: "Miami Heat", commenceTime: at(1) },
  { sportKey: "americanfootball_nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers", commenceTime: at(2) },
  { sportKey: "americanfootball_nfl", homeTeam: "Chicago Bears", awayTeam: "Detroit Lions", commenceTime: at(3) },
  { sportKey: "americanfootball_nfl", homeTeam: "New York Jets", awayTeam: "Buffalo Bills", commenceTime: at(4) },
  { sportKey: "icehockey_nhl", homeTeam: "Winnipeg Jets", awayTeam: "Dallas Stars", commenceTime: at(5) },
  { sportKey: "baseball_mlb", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", commenceTime: at(6) },
];
const MARKET_TOTAL = 8.5;
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
  findMarketTotalLine: async () => MARKET_TOTAL,
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
stub("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const TOKEN = "test-token-" + "x".repeat(24);
const url = "http://localhost/api/ingest/telegram";
const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, headers: Record<string, string> = { "x-picks-token": TOKEN }) =>
  route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

const FIXTURE = [
  "Alpha Capper",
  "Lakers -3 -110", // clean NBA -> imported
  "Chiefs ML -150", // clean NFL -> imported
  "Doosan Bears ML -120", // KBO -> LEAGUE_NOT_ALLOWED
  "Bears + Cubs MLP", // COMBINED_BET
  "Bears / Cubs / Lions", // COMBINED_BET
  "Bears ML & Cubs ML", // COMBINED_BET
  "Bears ML + Cubs ML", // COMBINED_BET
  "Cubs +1.5 -120", // NOT combined
  "Cubs ML +120", // NOT combined
  "Bears +3 -110", // NOT combined; Bears is NFL or KBO -> the allowed league wins
  "Over 8.5 +105", // NOT combined (no team: simply unplaceable)
  "Jets ML -140", // NFL or NHL, nothing to tell them apart -> review
  "zzqq nonsense line 99", // unparseable -> skipped
  "",
  "Beta Capper",
  "Knicks ML -130", // clean NBA -> imported
  "Jets ML -125", // review
].join("\n");

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
  const route = await import("@/app/api/ingest/telegram/route");
  const { resolveReviewItem, dismissReviewItem } = await import("@/server/data/ingest-review");
  const { isInfraError } = await import("@/server/data/telegram-ingest");
  const { Prisma } = await import("@prisma/client");

  const users = { main: PREFIX + "main", other: PREFIX + "other", ghost: PREFIX + "ghost-never-created" };
  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));
  const channelIds = [PREFIX + "chan"];
  const picksOf = (userId: string) =>
    prisma.pick.findMany({ where: { userId }, select: { id: true, betDetail: true, homeTeam: true, awayTeam: true, gameTime: true, odds: true, line: true, capper: { select: { name: true } }, sport: { select: { name: true } } }, orderBy: { betDetail: "asc" } });

  try {
    for (const id of [users.main, users.other]) {
      await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    }
    process.env.INGEST_USER_ID = users.main;
    delete process.env.INGEST_ALLOWED_LEAGUES; // the default allowlist (no NCAAB)

    // ---------- route: configuration, auth, validation ----------
    delete process.env.PICKS_INGEST_TOKEN;
    expect("503 when PICKS_INGEST_TOKEN is not set", (await post(route, { channelId: "c", messageId: 1, day: "2026-11-02", text: "x" })).status, 503);
    process.env.PICKS_INGEST_TOKEN = TOKEN;
    const saved = process.env.INGEST_USER_ID;
    delete process.env.INGEST_USER_ID;
    expect("503 when INGEST_USER_ID is not set", (await post(route, { channelId: "c", messageId: 1, day: "2026-11-02", text: "x" })).status, 503);
    process.env.INGEST_USER_ID = saved;

    const ok = { channelId: channelIds[0], messageId: 1, day: "2026-11-02", text: "Alpha\nLakers -3 -110" };
    expect("401 with no token", (await post(route, ok, {})).status, 401);
    expect("401 with a wrong token", (await post(route, ok, { "x-picks-token": "nope" })).status, 401);
    expect("401 with a wrong token of the same length", (await post(route, ok, { "x-picks-token": "y".repeat(TOKEN.length) })).status, 401);
    expect("401 with a token that is a prefix", (await post(route, ok, { "x-picks-token": TOKEN.slice(0, -1) })).status, 401);
    expect("no batch is stored for an unauthorized call", await prisma.ingestBatch.count({ where: { channelId: { in: channelIds } } }), 0);

    expect("400 for malformed JSON", (await post(route, "{not json")).status, 400);
    expect("400 for a non-object body", (await post(route, "[1,2]")).status, 400);
    expect("400 for a missing channelId", (await post(route, { messageId: 1, day: "2026-11-02", text: "x" })).status, 400);
    expect("400 for a non-integer messageId", (await post(route, { ...ok, messageId: 1.5 })).status, 400);
    expect("400 for a string messageId", (await post(route, { ...ok, messageId: "12" })).status, 400);
    expect("400 for a bad day", (await post(route, { ...ok, day: "11/02/2026" })).status, 400);
    expect("400 for an impossible day", (await post(route, { ...ok, day: "2026-13-45" })).status, 400);
    expect("400 for empty text", (await post(route, { ...ok, text: "   " })).status, 400);
    expect("400 for text over 20 KB", (await post(route, { ...ok, text: "a".repeat(20 * 1024 + 1) })).status, 400);
    expect("text of exactly 20 KB passes validation", (await post(route, { ...ok, messageId: 2, text: "Alpha\n" + "a".repeat(20 * 1024 - 6) })).status, 200);
    expect("400 for a body over the hard cap", (await post(route, { ...ok, text: "a".repeat(70 * 1024) })).status, 400);

    // ---------- the fixture batch ----------
    const res = await post(route, { channelId: channelIds[0], messageId: 100, day: "2026-11-02", text: FIXTURE });
    const body = (await res.json()) as { status: string; batchId: string; imported: number; skipped: number; pendingReview: number };
    console.log("fixture response:", JSON.stringify(body));
    expect("fixture: HTTP 200", res.status, 200);
    expect("fixture: partial (skips + review items)", body.status, "partial");
    const picks = await picksOf(users.main);
    console.log("imported:", picks.map((p) => `${p.capper.name} | ${p.sport.name} | ${p.betDetail} | ${p.homeTeam}`).join("\n          "));
    expect(
      "fixture: imported picks (NBA, NFL, the allowed-league Bears, both Cubs bets, Knicks)",
      picks.map((p) => `${p.capper.name}|${p.sport.name}|${p.betDetail}`).sort(),
      [
        "Alpha Capper|MLB|Cubs +1.5",
        "Alpha Capper|MLB|Cubs ML",
        "Alpha Capper|NBA|Lakers -3",
        "Alpha Capper|NFL|Bears +3",
        "Alpha Capper|NFL|Chiefs ML",
        "Beta Capper|NBA|Knicks ML",
      ]
    );
    expect("fixture: imported count", body.imported, 6);
    expect("fixture: two review items (one Jets line per capper)", body.pendingReview, 2);

    const skipped = await prisma.importSkippedLine.findMany({ where: { userId: users.main }, select: { stage: true, rawText: true, capperName: true, guessedSport: true } });
    const byStage = (s: string) => skipped.filter((x) => x.stage === s).map((x) => x.rawText).sort();
    expect("COMBINED_BET: the four joined lines, none of the single bets", byStage("COMBINED_BET"), ["Bears + Cubs MLP", "Bears / Cubs / Lions", "Bears ML & Cubs ML", "Bears ML + Cubs ML"]);
    expect("COMBINED_BET: filed under the capper whose block it was in", [...new Set(skipped.filter((x) => x.stage === "COMBINED_BET").map((x) => x.capperName))], ["Alpha Capper"]);
    expect("LEAGUE_NOT_ALLOWED: the KBO line", byStage("LEAGUE_NOT_ALLOWED"), ["Doosan Bears ML -120"]);
    expect("no single bet was skipped as combined", skipped.some((x) => x.stage === "COMBINED_BET" && /^(Cubs \+1\.5|Cubs ML \+120|Bears \+3|Over 8\.5)/.test(x.rawText)), false);
    expect("the unparseable line is skipped (not imported, not a review item)", skipped.some((x) => x.rawText.startsWith("zzqq")), true);

    const batch = await prisma.ingestBatch.findUnique({ where: { id: body.batchId }, select: { status: true, importedCount: true, skippedCount: true, pendingReviewCount: true, text: true, error: true } });
    expect("batch row: status, counts and the raw text kept", [batch?.status, batch?.importedCount, batch?.pendingReviewCount, batch?.text === FIXTURE], ["PARTIAL", 6, 2, true]);
    expect("batch row: skippedCount matches the response", batch?.skippedCount, body.skipped);

    // ---------- duplicate ----------
    const dup = await post(route, { channelId: channelIds[0], messageId: 100, day: "2026-11-02", text: FIXTURE });
    expect("re-POST of the same (channelId, messageId) -> duplicate", [dup.status, await dup.json()], [200, { status: "duplicate", batchId: body.batchId }]);
    expect("duplicate imported nothing more", (await picksOf(users.main)).length, 6);
    expect("duplicate created no second batch", await prisma.ingestBatch.count({ where: { channelId: { in: channelIds }, messageId: 100 } }), 1);

    // ---------- review items ----------
    const items = await prisma.ingestReviewItem.findMany({ where: { ingestBatchId: body.batchId }, orderBy: { capperName: "asc" } });
    expect("review items: type, status, day, user", items.map((i) => [i.questionType, i.status, i.day, i.userId, i.capperName]), [
      ["AMBIGUOUS_TEAM", "PENDING", "2026-11-02", users.main, "Alpha Capper"],
      ["AMBIGUOUS_TEAM", "PENDING", "2026-11-02", users.main, "Beta Capper"],
    ]);
    const opts = items[0].options as { choices: { id: string; label: string; sport?: string; pick: { homeTeam: string; awayTeam: string; gameTime: string; odds: number; betDetail: string } | null }[] };
    expect("options: one choice per league the form would have offered", opts.choices.map((c) => c.sport).sort(), ["NFL", "NHL"]);
    const nfl = opts.choices.find((c) => c.sport === "NFL");
    const nhl = opts.choices.find((c) => c.sport === "NHL");
    expect("options: NFL choice carries the matched game", [nfl?.pick?.homeTeam, nfl?.pick?.awayTeam, nfl?.pick?.odds], ["New York Jets", "Buffalo Bills", -140]);
    expect("options: NHL choice carries ITS matched game", [nhl?.pick?.homeTeam, nhl?.pick?.awayTeam], ["Winnipeg Jets", "Dallas Stars"]);
    expect("options: matched game time is the board's, not the answer date's", nfl?.pick?.gameTime, BOARD[4].commenceTime);
    expect("no pick was created for the held lines", picks.some((p) => /Jets/.test(p.betDetail ?? "")), false);

    // resolveReviewItem
    expect("resolve: another user cannot answer it", await resolveReviewItem(users.other, items[0].id, nfl!.id), {
      ok: false, error: "not_found", message: "No such review item.",
    });
    const bad = await resolveReviewItem(users.main, items[0].id, "opt:99");
    expect("resolve: unknown choice refused", [bad.ok, !bad.ok && bad.error], [false, "bad_choice"]);
    const r1 = await resolveReviewItem(users.main, items[0].id, nfl!.id);
    expect("resolve: ok", r1.ok, true);
    const after = await picksOf(users.main);
    const jets = after.find((p) => /Jets/.test(p.betDetail ?? "") && p.capper.name === "Alpha Capper");
    expect("resolve: the NFL Jets pick exists on the matched game, filed as the answer chose", [jets?.sport.name, jets?.homeTeam, jets?.awayTeam, jets?.gameTime.toISOString(), jets?.odds], ["NFL", "New York Jets", "Buffalo Bills", BOARD[4].commenceTime, -140]);
    const item0 = await prisma.ingestReviewItem.findUnique({ where: { id: items[0].id }, select: { status: true, resolvedPickId: true, resolvedAt: true } });
    expect("resolve: item RESOLVED with the pick id and time", [item0?.status, item0?.resolvedPickId === jets?.id, item0?.resolvedAt !== null], ["RESOLVED", true, true]);
    const again = await resolveReviewItem(users.main, items[0].id, nfl!.id);
    expect("resolve: a second answer is refused and inserts nothing", [again.ok, !again.ok && again.error, (await picksOf(users.main)).length], [false, "not_pending", after.length]);

    // dismissReviewItem
    expect("dismiss: another user cannot", await dismissReviewItem(users.other, items[1].id), { ok: false, error: "not_found" });
    expect("dismiss: ok", await dismissReviewItem(users.main, items[1].id), { ok: true });
    const item1 = await prisma.ingestReviewItem.findUnique({ where: { id: items[1].id }, select: { status: true, resolvedPickId: true, resolvedAt: true } });
    expect("dismiss: item DISMISSED, no pick", [item1?.status, item1?.resolvedPickId, item1?.resolvedAt !== null], ["DISMISSED", null, true]);
    expect("dismiss: creates no pick", (await picksOf(users.main)).length, after.length);
    expect("dismiss: a second dismiss is refused", await dismissReviewItem(users.main, items[1].id), { ok: false, error: "not_pending" });
    const afterDismiss = await resolveReviewItem(users.main, items[1].id, "opt:0");
    expect("resolve after dismiss is refused", [afterDismiss.ok, !afterDismiss.ok && afterDismiss.error], [false, "not_pending"]);

    // ---------- capper near-miss: never creates a capper ----------
    await prisma.capper.create({ data: { userId: users.main, name: "Gamma Capper", source: "OTHER" } });
    const cappersBefore = await prisma.capper.count({ where: { userId: users.main } });
    const fz = await (await post(route, { channelId: channelIds[0], messageId: 200, day: "2026-11-02", text: "Gama Capper\nCelt ML" })).json();
    // "Celt ML" is not a team; use a real pick under the near-miss name:
    const fz2 = await (await post(route, { channelId: channelIds[0], messageId: 201, day: "2026-11-02", text: "Gama Capper\nLakers +2 -110" })).json();
    void fz;
    expect("near-miss capper: pick is held for review, not imported", [fz2.imported, fz2.pendingReview], [0, 1]);
    expect("near-miss capper: no capper was created", await prisma.capper.count({ where: { userId: users.main } }), cappersBefore);
    const fzItem = await prisma.ingestReviewItem.findFirst({ where: { ingestBatchId: fz2.batchId }, select: { id: true, questionType: true, options: true } });
    expect("near-miss capper: CAPPER_FUZZY with the two capper choices", [fzItem?.questionType, (fzItem?.options as { choices: { id: string; capperName?: string }[] }).choices.map((c) => [c.id, c.capperName])], [
      "CAPPER_FUZZY",
      [["use-suggestion", "Gamma Capper"], ["new-capper", "Gama Capper"]],
    ]);
    const fr = await resolveReviewItem(users.main, fzItem!.id, "use-suggestion");
    expect("near-miss capper: answered 'use the existing one'", fr.ok, true);
    const lakers2 = (await picksOf(users.main)).find((p) => p.betDetail === "Lakers +2");
    expect("near-miss capper: pick filed under the existing capper; still no new capper", [lakers2?.capper.name, await prisma.capper.count({ where: { userId: users.main } })], ["Gamma Capper", cappersBefore]);

    // ---------- missing total line ----------
    const tl = await (await post(route, { channelId: channelIds[0], messageId: 300, day: "2026-11-02", text: "Gamma Capper\nCubs under a -110" })).json();
    expect("missing total line: held for review", [tl.imported, tl.pendingReview], [0, 1]);
    const tlItem = await prisma.ingestReviewItem.findFirst({ where: { ingestBatchId: tl.batchId }, select: { id: true, questionType: true, options: true } });
    const tlChoice = (tlItem?.options as { choices: { id: string; inferredLine?: number; pick: { homeTeam: string; line: number | null } | null }[] }).choices[0];
    expect("missing total line: proposed line and matched game stored", [tlItem?.questionType, tlChoice.inferredLine, tlChoice.pick?.homeTeam, tlChoice.pick?.line], ["MISSING_TOTAL_LINE", MARKET_TOTAL, "Chicago Cubs", MARKET_TOTAL]);
    const tr = await resolveReviewItem(users.main, tlItem!.id, "confirm");
    const total = (await picksOf(users.main)).find((p) => (p.betDetail ?? "").startsWith("Cubs under"));
    expect("missing total line: confirmed -> pick saved with the market line", [tr.ok, total?.line], [true, MARKET_TOTAL]);

    // ---------- FAILED path ----------
    const junk = await post(route, { channelId: channelIds[0], messageId: 400, day: "2026-11-02", text: "Alpha Capper\nzzqq nonsense line 99\nqqzz more nonsense 12" });
    const junkBody = await junk.json();
    expect("unparseable batch: HTTP 200 (so the reader does not retry it)", junk.status, 200);
    expect("unparseable batch: status failed, nothing imported", [junkBody.status, junkBody.imported], ["failed", 0]);
    expect("unparseable batch: stored FAILED with an error", await prisma.ingestBatch.findUnique({ where: { id: junkBody.batchId }, select: { status: true, error: true } }), { status: "FAILED", error: "No pick could be imported from this batch" });

    // an import that cannot be saved (the configured user does not exist): FAILED, 200, no 5xx
    process.env.INGEST_USER_ID = users.ghost;
    const ghost = await post(route, { channelId: channelIds[0], messageId: 500, day: "2026-11-02", text: "Alpha Capper\nKnicks ML -130" });
    const ghostBody = await ghost.json();
    expect("import that cannot be saved: 200 with status failed", [ghost.status, ghostBody.status], [200, "failed"]);
    process.env.INGEST_USER_ID = users.main;

    // an interrupted batch (stored, never finished) is finished by the retry, not reported as a duplicate
    await prisma.ingestBatch.create({ data: { channelId: channelIds[0], messageId: 600, day: "2026-11-02", text: "Beta Capper\nCeltics ML -135" } });
    const resumed = await (await post(route, { channelId: channelIds[0], messageId: 600, day: "2026-11-02", text: "Beta Capper\nCeltics ML -135" })).json();
    expect("a RECEIVED batch is finished on retry", [resumed.status, resumed.imported], ["imported", 1]);
    expect("...and then it is a duplicate", (await (await post(route, { channelId: channelIds[0], messageId: 600, day: "2026-11-02", text: "x" })).json()).status, "duplicate");

    // ---------- the allowlist is read from the environment ----------
    process.env.INGEST_ALLOWED_LEAGUES = "NFL";
    const nflOnly = await (await post(route, { channelId: channelIds[0], messageId: 700, day: "2026-11-02", text: "Delta Capper\nCelticsX\nLakers -4 -110\nChiefs -2 -110" })).json();
    expect("INGEST_ALLOWED_LEAGUES=NFL: NBA line skipped, NFL line imported", [nflOnly.imported], [1]);
    process.env.INGEST_ALLOWED_LEAGUES = "NBA,NFL,NCAAB";
    delete process.env.INGEST_ALLOWED_LEAGUES;

    // ---------- error classification ----------
    expect("isInfraError: connection failure", isInfraError(new Prisma.PrismaClientKnownRequestError("x", { code: "P1001", clientVersion: "5" })), true);
    expect("isInfraError: unique violation is not infra", isInfraError(new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "5" })), false);
    expect("isInfraError: a plain error is not infra", isInfraError(new Error("boom")), false);

    // ---------- the secret and the text never reach the logs: nothing above logs them (checked in the route source) ----------
    const { readFileSync } = await import("node:fs");
    const routeSrc = readFileSync("src/app/api/ingest/telegram/route.ts", "utf8") + readFileSync("src/server/data/telegram-ingest.ts", "utf8");
    const logCalls = routeSrc.match(/console\.(log|error|warn)\([^;]*;/g) ?? [];
    expect("no log call mentions the token or the text", logCalls.some((l) => /\btoken\b|\btext\b|x-picks-token/i.test(l)), false);
  } finally {
    const ids = [users.main, users.other, users.ghost];
    await prisma.ingestBatch.deleteMany({ where: { channelId: { in: channelIds } } });
    await prisma.importSkippedLine.deleteMany({ where: { userId: { in: ids } } });
    await prisma.importRun.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pick.deleteMany({ where: { userId: { in: ids } } });
    await prisma.capper.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    const sportsNow = await prisma.sport.findMany({ select: { id: true, name: true } });
    await prisma.sport.deleteMany({ where: { id: { in: sportsNow.filter((s) => !sportsBefore.has(s.name)).map((s) => s.id) } } });
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
