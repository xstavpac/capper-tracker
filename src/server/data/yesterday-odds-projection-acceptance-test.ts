// Proof for /live's slim, shared read of yesterday's odds snapshot
// (getYesterdayOddsForSport -> getYesterdayBoardGames):
//   1. IDENTICAL FOR /LIVE: over fixture boards (several bookmakers; props-only first
//      book; the first spreads/totals deep in the list; duplicate markets; a game with
//      no / empty / marker-less bookmakers; price-less outcomes and an explicit null
//      point) every game keeps its top-level fields and order, and every value /live
//      reads from it - the card's book title and the first h2h / spreads / totals
//      market across books (LiveScoreboard's findMarketAcrossBooks) - is identical to
//      what the full blob gives. dropPhantomCards and orderBoardGames, the only other
//      consumers of these games, return the same boards over full and projected games.
//   2. SLIM: the projection is a small fraction of the stored blob.
//   3. Fallbacks: no snapshot row / a non-array data value -> [], as before.
//   4. CACHE CONTRACT: the entry has its own key but carries the tag every OddsSnapshot
//      write path revalidates, a long TTL, and getYesterdayOddsForSport reads the ET
//      day before "now".
//
// DB-backed (local/CI throwaway DB only - see scripts/run-tests.mjs); writes fixture
// rows under a "yodds_" sportKey and removes them. Run with:
//   npx tsx src/server/data/yesterday-odds-projection-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { dropPhantomCards } from "@/lib/live-board-dedup";
import { orderBoardGames, matchScoreToGame } from "@/components/live/live-scoreboard-ordering";
import { getYesterdayBoardGames } from "@/server/data/odds-projections";
import { getYesterdayOddsForSport, yesterdayOddsCacheParams, type OddsGame, type ScoreGame } from "@/server/data/odds";

function hostIsLocal(): boolean {
  try {
    const h = new URL(process.env.DATABASE_URL ?? "").hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}
if (!hostIsLocal()) {
  console.log("SKIP: DATABASE_URL is not a local database - this suite writes fixture rows and only runs locally/CI.");
  process.exit(0);
}

let failures = 0;
// Key-order-insensitive (jsonb does not preserve object key order); array order still matters.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
  return v;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = same(actual, expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const SPORT = "yodds_test";
const OTHER_SPORT = "yodds_other";
const DAY = "2026-03-10"; // the "yesterday" fetchDate
const NOW = Date.parse("2026-03-11T18:00:00Z"); // 2pm ET on the 11th -> yesterday is the 10th

// What LiveScoreboard (components/live/live-scoreboard.tsx) reads from a game's books.
function findMarketAcrossBooks(game: OddsGame, key: string) {
  for (const b of game.bookmakers ?? []) {
    const m = b?.markets?.find((x) => x.key === key);
    if (m) return m;
  }
  return undefined;
}
function liveReads(game: OddsGame) {
  const { bookmakers: _b, ...top } = game as OddsGame & Record<string, unknown>;
  return {
    top,
    title: game.bookmakers?.[0]?.title,
    h2h: findMarketAcrossBooks(game, "h2h"),
    spreads: findMarketAcrossBooks(game, "spreads"),
    totals: findMarketAcrossBooks(game, "totals"),
  };
}

const out = (name: string, price?: number, point?: number, description?: string) => ({
  name,
  ...(price !== undefined ? { price } : {}),
  ...(point !== undefined ? { point } : {}),
  ...(description !== undefined ? { description } : {}),
});
const h2h = (hp: number, ap: number, home: string, away: string) => ({
  key: "h2h",
  last_update: "2026-03-10T15:00:00Z",
  outcomes: [out(home, hp), out(away, ap)],
});
const spreads = (home: string, away: string, line: number) => ({
  key: "spreads",
  outcomes: [out(home, -110, -line), out(away, -110, line)],
});
const totals = (line: number) => ({ key: "totals", outcomes: [out("Over", -105, line), out("Under", -115, line)] });
const props = { key: "player_anytime_td", outcomes: [out("Yes", 120, undefined, "Some Player"), out("Yes", 200, undefined, "Other Player")] };

function game(id: string, home: string, away: string, commence: string, bookmakers: unknown, extra: Record<string, unknown> = {}) {
  const g: Record<string, unknown> = { id, sportKey: SPORT, homeTeam: home, awayTeam: away, commenceTime: commence, ...extra };
  if (bookmakers !== undefined) g.bookmakers = bookmakers;
  return g;
}

const BOARD = [
  // Book 0 carries only totals + props (no h2h/spreads); h2h/spreads first appear in later books,
  // with a duplicate spreads market in book 1 (find() must still return the first) and a later book
  // repeating h2h at different prices (must be unreachable).
  game("g1", "Home A", "Away A", "2026-03-10T23:05:00Z", [
    { key: "bk0", title: "Book Zero", last_update: "x", markets: [totals(8.5), props] },
    { key: "bk1", title: "Book One", markets: [props, h2h(-150, 130, "Home A", "Away A"), spreads("Home A", "Away A", 1.5), spreads("Home A", "Away A", 2.5)] },
    { key: "bk2", title: "Book Two", markets: [h2h(-160, 140, "Home A", "Away A"), totals(9)] },
    { key: "bk3", title: "Book Three", markets: [spreads("Home A", "Away A", 0.5), totals(7.5), h2h(-170, 150, "Home A", "Away A")] },
  ], { sport_title: "Test League" }),
  // No bookmakers key at all.
  game("g2", "Home B", "Away B", "2026-03-10T23:10:00Z", undefined),
  // Empty bookmakers.
  game("g3", "Home C", "Away C", "2026-03-10T23:15:00Z", []),
  // A book without a markets key, one with price-less outcomes and an explicit null point.
  game("g4", "Home D", "Away D", "2026-03-11T00:05:00Z", [
    { key: "bk0", title: "No Markets" },
    {
      key: "bk1",
      title: "Odd Shapes",
      markets: [
        { key: "h2h", outcomes: [{ name: "Home D" }, { name: "Away D", price: 105 }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: null }] },
      ],
    },
  ]),
  // Totals only, deep in the list.
  game("g5", "Home E", "Away E", "2026-03-11T01:10:00Z", [
    { key: "bk0", title: "A", markets: [props] },
    { key: "bk1", title: "B", markets: [] },
    { key: "bk2", title: "C", markets: [totals(44.5)] },
  ]),
];

// A fat board for the size check: many books x all three markets x props, like a real snapshot.
function fatBoard() {
  const books = Array.from({ length: 10 }, (_, i) => ({
    key: "bk" + i,
    title: "Book " + i,
    last_update: "2026-03-10T15:00:00Z",
    markets: [h2h(-150 - i, 130 + i, "Home F", "Away F"), spreads("Home F", "Away F", 1.5), totals(8.5), { ...props, outcomes: Array.from({ length: 60 }, (_, p) => out("Yes", 100 + p, undefined, "Player " + p)) }],
  }));
  return Array.from({ length: 15 }, (_, i) => game("f" + i, "Home F" + i, "Away F" + i, "2026-03-10T2" + (i % 4) + ":05:00Z", books));
}

async function cleanup() {
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: { in: [SPORT, OTHER_SPORT] } } });
}

async function main() {
  await cleanup();
  await prisma.oddsSnapshot.create({ data: { sportKey: SPORT, fetchDate: DAY, data: BOARD as any } });

  // --- 1. identical for /live
  const projected = await getYesterdayBoardGames(SPORT, DAY);
  const full = BOARD as unknown as OddsGame[];
  expect("same game ids in the same order", projected.map((g) => g.id), full.map((g) => g.id));
  full.forEach((g, i) => {
    expect(`game ${g.id}: top-level fields + every value /live reads match the full board`, liveReads(projected[i]), liveReads(g));
  });
  ok(
    "a game with no bookmakers key projects to an empty bookmakers array (readers treat both the same)",
    Array.isArray(projected[1].bookmakers) && projected[1].bookmakers.length === 0
  );
  ok("book 0 survives even when it holds none of the three markets", projected[0].bookmakers[0]?.key === "bk0");
  ok("g1 keeps only the books reachable by the readers (bk0 title, first h2h/spreads, first totals)", same(projected[0].bookmakers.map((b) => b.key), ["bk0", "bk1"]) , projected[0].bookmakers.map((b) => b.key));

  // dropPhantomCards / orderBoardGames over full vs projected
  const scores = [
    { id: "s1", homeTeam: "Home A", awayTeam: "Away A", commenceTime: "2026-03-10T23:05:00Z", status: "final" },
    { id: "s2", homeTeam: "Home D", awayTeam: "Away D", commenceTime: "2026-03-11T00:05:00Z", status: "live" },
    { id: "s3", homeTeam: "Home E", awayTeam: "Away E", commenceTime: "2026-03-11T01:10:00Z", status: "live" },
  ] as unknown as ScoreGame[];
  const dedupFull = dropPhantomCards(full, scores);
  const dedupProj = dropPhantomCards(projected, scores);
  expect("dropPhantomCards keeps the same games", dedupProj.games.map((g) => g.id), dedupFull.games.map((g) => g.id));
  expect("dropPhantomCards assigns the same schedule games", dedupProj.scheduleGames.map((s) => s?.id), dedupFull.scheduleGames.map((s) => s?.id));
  const ordered = (games: OddsGame[]) =>
    orderBoardGames(games.map((g) => ({ game: g, score: matchScoreToGame(scores, g) })), "2026-03-11").map(({ game: g }) => g.id);
  expect("orderBoardGames shows the same cards in the same order", ordered(projected), ordered(full));

  // --- 2. slim
  const fat = fatBoard();
  await prisma.oddsSnapshot.create({ data: { sportKey: OTHER_SPORT, fetchDate: DAY, data: fat as any } });
  const fatProjected = await getYesterdayBoardGames(OTHER_SPORT, DAY);
  const fullBytes = JSON.stringify(fat).length;
  const projBytes = JSON.stringify(fatProjected).length;
  console.log(`bytes: full blob ${fullBytes}, projection ${projBytes} (${((100 * projBytes) / fullBytes).toFixed(1)}%)`);
  ok("projection is under 15% of the stored blob on a realistic board", projBytes < fullBytes * 0.15, { fullBytes, projBytes });
  expect("fat board: every game's /live reads still match", fatProjected.map(liveReads), (fat as unknown as OddsGame[]).map(liveReads));

  // --- 3. fallbacks
  expect("no snapshot row -> []", await getYesterdayBoardGames(SPORT, "2026-03-09"), []);
  await prisma.oddsSnapshot.create({ data: { sportKey: SPORT, fetchDate: "2026-03-08", data: { not: "an array" } as any } });
  expect("non-array data -> []", await getYesterdayBoardGames(SPORT, "2026-03-08"), []);

  // --- 4. cache contract + date selection
  const p = yesterdayOddsCacheParams(SPORT, DAY);
  expect("cache tag is the one every OddsSnapshot write path revalidates", p.tags, [cacheKeys.odds(SPORT, DAY)]);
  ok("cache key is its own (no collision with the full-blob or ticker entries)", p.key !== cacheKeys.odds(SPORT, DAY) && p.key !== cacheKeys.tickerOdds(SPORT, DAY));
  ok("key includes sport and date", p.key.includes(SPORT) && p.key.includes(DAY));
  ok("TTL is long (>= 1h), not the 60s odds TTL", p.ttlSeconds >= 3600, p.ttlSeconds);

  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const viaPublic = await getYesterdayOddsForSport(SPORT);
    expect("getYesterdayOddsForSport reads the ET day before now", viaPublic.map((g) => g.id), full.map((g) => g.id));
    expect("a sport with no row for that day -> []", await getYesterdayOddsForSport("yodds_none"), []);
  } finally {
    Date.now = realNow;
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
