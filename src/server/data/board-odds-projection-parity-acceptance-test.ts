// Parity test for serving the PROJECTED odds board (getBoardOddsForSport) instead
// of the full snapshot (getOddsForSport) to the board readers: getLiveBoardData
// (so /live, Auto-Generate and the slip) and the game page.
//
// What those readers take from an odds game: its top-level fields (id, teams,
// commenceTime, ...) and, from its bookmakers, only bookmakers[0].title plus the
// FIRST h2h / spreads / totals market found walking the books in order -
//   live/[gameId]/page.tsx: `game.bookmakers[0]` (title) and findMarketAcrossBooks
//   live-scoreboard.tsx: `game.bookmakers[0]` (title) and its own first-market walk.
// So "identical output" is asserted on that render view per game, plus:
//   - /live: getLiveBoardData vs board-odds-legacy.ts (the same function reading
//     the full snapshot): same games in order, same scores, identical
//     expanderPicksByGame, identical render view for every card;
//   - Auto-Generate: the action's orchestration (parlay-generator.ts) on both
//     boards - Primary, seeded alternates, same-game fill, Hedge, Contrarian;
//   - game page: for every game, the render view from getBoardOddsForSport equals
//     the one from getOddsForSport;
//   - the projection never ADDS anything: every kept book and market is
//     byte-identical to the full snapshot's.
// Fixtures are deliberately hostile: 8 books per game in varied order, books
// missing markets, a first book with no h2h, extra markets (alternate lines,
// props) before the live ones, duplicate keys. It also prints bytes per read,
// full vs projected, for NFL / NHL / MLB-shaped fixtures.
//
// DB-backed and WRITING: ids prefixed `__BoardOdds__`, deleted by exact id.
// Refuses to run unless DATABASE_URL points at localhost; skips if a real odds
// snapshot for today exists for a fixture sport.
//   npx tsx src/server/data/board-odds-projection-parity-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getOddsForSport, getBoardOddsForSport, type OddsGame } from "@/server/data/odds";
import { getLiveBoardData, type LiveBoardData } from "@/server/data/live-board-picks";
import { getLiveBoardDataFullOdds } from "@/server/data/board-odds-legacy";
import { getCapperLeagueRecords, getCapperCategoryRecords } from "@/server/data/picks";
import { pickCategory, PICK_CATEGORY_VERSION, type PickCategoryKey } from "@/server/data/stats";
import { easternDateKey } from "@/lib/dates";
import { isSportInSeason } from "@/lib/sport-seasons";
import { buildAutoParlay, buildSameGameLegs, buildSwapParlay, filterGamesByInclude, toMaxLegsPerGame, type AutoParlay, type GeneratorGame, type GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildParlaySet, EMPTY_SLIP, lockParlay } from "@/lib/parlay/alternates";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x instanceof Date) return x.toISOString();
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)]));
  return x;
}
const json = (x: unknown) => JSON.stringify(canon(x));
const same = (a: unknown, b: unknown) => json(a) === json(b);
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What the board readers see of one odds game (see the header).
type Book = OddsGame["bookmakers"][number];
const firstMarket = (g: OddsGame, key: string) => {
  for (const b of g.bookmakers) {
    const m = b.markets?.find((x) => x.key === key);
    if (m) return { book: b.key, market: m };
  }
  return undefined;
};
const renderView = (g: OddsGame) => {
  const { bookmakers, ...top } = g;
  return { top, title: bookmakers[0]?.title, h2h: firstMarket(g, "h2h"), spreads: firstMarket(g, "spreads"), totals: firstMarket(g, "totals") };
};

const PREFIX = "__BoardOdds__";
const NOW = Date.now();
const H = 3600000;
const created = { users: [] as string[], cappers: [] as string[], picks: [] as string[], snapshots: [] as string[], sports: [] as string[] };

// A hostile but realistic board: 8 books, shuffled market order, gaps, extras.
function makeBoard(sportKey: string, n: number, rand: () => number, teams: (i: number) => [string, string]): OddsGame[] {
  const BOOKS = ["fanduel", "draftkings", "betmgm", "caesars", "pointsbetus", "bovada", "betrivers", "unibet_us"];
  return Array.from({ length: n }, (_, i) => {
    const [away, home] = teams(i);
    const bookmakers: Book[] = BOOKS.map((key, bi) => {
      const price = () => Math.round((rand() < 0.5 ? -1 : 1) * (100 + rand() * 150));
      const markets: Book["markets"] = [];
      const extra = () => markets.push({ key: rand() < 0.5 ? "alternate_spreads" : "player_pass_yds", last_update: "2026-10-19T12:00:00Z", outcomes: Array.from({ length: 6 }, (_, k) => ({ name: k % 2 ? "Over" : "Under", price: price(), point: 20 + k, description: "Player " + k })) });
      // Every third game, the FIRST book lists only props / alternate lines - it is
      // kept for bookmakers[0].title alone (the case a broken "keep book 1" rule misses).
      if (bi === 0 && i % 3 === 0) {
        extra();
        extra();
        return { key, title: key.toUpperCase() + " Book", last_update: "2026-10-19T12:00:00Z", markets } as Book;
      }
      if (rand() < 0.4) extra();
      // book 0 never has h2h on even games; others drop markets at random
      if (!(bi === 0 && i % 2 === 0) && rand() < 0.85) markets.push({ key: "h2h", outcomes: [{ name: home, price: price() }, { name: away, price: price() }] });
      if (rand() < 0.8) markets.push({ key: "spreads", outcomes: [{ name: home, price: -110, point: -3.5 }, { name: away, price: -110, point: 3.5 }] });
      if (rand() < 0.4) extra();
      if (rand() < 0.8) markets.push({ key: "totals", outcomes: [{ name: "Over", price: -110, point: 44.5 }, { name: "Under", price: -110, point: 44.5 }] });
      if (rand() < 0.2) markets.push({ key: "h2h", outcomes: [{ name: home, price: price() }, { name: away, price: price() }] }); // a duplicate key later in the same book
      return { key, title: key.toUpperCase() + " Book", last_update: "2026-10-19T12:00:00Z", markets } as Book;
    });
    return { id: `${PREFIX}${sportKey}-${i}`, sportKey, sport_title: sportKey, homeTeam: home, awayTeam: away, commenceTime: new Date(NOW + (2 + i) * H).toISOString(), bookmakers } as OddsGame;
  });
}

async function sportId(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return existing.id;
  const s = await prisma.sport.create({ data: { name } });
  created.sports.push(s.id);
  return s.id;
}

async function main() {
  const todayKey = easternDateKey(new Date(NOW));
  const SPORTS = [
    { key: "americanfootball_nfl", label: "NFL", games: 16 },
    { key: "icehockey_nhl", label: "NHL", games: 12 },
    { key: "baseball_mlb", label: "MLB", games: 10 },
  ].filter((s) => isSportInSeason(s.key));
  check("coverage: NFL is in season for the generator check", SPORTS.some((s) => s.key === "americanfootball_nfl"));
  const existing = await prisma.oddsSnapshot.findMany({ where: { sportKey: { in: SPORTS.map((s) => s.key) }, fetchDate: todayKey }, select: { sportKey: true } });
  if (existing.length > 0) {
    console.log(`SKIP: real odds snapshots for ${todayKey} exist locally (${existing.map((e) => e.sportKey).join(", ")}) - not overwriting them.`);
    return;
  }

  const rand = seeded(20261019);
  const boards: Record<string, OddsGame[]> = {};
  for (const s of SPORTS) {
    boards[s.key] = makeBoard(s.key, s.games, rand, (i) => [`Egr ${s.label} Away ${i} Owls`, `Egr ${s.label} Home ${i} Hawks`]);
    const id = `${PREFIX}snap-${s.key}`;
    await prisma.oddsSnapshot.create({ data: { id, sportKey: s.key, fetchDate: todayKey, data: boards[s.key] as unknown as Prisma.InputJsonValue } });
    created.snapshots.push(id);
  }

  // A user with picks on the NFL board so the board carries expander picks and the generator has legs.
  const nfl = { id: await sportId("NFL"), name: "NFL" };
  const userId = PREFIX + "user";
  await prisma.user.create({ data: { id: userId, supabaseId: userId + "-sb", email: userId + "@example.invalid" } });
  created.users.push(userId);
  const cappers: string[] = [];
  for (let c = 0; c < 4; c++) {
    const id = `${PREFIX}capper-${c}`;
    await prisma.capper.create({ data: { id, userId, name: `${PREFIX}C${c}`, source: "OTHER" } });
    cappers.push(id);
    created.cappers.push(id);
  }
  const rows: Prisma.PickCreateManyInput[] = [];
  let seq = 0;
  const pick = (capperId: string, g: { homeTeam: string; awayTeam: string }, gameTime: number, status: "PENDING" | "WIN" | "LOSS", k: number): Prisma.PickCreateManyInput => {
    seq++;
    const base = k % 2 === 0
      ? { betType: "MONEYLINE" as const, betDetail: g.homeTeam + " ML", odds: -140, line: null, period: "FULL_GAME" as const, pickedSide: "HOME" as const, mlFavoredSide: "HOME" as const, propMarket: null }
      : { betType: "TOTAL" as const, betDetail: "Over 44.5", odds: -110, line: 44.5, period: "FULL_GAME" as const, pickedSide: null, mlFavoredSide: null, propMarket: null };
    const id = `${PREFIX}p-${seq}`;
    created.picks.push(id);
    return { id, userId, capperId, sportId: nfl.id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, ...base, units: 1, gameTime: new Date(gameTime), datePosted: new Date(gameTime - H), status, gradedAt: status === "PENDING" ? null : new Date(gameTime + 4 * H), createdAt: new Date(NOW - 1e6 + seq * 1000), category: pickCategory({ ...base, sportName: "NFL" }), categoryVersion: PICK_CATEGORY_VERSION };
  };
  boards.americanfootball_nfl?.forEach((g, i) => {
    for (let k = 0; k < 3; k++) rows.push(pick(cappers[(i + k) % 4], g, new Date(g.commenceTime).getTime(), "PENDING", k));
  });
  for (const [c, capperId] of cappers.entries()) for (let k = 0; k < 12; k++) rows.push(pick(capperId, { homeTeam: "Egr Hist H", awayTeam: "Egr Hist A" }, NOW - (40 + k) * 86400000, (k + c) % 3 === 0 ? "LOSS" : "WIN", k));
  await prisma.pick.createMany({ data: rows });

  // ---- 1. The projection keeps exactly what the readers see, and adds nothing ----
  const bytes: string[] = [];
  for (const s of SPORTS) {
    const full = await getOddsForSport(s.key);
    const proj = await getBoardOddsForSport(s.key);
    check(`1a. ${s.label}: same games, same order`, same(full.map((g) => g.id), proj.map((g) => g.id)) && full.length === s.games);
    const diffs = full.filter((g, i) => !same(renderView(g), renderView(proj[i]))).map((g) => g.id);
    check(`1b. ${s.label}: every game's render view identical (top-level fields, bookmakers[0].title, first h2h/spreads/totals)`, diffs.length === 0, diffs.slice(0, 3).join(", "));
    const subset = proj.every((pg, i) =>
      pg.bookmakers.every((pb) => {
        const fb = full[i].bookmakers.find((b) => b.key === pb.key);
        return !!fb && same({ ...pb, markets: undefined }, { ...fb, markets: undefined }) && pb.markets.every((pm) => fb.markets.some((fm) => same(fm, pm)));
      })
    );
    check(`1c. ${s.label}: every kept book and market is byte-identical to the full snapshot's (nothing invented)`, subset);
    check(
      `1e. ${s.label}: projected books carry only h2h / spreads / totals (the size win)`,
      proj.every((g) => g.bookmakers.every((b) => b.markets.every((m) => ["h2h", "spreads", "totals"].includes(m.key))))
    );
    check(`1d. ${s.label}: fixture really exercises the cut (books/markets dropped)`, proj.reduce((n, g) => n + g.bookmakers.length, 0) < full.reduce((n, g) => n + g.bookmakers.length, 0));
    const fb = Buffer.byteLength(JSON.stringify(full));
    const pb = Buffer.byteLength(JSON.stringify(proj));
    bytes.push(`${s.label}: full ${fb.toLocaleString()} B -> projected ${pb.toLocaleString()} B (${Math.round((100 * (fb - pb)) / fb)}% less)`);
  }

  // ---- 2. /live: getLiveBoardData on the projection vs on the full snapshot -------------
  const liveNew = await getLiveBoardData(userId, "americanfootball_nfl", "NFL");
  const liveOld = await getLiveBoardDataFullOdds(userId, "americanfootball_nfl", "NFL");
  check("2a. /live: same games in the same order", same(liveOld.odds.map((g) => g.id), liveNew.odds.map((g) => g.id)) && liveNew.odds.length > 0);
  check("2b. /live: every card's render view identical", same(liveOld.odds.map(renderView), liveNew.odds.map(renderView)));
  check("2c. /live: same scores", same(liveOld.scores, liveNew.scores));
  check("2d. /live: identical expanderPicksByGame", same(liveOld.expanderPicksByGame, liveNew.expanderPicksByGame) && liveNew.expanderPicksByGame.flat().length > 0, `${liveNew.expanderPicksByGame.flat().length} picks`);

  // ---- 3. Auto-Generate (as parlay-generator.ts builds it) ------------------------------
  async function generate(board: LiveBoardData) {
    const now = new Date(NOW);
    const inWindow = autoGenerateWindow("NFL", board.odds.map((g) => g.commenceTime), now);
    const dh = doubleheaderGameIds(board.odds, board.scores);
    const games: GeneratorGame[] = [];
    board.odds.forEach((g, i) => {
      if (!inWindow(g.commenceTime)) return;
      const picks = board.expanderPicksByGame[i].filter((p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string");
      games.push({ gameId: g.id, gameLabel: picks[0]?.gameLabel ?? g.awayTeam + " @ " + g.homeTeam, gameTime: g.commenceTime, leagueName: "NFL", picks, doubleheader: dh.has(g.id) });
    });
    const scoped = filterGamesByInclude(games, "ALL");
    const all = scoped.flatMap((g) => g.picks);
    const records = await getCapperLeagueRecords(userId, all.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })));
    const categoryRecords = await getCapperCategoryRecords(userId, all.filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null).map((p) => ({ capperId: p.capperId, category: p.category })));
    const primary = lockParlay(buildAutoParlay(scoped, records, 4, null), scoped, records, EMPTY_SLIP);
    if ("error" in primary) return { games: scoped.length, error: primary.error };
    const sameGameOf = (p: AutoParlay) => buildSameGameLegs(p, scoped, categoryRecords, toMaxLegsPerGame(2));
    const set = buildParlaySet({ games: scoped, records, slip: EMPTY_SLIP, primary, includePrimary: true, count: 3, exclude: new Set(), extraLegs: (p) => sameGameOf(p).legs.map((l) => l.pick.pickId), rng: seeded(7) });
    const parlayA = set.parlays[0] ?? primary;
    return { games: scoped.length, legs: primary.legs.length, primary, set, sameGame: sameGameOf(parlayA), hedge: buildSwapParlay(parlayA, scoped, "AUTO_HEDGE", categoryRecords), contrarian: buildSwapParlay(parlayA, scoped, "CONTRARIAN", categoryRecords) };
  }
  const genOld = await generate(liveOld);
  const genNew = await generate(liveNew);
  check("3a. coverage: the generator built a Primary with legs", "legs" in genNew && (genNew.legs ?? 0) > 0, json({ games: genNew.games, legs: "legs" in genNew ? genNew.legs : 0 }));
  check("3b. Auto-Generate output identical (Primary, seeded alternates, same-game fill, Hedge, Contrarian)", same(genOld, genNew));

  // ---- 4. Game page: the found game's render view, for every game -----------------------
  let pageDiffs = 0;
  let pageGames = 0;
  for (const s of SPORTS) {
    const full = await getOddsForSport(s.key);
    const proj = await getBoardOddsForSport(s.key);
    for (const g of full) {
      pageGames++;
      if (!same(renderView(g), renderView(proj.find((x) => x.id === g.id)!))) pageDiffs++;
    }
  }
  check("4. game page: every game's head-to-head view (title, ML, spread, total) identical", pageDiffs === 0 && pageGames > 0, `${pageDiffs} of ${pageGames} differ`);

  // ---- 5. A sport with no snapshot today reads the same thing both ways ([] here: no API key) ----
  const noSnap = "basketball_wnba";
  if (!(await prisma.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey: noSnap, fetchDate: todayKey } } }))) {
    const saved = process.env.ODDS_API_KEY;
    delete process.env.ODDS_API_KEY;
    check("5. missing snapshot: board read and full read agree", same(await getBoardOddsForSport(noSnap), await getOddsForSport(noSnap)));
    if (saved !== undefined) process.env.ODDS_API_KEY = saved;
  }

  console.log("\nbytes per read (synthetic 8-book fixtures):\n  " + bytes.join("\n  "));
}

async function cleanup() {
  const r = {
    picks: (await prisma.pick.deleteMany({ where: { id: { in: created.picks } } })).count,
    cappers: (await prisma.capper.deleteMany({ where: { id: { in: created.cappers } } })).count,
    users: (await prisma.user.deleteMany({ where: { id: { in: created.users } } })).count,
    snapshots: (await prisma.oddsSnapshot.deleteMany({ where: { id: { in: created.snapshots } } })).count,
    sports: (await prisma.sport.deleteMany({ where: { id: { in: created.sports } } })).count,
  };
  console.log("\ncleanup:", JSON.stringify(r));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await cleanup().catch((e) => {
      console.error("cleanup failed", e);
      failures++;
    });
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
