// The Telegram ingest review queue UI, against a LOCAL database: the "Needs review" list (hidden at 0, N cards at N,
// oldest first, PENDING only, capped, no stored picks), the cached sidebar count and when its tag is revalidated, the
// two server actions (resolve creates the pick and the card goes; dismiss marks DISMISSED; another user's item
// cannot be touched), and the manual paste form's shared question markup against the markup it had before the
// extraction. Same deterministic board and stubs as telegram-ingest-acceptance-test.ts. Run with:
//   npx tsx src/server/data/ingest-review-ui-acceptance-test.ts   (DATABASE_URL must be localhost)
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

const PREFIX = "__IngestUi__";
const H = 3600000;
const NOW = Date.now();
type Fake = { sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string };
const at = (i: number) => new Date(NOW + (2 + i) * H).toISOString();
const BOARD: Fake[] = [
  { sportKey: "basketball_nba", homeTeam: "Los Angeles Lakers", awayTeam: "Boston Celtics", commenceTime: at(0) },
  { sportKey: "americanfootball_nfl", homeTeam: "New York Jets", awayTeam: "Buffalo Bills", commenceTime: at(1) },
  { sportKey: "icehockey_nhl", homeTeam: "Winnipeg Jets", awayTeam: "Dallas Stars", commenceTime: at(2) },
  { sportKey: "baseball_mlb", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", commenceTime: at(3) },
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
const revalidated: string[] = [];
stub("next/cache", { revalidatePath: () => {}, revalidateTag: (t: string) => void revalidated.push(t), unstable_cache: <T>(fn: T) => fn });
// The actions take the user from the session: this test is the session.
let sessionUserId = "";
stub("../auth", { requireUser: async () => ({ id: sessionUserId }) });

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const TOKEN = "test-token-" + "x".repeat(24);
const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) =>
  route.POST(new Request("http://localhost/api/ingest/telegram", { method: "POST", headers: { "content-type": "application/json", "x-picks-token": TOKEN }, body: JSON.stringify(body) }));

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
  const queue = await import("@/server/data/ingest-review-queue");
  const actions = await import("@/server/actions/ingest-review");
  const { cacheKeys } = await import("@/lib/cache-keys");

  const users = { main: PREFIX + "main", other: PREFIX + "other" };
  const sportsBefore = new Set((await prisma.sport.findMany({ select: { name: true } })).map((s) => s.name));
  const channelIds = [PREFIX + "chan"];

  try {
    for (const id of [users.main, users.other]) {
      await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    }
    process.env.INGEST_USER_ID = users.main;
    process.env.PICKS_INGEST_TOKEN = TOKEN;
    delete process.env.INGEST_ALLOWED_LEAGUES;

    // ---------- hidden at 0 ----------
    expect("0 items: no cards for the user", await queue.getPendingReviewCards(users.main), []);
    expect("0 items: count is 0", await queue.getPendingReviewCount(users.main), 0);

    // ---------- N items: ambiguous team, capper near-miss, missing total ----------
    await prisma.capper.create({ data: { userId: users.main, name: "Gamma Capper", source: "OTHER" } });
    revalidated.length = 0;
    const b1 = await (await post(route, { channelId: channelIds[0], messageId: 1, day: "2026-11-02", text: "Alpha Capper\nJets ML -140" })).json();
    const b2 = await (await post(route, { channelId: channelIds[0], messageId: 2, day: "2026-11-02", text: "Gama Capper\nLakers +2 -110" })).json();
    const b3 = await (await post(route, { channelId: channelIds[0], messageId: 3, day: "2026-11-02", text: "Gamma Capper\nCubs under a -110" })).json();
    expect("ingest created one item per batch", [b1.pendingReview, b2.pendingReview, b3.pendingReview], [1, 1, 1]);
    expect("ingest revalidated the user's count tag once per batch with items", revalidated.filter((t) => t === cacheKeys.ingestReviewCount(users.main)).length, 3);

    const cards = await queue.getPendingReviewCards(users.main);
    expect("3 items -> 3 cards, oldest first, in the order ingested", cards.map((c) => c.questionType), ["AMBIGUOUS_TEAM", "CAPPER_FUZZY", "MISSING_TOTAL_LINE"]);
    expect("cards carry capper, line text and the batch day", cards.map((c) => [c.capperName, c.lineText, c.day]), [
      ["Alpha Capper", "Jets ML -140", "2026-11-02"],
      ["Gama Capper", "Lakers +2 -110", "2026-11-02"],
      ["Gamma Capper", "Cubs under a -110", "2026-11-02"],
    ]);
    expect("count follows the items", await queue.getPendingReviewCount(users.main), 3);
    expect("another user sees none of them", [(await queue.getPendingReviewCards(users.other)).length, await queue.getPendingReviewCount(users.other)], [0, 0]);
    const json = JSON.stringify(cards);
    expect("cards never carry the stored pick (game, price, times)", /"pick"|gameTime|oddsCapturedAt|homeTeam|"odds"/.test(json), false);
    expect("team card: one playable choice per league", cards[0].choices.map((c) => c.playable), [true, true]);
    expect("fuzzy card: both capper choices, suggestion named", cards[1].choices.map((c) => [c.id, c.capperName]), [["use-suggestion", "Gamma Capper"], ["new-capper", "Gama Capper"]]);
    expect("total card: the proposed line", [cards[2].choices[0].id, cards[2].choices[0].inferredLine, cards[2].choices[0].lineReason], ["confirm", MARKET_TOTAL, "missing"]);

    // ---------- limit 50, PENDING only ----------
    const donor = await prisma.ingestReviewItem.findFirst({ where: { userId: users.main }, select: { ingestBatchId: true, options: true } });
    await prisma.ingestReviewItem.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        ingestBatchId: donor!.ingestBatchId,
        userId: users.main,
        capperName: "Bulk " + i,
        lineText: "line " + i,
        day: "2026-11-02",
        questionType: "AMBIGUOUS_TEAM" as const,
        options: donor!.options as object,
        status: i < 5 ? ("DISMISSED" as const) : ("PENDING" as const),
      })),
    });
    const many = await queue.getPendingReviewCards(users.main);
    expect("list is capped at 50 and holds only PENDING", [many.length, many.every((c) => !c.capperName.startsWith("Bulk ") || Number(c.capperName.slice(5)) >= 5)], [50, true]);
    expect("the oldest items come first", many.slice(0, 3).map((c) => c.capperName), ["Alpha Capper", "Gama Capper", "Gamma Capper"]);
    await prisma.ingestReviewItem.deleteMany({ where: { userId: users.main, capperName: { startsWith: "Bulk " } } });

    // ---------- the actions: authz ----------
    const jetsCard = cards[0];
    const nfl = jetsCard.choices[0];
    const picksFor = (userId: string) => prisma.pick.count({ where: { userId } });
    const picksBefore = await picksFor(users.main);
    sessionUserId = users.other;
    revalidated.length = 0;
    expect("another user cannot resolve it", await actions.resolveReviewItemAction(jetsCard.id, nfl.id), { ok: false, message: "No such review item." });
    expect("another user cannot dismiss it", await actions.dismissReviewItemAction(jetsCard.id), { ok: false, message: "No such review item." });
    const stillPending = await prisma.ingestReviewItem.findUnique({ where: { id: jetsCard.id }, select: { status: true } });
    expect(
      "...and it is still PENDING, no pick created, nothing revalidated",
      [stillPending?.status, await picksFor(users.main), await picksFor(users.other), revalidated.includes(cacheKeys.ingestReviewCount(users.main))],
      ["PENDING", picksBefore, 0, false]
    );

    // ---------- resolve ----------
    sessionUserId = users.main;
    revalidated.length = 0;
    const res = await actions.resolveReviewItemAction(jetsCard.id, nfl.id);
    expect("resolve: ok with the created pick's label", [res.ok, res.ok && typeof res.pickLabel === "string" && res.pickLabel.length > 0], [true, true]);
    expect("resolve: created exactly one pick", await picksFor(users.main), picksBefore + 1);
    expect("resolve: item RESOLVED", (await prisma.ingestReviewItem.findUnique({ where: { id: jetsCard.id }, select: { status: true } }))?.status, "RESOLVED");
    expect("resolve: the card is gone, the count is down", [(await queue.getPendingReviewCards(users.main)).map((c) => c.id).includes(jetsCard.id), await queue.getPendingReviewCount(users.main)], [false, 2]);
    expect("resolve: revalidated the count tag", revalidated.includes(cacheKeys.ingestReviewCount(users.main)), true);
    const second = await actions.resolveReviewItemAction(jetsCard.id, nfl.id);
    expect("resolve: a double tap answers 'already answered' and adds no pick", [second.ok, !second.ok && second.message, await picksFor(users.main)], [false, "This item was already answered.", picksBefore + 1]);

    // ---------- dismiss ----------
    revalidated.length = 0;
    expect("dismiss: ok", await actions.dismissReviewItemAction(cards[1].id), { ok: true });
    expect("dismiss: DISMISSED, no new pick", [(await prisma.ingestReviewItem.findUnique({ where: { id: cards[1].id }, select: { status: true } }))?.status, await picksFor(users.main)], ["DISMISSED", picksBefore + 1]);
    expect("dismiss: card gone, count down, tag revalidated", [(await queue.getPendingReviewCards(users.main)).length, await queue.getPendingReviewCount(users.main), revalidated.includes(cacheKeys.ingestReviewCount(users.main))], [1, 1, true]);
    const bad = await actions.resolveReviewItemAction(cards[2].id, "nope");
    expect("resolve: a choice that is not on the item is refused with a message", [bad.ok, !bad.ok && bad.message], [false, "That is not one of this item's choices."]);

    // ---------- manual paste form: the markup it now shares with the queue is the markup it rendered before ----------
    const React = await import("react");
    // The components use the classic JSX runtime under tsx, so React must be global before they load.
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const ui = await import("@/components/import/review-question-ui");
    const h = React.createElement;
    const render = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
    const OLD_BTN =
      "inline-flex min-h-[44px] items-center rounded-full border border-amber-500 bg-card px-3.5 text-left text-xs font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30";
    const oldFuzzy = h(
      "div",
      { className: "mt-2 rounded-lg border border-amber-400 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/5 dark:text-amber-200" },
      h("div", null, h("span", { className: "font-semibold" }, '"', "Gama Capper", '"'), " isn't an exact match for any saved capper. Did you mean ", h("span", { className: "font-semibold" }, "Gamma Capper"), "?"),
      h("div", { className: "mt-1.5 flex flex-wrap gap-1.5" }, h("button", { type: "button", className: OLD_BTN }, "Yes"))
    );
    const newFuzzy = h(ui.CapperFuzzyPrompt, { name: "Gama Capper", suggestion: "Gamma Capper", children: h("button", { type: "button", className: ui.promptButtonClass }, "Yes") });
    expect("capper 'did you mean' prompt renders as the form's inline markup did", render(newFuzzy), render(oldFuzzy));
    const oldRow = h("div", { className: "mt-1.5 flex flex-wrap items-center gap-1.5" }, h("button", { type: "button", className: OLD_BTN }, "Arizona Cardinals (NFL)"));
    const newRow = h(ui.ChoiceRow, { children: h(ui.ChoiceButton, { onClick: () => {}, children: "Arizona Cardinals (NFL)" }) });
    expect("choice row and button render as before (no disabled attribute unless asked)", render(newRow), render(oldRow));
    const oldTotal = h("div", { className: "mt-1.5" }, "No number found in this pick's text.", " ", "Today's market total for this game is", " ", h("span", { className: "font-semibold" }, 8.5), ".");
    expect("total-line explainer renders as before", render(h(ui.TotalLineExplainer, { reason: "missing", inferredLine: 8.5 })), render(oldTotal));
    expect(
      "ambiguous wording: two teams / one narrowed / player / near-miss player",
      [
        ui.ambiguousReasonText(false, [{ label: "A (NFL)" }, { label: "B (NHL)" }]),
        ui.ambiguousReasonText(false, [{ label: "A (NFL)" }]),
        ui.ambiguousReasonText(true, [{ label: "X — Y" }, { label: "Z — W" }]),
        ui.ambiguousReasonText(true, [{ label: "Brian Thomas Jr. — Jaguars WR", playerName: "Brian Thomas Jr." }]),
      ],
      [
        "Ambiguous team - could mean A (NFL) or B (NHL).",
        "Line plausibility narrowed this to A (NFL), but another signal disagreed - confirm it.",
        "More than one player has this name - which one?",
        "Did you mean Brian Thomas Jr. (Jaguars WR)?",
      ]
    );
    const { readFileSync } = await import("node:fs");
    const form = readFileSync("src/components/dashboard/bulk-import-form.tsx", "utf8");
    expect(
      "the manual form uses the shared module and no longer defines its own question UI",
      [/from "@\/components\/import\/review-question-ui"/.test(form), /function QuestionItem|const promptButtonClass|const promptLinkClass/.test(form)],
      [true, false]
    );
  } finally {
    const ids = [users.main, users.other];
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
