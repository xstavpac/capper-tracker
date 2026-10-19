// Parity test for the board / game-detail pick reads (picks.ts getPicksForGames /
// getPicksForGame): the window is now each game's +-MAX_GAME_TIME_DRIFT_MS (end
// inclusive) instead of +-2 days, the row is a projection (BOARD_PICK_SELECT)
// instead of every column plus the full capper, and the rows are ordered by
// (gameTime, createdAt, id). The reference is board-picks-legacy.ts - the old
// code verbatim.
//
// Asserted identical against that reference, on one fixture:
//   - the /live board (getLiveBoardData): the same games, and on each card the
//     same SET of picks, each ExpanderPick byte-identical. The order inside a
//     card is the one allowed difference - it used to be whatever the query plan
//     returned and is now (gameTime, createdAt, id); that is asserted too.
//   - Auto-Generate's output (Primary, alternates with a seeded rng, same-game
//     fill, Hedge, Contrarian), built the way parlay-generator.ts builds it.
//   - the Live category tiles' slate counts and each tile's ranked pick list
//     (the "Today's / This Week's X Picks" rows), built the way
//     live-category-panel.tsx builds them.
//   - game detail (getPicksForGame) for every card: same picks, same fields.
// The fixture carries today's AND yesterday's odds snapshots (the board's
// carried-over yesterday cards), picks exactly 6h from a card (inclusive edge),
// just past 6h and +-1-2 days (fetched before, never on a card), two cards of
// the same matchup a few hours apart (nearest-card assignment), a fuzzy text
// match, an exact gameTime + createdAt tie (id decides), another user's and
// another sport's picks, and picks whose category depends on pickedSide,
// mlFavoredSide or propMarket - optional pickCategory inputs the type cannot
// force into the projection.
//
// NFL, not MLB: Auto-Generate only takes MLB games later the same Eastern day,
// so an MLB fixture would make the generator check depend on the time it runs.
// NFL is a weekly-slate league (4-day window). The scores feed is the real one
// (ESPN, memoized per process, so both sides see the same scores); the fixture's
// team names are made up so no real game pairs with a card.
//
// DB-backed and WRITING: every id is prefixed `__BoardWindow__` and deleted by
// exact id at the end. Refuses to run unless DATABASE_URL points at localhost,
// and skips if a real NFL odds snapshot for today or yesterday already exists.
//   npx tsx src/server/data/board-picks-window-parity-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { pickCategory, chipSetForLeague, PICK_CATEGORY_VERSION, type PickCategoryKey } from "@/server/data/stats";
import { getLiveBoardData, type LiveBoardData } from "@/server/data/live-board-picks";
import { getPicksForGame, getPicksForGames, getCapperLeagueRecords, getCapperCategoryRecords } from "@/server/data/picks";
import { getLiveBoardDataLegacy, getPicksForGameLegacy } from "@/server/data/board-picks-legacy";
import { getSportCategoryPanelData } from "@/server/data/pick-aggregates-cappers-adapter";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { easternDateKey } from "@/lib/dates";
import { buildAutoParlay, buildSameGameLegs, buildSwapParlay, filterGamesByInclude, toMaxLegsPerGame, type AutoParlay, type GeneratorGame, type GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildParlaySet, EMPTY_SLIP, lockParlay } from "@/lib/parlay/alternates";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";
import { buildCategoryTiles, categoryPickRows, rankCategoryPicks, slatePicksByCategory, visibleGameIndexes, type LiveCategoryPick } from "@/lib/live-category-picks";

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
  if (x instanceof Map) return canon(Array.from(x.entries()));
  if (x instanceof Set) return canon(Array.from(x));
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canon(v)])
    );
  }
  return x;
}
const json = (x: unknown) => JSON.stringify(canon(x));
const same = (a: unknown, b: unknown) => json(a) === json(b);

// mulberry32 - the same seed gives both sides the same draws.
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

const PREFIX = "__BoardWindow__";
const SPORT_KEY = "americanfootball_nfl";
const SPORT = "NFL";
const H = 3600000;
const DRIFT = MAX_GAME_TIME_DRIFT_MS;
const NOW = Date.now();

const created = { users: [] as string[], cappers: [] as string[], picks: [] as string[], snapshots: [] as string[], sports: [] as string[] };

async function sportId(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return existing.id;
  const s = await prisma.sport.create({ data: { name } });
  created.sports.push(s.id);
  return s.id;
}

type Game = { id: string; sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string; bookmakers: [] };
const game = (id: string, away: string, home: string, atMs: number): Game => ({
  id: PREFIX + id,
  sportKey: SPORT_KEY,
  homeTeam: home,
  awayTeam: away,
  commenceTime: new Date(atMs).toISOString(),
  bookmakers: [],
});

// A pick spec: what kind of bet, and on which side. Category is stamped with the
// same pickCategory the import uses.
type Spec = {
  betType: Prisma.PickCreateManyInput["betType"];
  period?: Prisma.PickCreateManyInput["period"];
  betDetail: (g: Game) => string;
  odds: number;
  line?: number | null;
  pickedSide?: "HOME" | "AWAY" | null;
  mlFavoredSide?: "HOME" | "AWAY" | null;
  propMarket?: Prisma.PickCreateManyInput["propMarket"];
};
const SPECS: Spec[] = [
  { betType: "MONEYLINE", betDetail: (g) => g.homeTeam + " ML", odds: -150, pickedSide: "HOME", mlFavoredSide: "HOME" },
  // odds say favorite; the stored sides say underdog -> DOG_ML only if mlFavoredSide + pickedSide are read.
  { betType: "MONEYLINE", betDetail: (g) => g.awayTeam + " ML", odds: -120, pickedSide: "AWAY", mlFavoredSide: "HOME" },
  { betType: "SPREAD", betDetail: (g) => g.awayTeam + " +3.5", odds: -110, line: 3.5, pickedSide: "AWAY" },
  { betType: "TOTAL", betDetail: () => "Over 44.5", odds: -105, line: 44.5 },
  { betType: "MONEYLINE", period: "FIRST_HALF", betDetail: (g) => g.homeTeam + " 1H ML", odds: 115, pickedSide: "HOME" },
  // betDetail parses to no market -> the category comes from propMarket alone.
  { betType: "PLAYER_PROP", betDetail: () => "J. Doe special", odds: 120, propMarket: "RUSH_YDS" },
];

function pickRow(
  id: string,
  userId: string,
  capperId: string,
  sport: { id: string; name: string },
  g: Pick<Game, "homeTeam" | "awayTeam">,
  spec: Spec,
  gameTimeMs: number,
  createdAtMs: number,
  status: Prisma.PickCreateManyInput["status"],
  gameNumber: number | null = null
): Prisma.PickCreateManyInput {
  created.picks.push(id);
  const base = {
    betType: spec.betType,
    period: spec.period ?? "FULL_GAME",
    betDetail: spec.betDetail(g as Game),
    odds: spec.odds,
    line: spec.line ?? null,
    pickedSide: spec.pickedSide ?? null,
    mlFavoredSide: spec.mlFavoredSide ?? null,
    propMarket: spec.propMarket ?? null,
  };
  return {
    id,
    userId,
    capperId,
    sportId: sport.id,
    homeTeam: g.homeTeam,
    awayTeam: g.awayTeam,
    ...base,
    units: 1 + (createdAtMs % 3),
    datePosted: new Date(gameTimeMs - H),
    gameTime: new Date(gameTimeMs),
    status,
    gradedAt: status === "PENDING" || status === "CANCELLED" ? null : new Date(gameTimeMs + 4 * H),
    gameNumber,
    oddsSource: "STATED",
    createdAt: new Date(createdAtMs),
    category: pickCategory({ ...base, sportName: sport.name }),
    categoryVersion: PICK_CATEGORY_VERSION,
  };
}

async function main() {
  const todayKey = easternDateKey(new Date(NOW));
  const yesterdayKey = easternDateKey(new Date(NOW - 86400000));
  const existing = await prisma.oddsSnapshot.findMany({
    where: { sportKey: SPORT_KEY, fetchDate: { in: [todayKey, yesterdayKey] } },
    select: { id: true },
  });
  if (existing.length > 0) {
    console.log(`SKIP: a real ${SPORT_KEY} odds snapshot for ${todayKey}/${yesterdayKey} exists locally - not overwriting it.`);
    return;
  }

  const nfl = { id: await sportId(SPORT), name: SPORT };
  const other = { id: await sportId("NCAAF"), name: "NCAAF" };

  const userId = PREFIX + "user";
  const otherUserId = PREFIX + "user-other";
  for (const id of [userId, otherUserId]) {
    await prisma.user.create({ data: { id, supabaseId: id + "-sb", email: id + "@example.invalid" } });
    created.users.push(id);
  }
  const cappers: string[] = [];
  for (const [i, name] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
    const id = `${PREFIX}capper-${i}`;
    await prisma.capper.create({ data: { id, userId, name: PREFIX + name, source: "OTHER", isFavorite: i === 1, colorTag: i === 2 ? "#ff0000" : null } });
    cappers.push(id);
    created.cappers.push(id);
  }
  const otherCapper = PREFIX + "capper-other";
  await prisma.capper.create({ data: { id: otherCapper, userId: otherUserId, name: PREFIX + "Other", source: "OTHER" } });
  created.cappers.push(otherCapper);

  // Today's board (the snapshot getOddsForSport reads) and yesterday's (the
  // carried-over cards). ONE and TWIN are the same matchup on several cards.
  const ONE = ["Egr Salem Foxes", "Egr Tulsa Rams"] as const;
  const TWIN = ["Egr Reno Bats", "Egr Boise Elks"] as const;
  const today: Game[] = [
    game("t1", ONE[0], ONE[1], NOW + 2 * H),
    game("t2a", TWIN[0], TWIN[1], NOW + 3 * H),
    game("t2b", TWIN[0], TWIN[1], NOW + 8 * H),
    game("t3-fuzzy", "Jacksonville Jaguars", "Tennessee Titans", NOW + 4 * H),
    game("t4", ONE[0], ONE[1], NOW + 26 * H),
  ];
  const yesterday: Game[] = [game("y1", "Egr Ames Owls", "Egr Waco Hawks", NOW - 20 * H), game("y2", ONE[0], ONE[1], NOW - 22 * H)];
  for (const [fetchDate, data] of [
    [todayKey, today],
    [yesterdayKey, yesterday],
  ] as const) {
    const id = `${PREFIX}snap-${fetchDate}`;
    await prisma.oddsSnapshot.create({ data: { id, sportKey: SPORT_KEY, fetchDate, data: data as unknown as Prisma.InputJsonValue } });
    created.snapshots.push(id);
  }

  // Per card: offsets from kickoff. 0 twice with the SAME createdAt (id breaks
  // the tie), inside the drift, exactly +-6h (the inclusive edge), just past 6h,
  // and +-1-2 days (inside the old +-2-day read, never on a card).
  const OFFSETS = [0, 0, 60000, -(DRIFT - 60000), DRIFT, -DRIFT, DRIFT + 1000, -(DRIFT + 1000), 30 * H, -36 * H];
  const rows: Prisma.PickCreateManyInput[] = [];
  let seq = 0;
  const createdAtBase = NOW - 30 * 86400000;
  for (const [gi, g] of [...today, ...yesterday].entries()) {
    const fuzzy = g.id.endsWith("fuzzy");
    for (const [k, off] of OFFSETS.entries()) {
      seq++;
      const createdAtMs = createdAtBase + (k === 1 ? seq - 1 : seq) * 1000; // k=1 ties k=0
      const teams = fuzzy ? { homeTeam: "TBD", awayTeam: "TBD" } : g;
      const spec = fuzzy ? { ...SPECS[k % SPECS.length], betDetail: () => "Jaguars ML vs the Titans" } : SPECS[(gi + k) % SPECS.length];
      const status = k === 9 ? "WIN" : gi === 1 && k === 2 ? "CANCELLED" : "PENDING";
      const gameNumber = g.id.startsWith(PREFIX + "t2") && k === 3 ? (g.id.endsWith("a") ? 1 : 2) : null;
      rows.push(pickRow(`${PREFIX}p-${gi}-${k}`, userId, cappers[(gi + k) % cappers.length], nfl, teams, spec, new Date(g.commenceTime).getTime() + off, createdAtMs, status, gameNumber));
    }
  }
  // Must never show: another user's pick and another sport's pick on card t1.
  const t1 = new Date(today[0].commenceTime).getTime();
  rows.push(pickRow(`${PREFIX}p-other-user`, otherUserId, otherCapper, nfl, today[0], SPECS[0], t1, createdAtBase, "PENDING"));
  rows.push(pickRow(`${PREFIX}p-other-sport`, userId, cappers[0], other, today[0], SPECS[0], t1, createdAtBase, "PENDING"));
  // Graded history (60+ days back, outside every board window) so records -
  // and therefore every ranking - have real, differing values, with one exact
  // tie (capper 0 and 1, FAV_ML).
  const histTeams = { homeTeam: "Egr Hist Home", awayTeam: "Egr Hist Away" };
  for (const [c, capperId] of cappers.entries()) {
    for (const [si, spec] of SPECS.entries()) {
      const wins = c <= 1 && si === 0 ? 7 : ((c * 3 + si * 2) % 9) + 1;
      const losses = c <= 1 && si === 0 ? 3 : ((c + si) % 5) + 1;
      for (let i = 0; i < wins + losses; i++) {
        seq++;
        rows.push(pickRow(`${PREFIX}h-${c}-${si}-${i}`, userId, capperId, nfl, histTeams, spec, NOW - (60 + seq) * 86400000 / 10, createdAtBase - seq * 1000, i < wins ? "WIN" : "LOSS"));
      }
    }
  }
  await prisma.pick.createMany({ data: rows });
  console.log(`fixture: ${rows.length} picks, ${today.length} today + ${yesterday.length} yesterday cards\n`);

  // ---- 0. Preconditions: the fields the projection must carry really matter -
  const sens = (spec: Spec, drop: keyof Spec) => {
    const base = { betType: spec.betType, period: spec.period ?? "FULL_GAME", betDetail: spec.betDetail(today[0]), odds: spec.odds, line: spec.line ?? null, pickedSide: spec.pickedSide ?? null, mlFavoredSide: spec.mlFavoredSide ?? null, propMarket: spec.propMarket ?? null, sportName: SPORT };
    return [pickCategory(base), pickCategory({ ...base, [drop]: undefined })];
  };
  check("0a. precondition: dropping mlFavoredSide changes a fixture pick's category", same(sens(SPECS[1], "mlFavoredSide"), ["DOG_ML", "FAV_ML"]), json(sens(SPECS[1], "mlFavoredSide")));
  check("0b. precondition: dropping pickedSide changes a fixture pick's category", same(sens(SPECS[1], "pickedSide"), ["DOG_ML", "FAV_ML"]), json(sens(SPECS[1], "pickedSide")));
  check("0c. precondition: dropping propMarket changes a fixture pick's category", same(sens(SPECS[5], "propMarket"), ["RUSH_YDS_PROP", null]), json(sens(SPECS[5], "propMarket")));

  // ---- 1. The board ----------------------------------------------------------
  type FindMany = typeof prisma.pick.findMany;
  const original: FindMany = prisma.pick.findMany.bind(prisma.pick) as FindMany;
  let fetched: { id: string; gameTime: Date }[] = [];
  (prisma.pick as unknown as { findMany: unknown }).findMany = (async (args: Parameters<FindMany>[0]) => {
    const r = (await original(args as never)) as unknown as { id: string; gameTime: Date }[];
    fetched.push(...r);
    return r;
  }) as unknown as FindMany;

  fetched = [];
  const oldBoard = await getLiveBoardDataLegacy(userId, SPORT_KEY, SPORT);
  const oldFetched = fetched.map((r) => r.id);
  fetched = [];
  const newBoard = await getLiveBoardData(userId, SPORT_KEY, SPORT);
  const newFetched = fetched;
  (prisma.pick as unknown as { findMany: unknown }).findMany = original;

  const ids = (b: LiveBoardData) => b.expanderPicksByGame.map((card) => card.map((p) => p.pickId).sort());
  check("1a. same games on the board, same order", same(oldBoard.odds.map((g) => g.id), newBoard.odds.map((g) => g.id)), json(newBoard.odds.map((g) => g.id)));
  check("1b. the board includes yesterday's carried-over cards", yesterday.every((y) => newBoard.odds.some((g) => g.id === y.id)));
  check("1c. same scores", same(oldBoard.scores, newBoard.scores));
  check("1d. every card has the same SET of picks", same(ids(oldBoard), ids(newBoard)), json(ids(newBoard)));
  const byId = (b: LiveBoardData) => new Map(b.expanderPicksByGame.flat().map((p) => [p.pickId, p]));
  const oldById = byId(oldBoard);
  const diffs = Array.from(byId(newBoard)).filter(([id, p]) => !same(p, oldById.get(id))).map(([id]) => id);
  check("1e. every ExpanderPick is byte-identical (category, team group, labels, odds, gameNumber...)", diffs.length === 0, diffs.slice(0, 5).join(", "));

  const onCards = newBoard.expanderPicksByGame.flat();
  const cardOf = (pickId: string) => newBoard.expanderPicksByGame.findIndex((c) => c.some((p) => p.pickId === pickId));
  check("1f. coverage: yesterday's cards carry picks", yesterday.every((y) => (newBoard.expanderPicksByGame[newBoard.odds.findIndex((g) => g.id === y.id)] ?? []).length > 0));
  check("1g. coverage: picks exactly 6h from a card are on a card (inclusive edge)", [4, 5].every((k) => onCards.some((p) => p.pickId === `${PREFIX}p-0-${k}`)));
  // y1 (fixture index 5) is the one matchup on no other card - ONE's +-1-2-day
  // picks legitimately land on ONE's other cards (y2 + 30h is exactly 6h from t1).
  check("1h. coverage: picks just past 6h or +-1-2 days from their only card are on no card", [6, 7, 8, 9].every((k) => !onCards.some((p) => p.pickId === `${PREFIX}p-5-${k}`)));
  check("1h'. ...and the old +-2-day read did fetch them", [6, 7, 8, 9].every((k) => oldFetched.includes(`${PREFIX}p-5-${k}`)));
  const fuzzyIdx = newBoard.odds.findIndex((g) => g.id.endsWith("fuzzy"));
  check("1i. coverage: the fuzzy text-match card has picks", (newBoard.expanderPicksByGame[fuzzyIdx] ?? []).length > 0);
  const twinCards = [newBoard.odds.findIndex((g) => g.id === PREFIX + "t2a"), newBoard.odds.findIndex((g) => g.id === PREFIX + "t2b")];
  check("1j. coverage: picks of the twin matchup split across both cards", twinCards.every((i) => (newBoard.expanderPicksByGame[i] ?? []).length > 0));
  check("1k. coverage: no other-user / other-sport pick on any card", !onCards.some((p) => p.pickId.includes("other")));
  check("1l. coverage: a DOG_ML-by-stored-side pick and a propMarket-only pick are on the board", onCards.some((p) => p.category === "DOG_ML" && p.odds < 0) && onCards.some((p) => p.category === "RUSH_YDS_PROP"));

  // Egress: the new read is a strict subset of the old one, bounded to the window.
  const times = newBoard.odds.map((g) => new Date(g.commenceTime).getTime());
  const lo = Math.min(...times) - DRIFT;
  const hi = Math.max(...times) + DRIFT;
  check("1m. new read is a subset of the old read", newFetched.every((r) => oldFetched.includes(r.id)));
  check("1n. new read is inside [earliest - 6h, latest + 6h]", newFetched.every((r) => r.gameTime.getTime() >= lo && r.gameTime.getTime() <= hi));
  check("1o. new read fetches fewer rows than the old one", newFetched.length < oldFetched.length, `old ${oldFetched.length}, new ${newFetched.length}`);
  console.log(`   board rows fetched: old ${oldFetched.length}, new ${newFetched.length}; picks on cards ${onCards.length}`);

  // The one allowed difference, asserted: each card is (gameTime, createdAt, id) ordered.
  const rowsPerCard = await getPicksForGames(
    userId,
    SPORT,
    newBoard.odds.map((g) => ({ homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: new Date(g.commenceTime) }))
  );
  const meta = new Map(rows.map((r) => [r.id as string, r]));
  const key = (id: string) => {
    const r = meta.get(id)!;
    return [new Date(r.gameTime as Date).getTime(), new Date(r.createdAt as Date).getTime(), id] as const;
  };
  const ordered = (list: string[]) =>
    list.every((id, i) => {
      if (i === 0) return true;
      const [a, b] = [key(list[i - 1]), key(id)];
      return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
    });
  check("1p. every card is ordered by (gameTime, createdAt, id)", rowsPerCard.every((card) => ordered(card.map((p) => p.id))));
  check("1q. the gameTime + createdAt tie is broken by id", (() => {
    const card = rowsPerCard[0].map((p) => p.id);
    return card.indexOf(`${PREFIX}p-0-0`) >= 0 && card.indexOf(`${PREFIX}p-0-0`) < card.indexOf(`${PREFIX}p-0-1`);
  })());
  check("1r. the board shows cards in that order too", newBoard.expanderPicksByGame.every((card, i) => same(card.map((p) => p.pickId), rowsPerCard[i].map((p) => p.id))));

  // ---- 2. Auto-Generate (as parlay-generator.ts builds it) -----------------------
  async function generate(board: LiveBoardData) {
    const now = new Date(NOW);
    const inWindow = autoGenerateWindow(SPORT, board.odds.map((g) => g.commenceTime), now);
    const doubleheaders = doubleheaderGameIds(board.odds, board.scores);
    const games: GeneratorGame[] = [];
    board.odds.forEach((g, i) => {
      if (!inWindow(g.commenceTime)) return;
      const picks = board.expanderPicksByGame[i].filter((p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string");
      games.push({ gameId: g.id, gameLabel: picks[0]?.gameLabel ?? g.awayTeam + " @ " + g.homeTeam, gameTime: g.commenceTime, leagueName: SPORT, picks, doubleheader: doubleheaders.has(g.id) });
    });
    const scoped = filterGamesByInclude(games, "ALL");
    const all = scoped.flatMap((g) => g.picks);
    const records = await getCapperLeagueRecords(userId, all.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })));
    const categoryRecords = await getCapperCategoryRecords(
      userId,
      all.filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null).map((p) => ({ capperId: p.capperId, category: p.category }))
    );
    const primary = lockParlay(buildAutoParlay(scoped, records, 3, null), scoped, records, EMPTY_SLIP);
    if ("error" in primary) return { error: primary.error };
    const maxPerGame = toMaxLegsPerGame(2);
    const sameGameOf = (p: AutoParlay) => buildSameGameLegs(p, scoped, categoryRecords, maxPerGame);
    const set = buildParlaySet({ games: scoped, records, slip: EMPTY_SLIP, primary, includePrimary: true, count: 3, exclude: new Set(), extraLegs: (p) => sameGameOf(p).legs.map((l) => l.pick.pickId), rng: seeded(20261019) });
    const parlayA = set.parlays[0] ?? primary;
    return {
      games: scoped.length,
      primary,
      set,
      sameGame: sameGameOf(parlayA),
      hedge: buildSwapParlay(parlayA, scoped, "AUTO_HEDGE", categoryRecords),
      contrarian: buildSwapParlay(parlayA, scoped, "CONTRARIAN", categoryRecords),
    };
  }
  const oldGen = await generate(oldBoard);
  const newGen = await generate(newBoard);
  const summary = (g: Awaited<ReturnType<typeof generate>>) => ("error" in g ? { games: 0, legs: 0 } : { games: g.games, legs: g.primary.legs.length });
  check("2a. coverage: the generator found games and built a Primary with legs", summary(newGen).games >= 3 && summary(newGen).legs > 0, json(summary(newGen)));
  check("2b. Auto-Generate output identical: Primary, alternates (seeded), same-game fill, Hedge, Contrarian", same(oldGen, newGen));

  // ---- 3. Live tiles + each tile's ranked pick list ("Top Picks") -----------------
  const panel = await getSportCategoryPanelData(userId, SPORT);
  const chipSet = chipSetForLeague(SPORT).map((key) => ({ key, label: key }));
  async function tiles(board: LiveBoardData) {
    const games = board.odds.map((g) => ({ id: g.id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime }));
    const picks: LiveCategoryPick[] = board.expanderPicksByGame.flatMap((gamePicks, gameIndex) =>
      gamePicks.map((p) => ({ pickId: p.pickId, gameIndex, category: p.category, betDetail: p.betDetail, capperId: p.capperId, capperName: p.capperName, status: p.status, gameTime: p.gameTime }))
    );
    const byCategory = slatePicksByCategory(picks, visibleGameIndexes(games, board.scores, easternDateKey(new Date(NOW)), SPORT_KEY));
    const tileList = buildCategoryTiles(chipSet, panel.breakdown, new Map(Array.from(byCategory, ([k, list]) => [k, list.length])));
    const entries = Array.from(new Map(picks.filter((p) => p.category !== null && p.status !== "CANCELLED").map((p) => [p.capperId + "|" + p.category, { capperId: p.capperId, leagueSport: SPORT, category: p.category as PickCategoryKey }])).values());
    const records = (await getCapperLeagueRecords(userId, entries)).records;
    const lists = Object.fromEntries(Array.from(byCategory, ([k, list]) => [k, categoryPickRows(rankCategoryPicks(list, SPORT, records), games)]));
    return { tileList, lists };
  }
  const oldTiles = await tiles(oldBoard);
  const newTiles = await tiles(newBoard);
  check("3a. coverage: at least 3 categories have ranked lists of 2+ picks", Object.values(newTiles.lists).filter((l) => l.length >= 2).length >= 3, json(Object.fromEntries(Object.entries(newTiles.lists).map(([k, l]) => [k, l.length]))));
  check("3b. tile slate counts identical", same(oldTiles.tileList, newTiles.tileList));
  check("3c. every tile's ranked pick list identical (rank, pick, capper, game)", same(oldTiles.lists, newTiles.lists));

  // ---- 4. Game detail (getPicksForGame) for every card -----------------------------
  const pageView = (p: Awaited<ReturnType<typeof getPicksForGame>>[number]) => ({
    id: p.id,
    capperId: p.capperId,
    capper: { name: p.capper.name, colorTag: p.capper.colorTag, isFavorite: p.capper.isFavorite },
    betType: p.betType,
    betDetail: p.betDetail,
    line: p.line,
    odds: p.odds,
    units: p.units,
    status: p.status,
    period: p.period,
    pickedSide: p.pickedSide,
    category: pickCategory({ ...p, sportName: SPORT }),
  });
  let detailDiffs = 0;
  let detailPicks = 0;
  for (const g of newBoard.odds) {
    const params = { sportName: SPORT, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: new Date(g.commenceTime) };
    const [a, b] = [await getPicksForGameLegacy(userId, params), await getPicksForGame(userId, params)];
    const sortById = <T extends { id: string }>(l: T[]) => [...l].sort((x, y) => (x.id < y.id ? -1 : 1));
    detailPicks += b.length;
    if (!same(sortById(a).map(pageView), sortById(b).map(pageView))) {
      detailDiffs++;
      console.log("   differs on " + g.id);
    }
  }
  check("4a. game detail: every card's picks and the fields the page reads are identical", detailDiffs === 0 && detailPicks > 0, `${detailDiffs} cards differ, ${detailPicks} picks`);
}

async function cleanup() {
  const picks = (await prisma.pick.deleteMany({ where: { id: { in: created.picks } } })).count;
  const snaps = (await prisma.oddsSnapshot.deleteMany({ where: { id: { in: created.snapshots } } })).count;
  const cappers = (await prisma.capper.deleteMany({ where: { id: { in: created.cappers } } })).count;
  const users = (await prisma.user.deleteMany({ where: { id: { in: created.users } } })).count;
  const sports = (await prisma.sport.deleteMany({ where: { id: { in: created.sports } } })).count;
  console.log(`\ncleanup: deleted ${picks} picks, ${snaps} snapshots, ${cappers} cappers, ${users} users, ${sports} sports`);
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
