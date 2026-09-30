// Parity proof for the cron/model-engine egress change: recomputeTeamTendencies,
// getPregameEventFacts / persistPregameDecayDeltaGames, resolveAllGameObservations
// and persistGradedDecayDeltaGames used to pull whole OddsSnapshot boards and
// whole GameResult rows into JS. They now read slim Postgres-side projections
// (odds-projections.ts) and explicit column selects. This test runs the OLD
// read (full board / full row, the code as it was) and the NEW read against the
// same rows and requires the serialized results to match exactly:
//
//   1. tendency counts + every per-game odds lookup (matched game, both
//      moneyline prices, total line) - fixture boards AND any real snapshots in
//      the dev DB
//   2. pregame facts for every (game, day) plus non-existent pairs, and the
//      latest-snapshot game list
//   3. observations and the graded decay-delta predictions
//   4. the per-run snapshot source reads each day's board once, not per game
//
// Fixtures use sportKeys prefixed "parity_" (created and removed here) and cover
// NFL/NCAAF/MLB-shaped boards: several bookmakers, missing / duplicated / point-
// less / price-less markets, an explicit null point, cross-source name spellings,
// pick'em prices, and one game appearing in several daily snapshots (the tie the
// snapshot order decides). Also prints bytes read old vs new.
//
// Only ever touches a local dev/CI database: refuses to run against any other
// host. Run with:
//   npx tsx src/server/data/odds-projections-parity-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import type { OddsGame } from "@/server/data/odds";
import {
  computeTendencyCounts,
  findOddsGameForResult,
  moneylinePrice,
  totalLine,
  recomputeTeamTendencies,
} from "@/server/data/team-tendencies";
import {
  getOddsGamesForTendencies,
  getPregameSnapshotGames,
  getLatestPregameSnapshot,
} from "@/server/data/odds-projections";
import {
  derivePregameEventFacts,
  getPregameEventFacts,
  createPregameSnapshotSource,
} from "@/server/data/model-engine/pregame-facts";
import { deriveObservations, resolveAllGameObservations } from "@/server/data/model-engine/observations";
import {
  computeGradedDecayDelta,
  persistGradedDecayDeltaGames,
  persistPregameDecayDeltaGames,
  GRADED_GAME_SELECT,
} from "@/server/data/model-engine/decay-delta-predictions";

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
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${!ok && detail ? " - " + detail : ""}`);
  if (!ok) failures++;
}
function same(label: string, a: unknown, b: unknown) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  check(label, sa === sb, sa === sb ? undefined : `old=${sa.slice(0, 300)} new=${sb.slice(0, 300)}`);
}

// ---- metering ---------------------------------------------------------------

const rawQ = (prisma as unknown as { $queryRaw: (...a: unknown[]) => Promise<unknown> }).$queryRaw.bind(prisma);
// Test-side reads (not metered): plain SQL with positional params.
const rawU = (sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params);
let meterBytes = 0;
let meterQueries: string[] = [];
(prisma as unknown as { $queryRaw: unknown }).$queryRaw = async (q: { sql?: string; strings?: string[] }, ...rest: unknown[]) => {
  const out = await rawQ(q, ...rest);
  meterBytes += Buffer.byteLength(JSON.stringify(out));
  meterQueries.push(q.sql ?? (q.strings ?? []).join("?"));
  return out;
};
async function metered<T>(fn: () => Promise<T>): Promise<{ value: T; bytes: number; queries: string[] }> {
  meterBytes = 0;
  meterQueries = [];
  const value = await fn();
  return { value, bytes: meterBytes, queries: meterQueries };
}
const kB = (n: number) => (n / 1024).toFixed(1) + " kB";

async function boardBytes(sportKey: string, fetchDate?: string): Promise<number> {
  const rows = (await rawU(
    `SELECT COALESCE(sum(octet_length(data::text)),0)::bigint AS b FROM odds_snapshots WHERE "sportKey" = $1 AND ($2::text IS NULL OR "fetchDate" = $2)`,
    sportKey,
    fetchDate ?? null
  )) as { b: bigint }[];
  return Number(rows[0].b);
}

// ---- fixtures -----------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Odds-source spelling on the left, score-source spelling on the right where they differ.
const TEAMS: [string, string][] = [
  ["St. Louis Cardinals", "St Louis Cardinals"],
  ["Montréal Canadiens", "Montreal Canadiens"],
  ["Kansas City Chiefs", "Kansas City Chiefs"],
  ["Denver Broncos", "Denver Broncos"],
  ["Buffalo Bills", "Buffalo Bills"],
  ["Miami Dolphins", "Miami Dolphins"],
  ["Alabama Crimson Tide", "Alabama Crimson Tide"],
  ["Georgia Bulldogs", "Georgia Bulldogs"],
  ["Texas A&M Aggies", "Texas A&M Aggies"],
  ["Ohio State Buckeyes", "Ohio State Buckeyes"],
  ["Boston Red Sox", "Boston Red Sox"],
  ["Seattle Mariners", "Seattle Mariners"],
  ["Chicago Cubs", "Chicago Cubs"],
  ["Los Angeles Dodgers", "Los Angeles Dodgers"],
];

const SPORTS = ["parity_nfl", "parity_ncaaf", "parity_mlb"];
const DAYS = 9;
const BASE = Date.parse("2026-08-10T00:00:00Z");
const dateKey = (d: number) => new Date(BASE + d * 86400000).toISOString().slice(0, 10);

type Fixture = { games: OddsGame[][]; results: Prisma_GameResultInput[] };
type Prisma_GameResultInput = {
  sportKey: string;
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
  favTeam: string | null;
  totalLine: number | null;
  isPreseason: boolean;
};

function buildFixture(sportKey: string, seed: number): Fixture {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const price = () => (r() < 0.5 ? -1 : 1) * (100 + Math.floor(r() * 250));
  const totalPt = () => 38 + Math.floor(r() * 20) + (r() < 0.5 ? 0.5 : 0);
  const outcomes = (home: string, away: string, kind: "h2h" | "spreads" | "totals") => {
    if (kind === "totals") {
      const pt = totalPt();
      const os: Record<string, unknown>[] = [
        { name: "Over", price: price(), point: pt },
        { name: "Under", price: price(), point: pt },
      ];
      const roll = r();
      if (roll < 0.12) return os.map(({ point: _p, ...o }) => o); // no point at all
      if (roll < 0.17) return os.map((o) => ({ ...o, point: null })); // explicit null point
      return os;
    }
    const p = price();
    const os: Record<string, unknown>[] = [
      { name: home, price: kind === "h2h" && r() < 0.07 ? p : price(), ...(kind === "spreads" ? { point: -3.5 } : {}) },
      { name: away, price: kind === "h2h" && r() < 0.07 ? p : price(), ...(kind === "spreads" ? { point: 3.5 } : {}) },
    ];
    if (kind === "h2h") {
      const roll = r();
      if (roll < 0.06) os.pop(); // only one side listed
      else if (roll < 0.1) delete os[0].price; // outcome with no price
    }
    return os;
  };

  const universe: { home: string; away: string; commence: number; homeR: string; awayR: string }[] = [];
  for (let d = 0; d < DAYS + 3; d++) {
    const n = 6 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const [h, a] = [pick(TEAMS), pick(TEAMS)];
      if (h[0] === a[0]) continue;
      const commence = BASE + d * 86400000 + (16 + Math.floor(r() * 10)) * 3600000; // 16:00Z..02:00Z next day
      universe.push({ home: h[0], away: a[0], commence, homeR: h[1], awayR: a[1] });
      // doubleheader nightcap: same teams, same ET day, later
      if (r() < 0.12) universe.push({ home: h[0], away: a[0], commence: commence + 4 * 3600000, homeR: h[1], awayR: a[1] });
    }
  }

  const games: OddsGame[][] = [];
  for (let d = 0; d < DAYS; d++) {
    if (d === 4) {
      games.push([]); // a snapshot that holds zero games
      continue;
    }
    const board: OddsGame[] = [];
    // A game shows up in the snapshots of the two days before it too (several fetches per game).
    for (const u of universe) {
      const gameDay = Math.floor((u.commence - BASE) / 86400000);
      if (!(gameDay === d || gameDay === d + 1 || (gameDay === d + 2 && r() < 0.5))) continue;
      const nBooks = Math.floor(r() * 6); // 0..5, including "no bookmakers"
      const bookmakers = [];
      for (let b = 0; b < nBooks; b++) {
        const markets: { key: string; outcomes: Record<string, unknown>[] }[] = [];
        const kinds = ["h2h", "spreads", "totals"] as const;
        // random market order, random omission
        for (const kind of [...kinds].sort(() => r() - 0.5)) {
          if (r() < 0.15) continue;
          markets.push({ key: kind, outcomes: outcomes(u.home, u.away, kind) });
          if (r() < 0.08) markets.push({ key: kind, outcomes: outcomes(u.home, u.away, kind) }); // duplicated market
        }
        bookmakers.push({ key: "book" + b, title: "Book " + b, markets });
      }
      board.push({
        id: `ev-${u.home}-${u.away}-${u.commence}`,
        sportKey,
        homeTeam: u.home,
        awayTeam: u.away,
        commenceTime: new Date(u.commence).toISOString(),
        bookmakers,
      } as unknown as OddsGame);
    }
    games.push(board);
  }

  const results: Prisma_GameResultInput[] = [];
  universe.forEach((u, i) => {
    if (r() < 0.25) return; // some finished games have no odds match at all
    const gameDate = new Date(u.commence + (r() < 0.15 ? 30 * 3600000 : Math.floor((r() - 0.5) * 6 * 3600000)));
    const homeScore = Math.floor(r() * 40);
    const awayScore = r() < 0.05 ? homeScore : Math.floor(r() * 40);
    const hasLedger = r() < 0.6;
    results.push({
      sportKey,
      externalId: "res-" + i,
      homeTeam: u.homeR,
      awayTeam: u.awayR,
      homeScore,
      awayScore,
      gameDate,
      favTeam: hasLedger ? (r() < 0.9 ? (r() < 0.5 ? u.homeR : u.awayR) : "Nobody FC") : null,
      totalLine: hasLedger ? totalPt() : null,
      isPreseason: r() < 0.1,
    });
  });
  return { games, results };
}

async function cleanup() {
  await prisma.decayDeltaPrediction.deleteMany({ where: { sportKey: { in: SPORTS } } });
  await prisma.teamTendency.deleteMany({ where: { sportKey: { in: SPORTS } } });
  await prisma.gameResult.deleteMany({ where: { sportKey: { in: SPORTS } } });
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: { in: SPORTS } } });
}

// ---- comparisons -----------------------------------------------------------------

async function oldTendencyBoards(sportKey: string): Promise<OddsGame[]> {
  const snaps = await prisma.oddsSnapshot.findMany({ where: { sportKey }, select: { data: true } }); // the original read
  return snaps.flatMap((s) => s.data as unknown as OddsGame[]);
}

function lookups(results: { homeTeam: string; awayTeam: string; gameDate: Date }[], boards: OddsGame[]) {
  return results.map((g) => {
    const m = findOddsGameForResult(boards, g);
    return m
      ? { idx: boards.indexOf(m), home: moneylinePrice(m, g.homeTeam), away: moneylinePrice(m, g.awayTeam), total: totalLine(m) }
      : null;
  });
}

async function compareTendencies(sportKey: string, label: string) {
  const results = await prisma.gameResult.findMany({
    where: { sportKey, isPreseason: false },
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
  });
  const oldBoards = await oldTendencyBoards(sportKey);
  const oldBytes = await boardBytes(sportKey);
  const nu = await metered(() => getOddsGamesForTendencies(sportKey));
  check(`${label}: same game count and snapshot count`, nu.value.games.length === oldBoards.length, `${nu.value.games.length} vs ${oldBoards.length}`);
  const snapCount = await prisma.oddsSnapshot.count({ where: { sportKey } });
  check(`${label}: snapshotCount`, nu.value.snapshotCount === snapCount);
  same(`${label}: per-game lookups (matched game, both moneyline prices, total line)`, lookups(results, oldBoards), lookups(results, nu.value.games));
  const a = computeTendencyCounts(results, oldBoards);
  const b = computeTendencyCounts(results, nu.value.games);
  same(`${label}: tendency counts`, [...a.acc.entries()], [...b.acc.entries()]);
  check(`${label}: gamesProcessed ${a.gamesProcessed}`, a.gamesProcessed === b.gamesProcessed);
  return { label, oldBytes, newBytes: nu.bytes, games: oldBoards.length, snapshots: snapCount, processed: a.gamesProcessed };
}

async function comparePregame(sportKey: string, label: string, dates: string[]) {
  let pairs = 0;
  let nonNull = 0;
  let oldBytesPerCall = 0;
  let newBytesPerCall = 0;
  for (const fetchDate of dates) {
    const snap = await prisma.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey, fetchDate } } }); // the original read
    const full = (snap?.data ?? []) as unknown as OddsGame[];
    const projected = await metered(() => getPregameSnapshotGames(sportKey, fetchDate));
    oldBytesPerCall += snap ? Buffer.byteLength(JSON.stringify(snap.data)) : 0;
    newBytesPerCall += projected.bytes;
    const now = new Date(`${fetchDate}T15:00:00Z`);
    const asks = new Map<string, [string, string]>();
    for (const g of full) asks.set(g.homeTeam + "|" + g.awayTeam, [g.homeTeam, g.awayTeam]);
    asks.set("nobody|nowhere", ["Nobody FC", "Nowhere United"]);
    const flipped = [...asks.values()].map(([h, a]) => [a, h] as [string, string]);
    for (const [h, a] of [...asks.values(), ...flipped]) {
      const oldFacts = derivePregameEventFacts(full, h, a, now);
      const newFacts = derivePregameEventFacts(projected.value, h, a, now);
      pairs++;
      if (oldFacts) nonNull++;
      if (JSON.stringify(oldFacts) !== JSON.stringify(newFacts)) {
        check(`${label}: pregame facts ${fetchDate} ${h} v ${a}`, false, `old=${JSON.stringify(oldFacts)} new=${JSON.stringify(newFacts)}`);
        return;
      }
    }
  }
  check(`${label}: pregame facts identical for ${pairs} lookups (${nonNull} non-null) across ${dates.length} days`, true);
  return { label, pairs, oldBytesPerCall: oldBytesPerCall / Math.max(dates.length, 1), newBytesPerCall: newBytesPerCall / Math.max(dates.length, 1) };
}

async function main() {
  await cleanup();
  const tendencyReport: Awaited<ReturnType<typeof compareTendencies>>[] = [];
  const pregameReport: NonNullable<Awaited<ReturnType<typeof comparePregame>>>[] = [];
  try {
    // Insert in ascending fetchDate order so the heap order the old unordered
    // findMany saw is the same chronological order the new query pins.
    const fixtures = SPORTS.map((s, i) => ({ sportKey: s, fx: buildFixture(s, 1000 + i * 77) }));
    for (const { sportKey, fx } of fixtures) {
      for (let d = 0; d < DAYS; d++) {
        await prisma.oddsSnapshot.create({ data: { sportKey, fetchDate: dateKey(d), data: fx.games[d] as unknown as object } });
      }
      await prisma.gameResult.createMany({ data: fx.results });
    }

    console.log("\n########## 1. Team tendencies (fixtures) ##########");
    for (const { sportKey } of fixtures) tendencyReport.push(await compareTendencies(sportKey, sportKey));

    // End to end through recomputeTeamTendencies: written TeamTendency rows equal
    // the counts the old full-board read yields.
    for (const { sportKey } of fixtures) {
      const summary = await metered(() => recomputeTeamTendencies(sportKey));
      const results = await prisma.gameResult.findMany({
        where: { sportKey, isPreseason: false },
        select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
      });
      const oldBoards = await oldTendencyBoards(sportKey);
      const expected = computeTendencyCounts(results, oldBoards);
      const rows = await prisma.teamTendency.findMany({ where: { sportKey }, orderBy: { teamName: "asc" } });
      const COUNT_FIELDS = ["favWins", "favLosses", "favPushes", "dogWins", "dogLosses", "dogPushes", "overCount", "underCount", "totalPushCount"];
      const strip = (o: Record<string, unknown>) => ({ teamName: o.teamName, ...Object.fromEntries(COUNT_FIELDS.map((k) => [k, o[k]])) });
      same(
        `${sportKey}: recomputeTeamTendencies wrote the same TeamTendency rows`,
        [...expected.acc.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([teamName, c]) => ({ teamName, ...c })),
        rows.map((r) => strip(r as unknown as Record<string, unknown>))
      );
      check(
        `${sportKey}: instrumentation (${summary.value.gamesProcessed} processed, ${summary.value.oddsSnapshotRows} snapshots, ${summary.value.oddsGamesFlattened} games)`,
        summary.value.gamesProcessed === expected.gamesProcessed &&
          summary.value.oddsSnapshotRows === DAYS &&
          summary.value.oddsGamesFlattened === oldBoards.length
      );
    }
    check(
      "fixtures exercised the interesting paths (some games matched, some not)",
      tendencyReport.every((t) => t.processed > 0 && t.processed < 200)
    );

    console.log("\n########## 2. Pregame facts ##########");
    for (const { sportKey } of fixtures) {
      const p = await comparePregame(sportKey, sportKey, Array.from({ length: DAYS }, (_, d) => dateKey(d)));
      if (p) pregameReport.push(p);
    }

    // Latest snapshot (persistPregameDecayDeltaGames' notStarted list).
    for (const { sportKey } of fixtures) {
      const oldLatest = await prisma.oddsSnapshot.findFirst({ where: { sportKey }, orderBy: { fetchDate: "desc" } });
      const newLatest = await getLatestPregameSnapshot(sportKey);
      const oldGames = ((oldLatest?.data ?? []) as unknown as OddsGame[]).map((g) => [g.homeTeam, g.awayTeam, g.commenceTime]);
      same(
        `${sportKey}: latest snapshot fetchDate + games`,
        { fetchDate: oldLatest?.fetchDate, games: oldGames },
        { fetchDate: newLatest?.fetchDate, games: (newLatest?.games ?? []).map((g) => [g.homeTeam, g.awayTeam, g.commenceTime]) }
      );
    }
    same("latest snapshot of a sport with no snapshots", null, await getLatestPregameSnapshot("parity_none"));

    // Per-run source: N lookups on one day -> one board read.
    {
      let reads = 0;
      const source = createPregameSnapshotSource(async (s, d) => {
        reads++;
        return getPregameSnapshotGames(s, d);
      });
      const today = easternDateKey(new Date());
      for (let i = 0; i < 25; i++) await getPregameEventFacts("parity_mlb", "Nobody FC", "Nowhere United", source);
      await source("parity_mlb", today);
      check("shared source reads each day's board once for 25 lookups", reads === 1, `reads=${reads}`);
      let failedOnce = false;
      const flaky = createPregameSnapshotSource(async () => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("boom");
        }
        return [];
      });
      await flaky("parity_mlb", "2026-01-01").catch(() => undefined);
      check("a failed read is not cached for the rest of the run", (await flaky("parity_mlb", "2026-01-01")).length === 0);
    }

    console.log("\n########## 3. Observations / graded decay-delta (parity_mlb) ##########");
    const sportKey = "parity_mlb";
    const fullRows = await prisma.gameResult.findMany({ where: { sportKey }, orderBy: { gameDate: "asc" } }); // the original read
    const obsNew = await resolveAllGameObservations(sportKey);
    same(`observations (${obsNew.length})`, deriveObservations(fullRows), obsNew);
    check("observations non-trivial", obsNew.length > 10);

    const sel = await prisma.gameResult.findMany({
      where: { sportKey, favTeam: { not: null }, totalLine: { not: null } },
      orderBy: { gameDate: "asc" },
      select: GRADED_GAME_SELECT,
    });
    const fullGraded = fullRows.filter((g) => g.favTeam !== null && g.totalLine !== null);
    same(
      `graded select == full rows restricted to the selected columns (${sel.length} rows)`,
      fullGraded.map((g) => Object.fromEntries(Object.keys(GRADED_GAME_SELECT).map((k) => [k, (g as Record<string, unknown>)[k]]))),
      sel
    );
    // Rows the old code would have computed, using full rows.
    const allObservations = deriveObservations(fullRows);
    const expected: Record<string, unknown> = {};
    for (const row of fullGraded) expected[row.id] = await computeGradedDecayDelta(row, { allObservations });
    const gradedRun = await persistGradedDecayDeltaGames(sportKey);
    const persisted = await prisma.decayDeltaPrediction.findMany({ where: { sportKey, gameResultId: { not: null } } });
    const actual: Record<string, unknown> = {};
    for (const p of persisted) {
      actual[p.gameResultId!] = {
        favTeam: p.favTeam, dogTeam: p.dogTeam, totalLine: p.totalLine, favRate: p.favRate, dogRate: p.dogRate,
        delta: p.delta, bucket: p.bucket, favWon: p.favWon, wentOver: p.wentOver,
      };
    }
    const expectedPersisted = Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== null));
    same(`persistGradedDecayDeltaGames wrote the predictions the full-row path computes (${persisted.length} rows)`, expectedPersisted, actual);
    check("graded pass persisted something", persisted.length > 0, JSON.stringify(gradedRun));
    check("scanned == graded candidates", gradedRun.scanned === fullGraded.length);

    // Pregame sync: one board read for the whole loop, whatever the number of games.
    const today = easternDateKey(new Date());
    const nowMs = Date.now();
    const futureGames = [0, 1, 2].map((i) => ({
      id: "fut" + i,
      sportKey,
      homeTeam: TEAMS[10 + i][0],
      awayTeam: TEAMS[13 - i][0],
      commenceTime: new Date(nowMs + (2 + i) * 60000).toISOString(),
      bookmakers: [
        { key: "b", title: "B", markets: [{ key: "h2h", outcomes: [{ name: TEAMS[10 + i][0], price: -120 }, { name: TEAMS[13 - i][0], price: 100 }] }, { key: "totals", outcomes: [{ name: "Over", price: -110, point: 8.5 }, { name: "Under", price: -110, point: 8.5 }] }] },
      ],
    }));
    await prisma.oddsSnapshot.create({ data: { sportKey, fetchDate: today, data: futureGames as unknown as object } });
    const sync = await metered(() => persistPregameDecayDeltaGames(sportKey));
    const snapQueries = sync.queries.filter((q) => q.includes("odds_snapshots")).length;
    check(`pregame sync saw 3 candidate games (${JSON.stringify(sync.value)})`, sync.value.candidateGames === 3);
    check(`pregame sync board reads independent of game count (${snapQueries} odds_snapshots queries for 3 games; old code: ${1 + 2 * 3} full-board reads)`, snapQueries <= 3);

    console.log("\n########## 4. Real snapshots in this database (read-only) ##########");
    const realSports = (
      (await rawU(`SELECT DISTINCT "sportKey" FROM odds_snapshots WHERE "sportKey" NOT LIKE 'parity\\_%' ORDER BY 1`)) as { sportKey: string }[]
    ).map((r) => r.sportKey);
    if (realSports.length === 0) console.log("(none - fixtures only)");
    for (const s of realSports) {
      tendencyReport.push(await compareTendencies(s, "real " + s));
      const dates = ((await rawU(`SELECT "fetchDate" FROM odds_snapshots WHERE "sportKey" = $1 ORDER BY 1`, s)) as { fetchDate: string }[]).map((r) => r.fetchDate);
      const p = await comparePregame(s, "real " + s, dates);
      if (p) pregameReport.push(p);
    }

    console.log("\n########## Bytes read per call: old (full board) vs new (projection) ##########");
    for (const t of tendencyReport) {
      console.log(
        `recomputeTeamTendencies odds read  ${t.label.padEnd(22)} ${String(t.snapshots).padStart(3)} snapshots ${String(t.games).padStart(5)} games   old ${kB(t.oldBytes).padStart(10)}   new ${kB(t.newBytes).padStart(9)}   (${((100 * t.newBytes) / Math.max(t.oldBytes, 1)).toFixed(1)}%)`
      );
    }
    for (const p of pregameReport) {
      console.log(
        `getPregameEventFacts per board read ${p.label.padEnd(22)} avg per day        old ${kB(p.oldBytesPerCall).padStart(10)}   new ${kB(p.newBytesPerCall).padStart(9)}   (${((100 * p.newBytesPerCall) / Math.max(p.oldBytesPerCall, 1)).toFixed(1)}%)`
      );
    }
    const fullBytes = Number(
      ((await rawU(`SELECT COALESCE(sum(octet_length(row_to_json(g)::text)),0)::bigint AS b FROM game_results g WHERE "sportKey" = $1`, sportKey)) as { b: bigint }[])[0].b
    );
    const cols = Object.keys(GRADED_GAME_SELECT).map((c) => `"${c}"`).join(", ");
    const slimBytes = Number(
      ((await rawU(`SELECT COALESCE(sum(octet_length(row_to_json(s)::text)),0)::bigint AS b FROM (SELECT ${cols} FROM game_results WHERE "sportKey" = $1) s`, sportKey)) as { b: bigint }[])[0].b
    );
    console.log(
      `GameResult rows (persistGraded / observations) parity_mlb ${fullRows.length} rows: old ${kB(fullBytes)} (fixture rows carry no JSON blobs; real MLB rows add inningsJson/linescoreJson) new ${kB(slimBytes)}`
    );
    check("tendency projection reads a small fraction of the boards", tendencyReport.filter((t) => t.oldBytes > 50000).every((t) => t.newBytes < t.oldBytes * 0.5));
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll parity checks passed.");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
  } finally {
    process.exit(1);
  }
});
