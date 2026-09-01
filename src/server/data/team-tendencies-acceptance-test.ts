// Proof for M9 (see docs/m9-team-tendencies.md): recomputeTeamTendencies is
// all-captured-history by design - NOT a rolling window, trailing-N-games, or
// season-to-date metric. The load-bearing test here is #2: a 400-day-old
// GameResult MUST still be counted. If someone ever adds a
// `where: { gameDate: { gte: ... } }` (or any implicit recency filter) to the
// tendency query, test #2 fails and CI blocks it - because that would silently
// change what every downstream fav/dog/over/under rate and every historical
// TeamTendencySnapshot means.
//
// Also locks in the pick'em exclusion, the tie -> push handling, the
// MIN_TENDENCY_SAMPLE floor, and findOddsGameForResult's closest-by-commence
// dedupe.
//
// Pure: the prisma singleton's methods are swapped for spies before each call,
// so no database is touched. Run with:
//   npx tsx src/server/data/team-tendencies-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import {
  recomputeTeamTendencies,
  findOddsGameForResult,
  computeTendencyRates,
  MIN_TENDENCY_SAMPLE,
} from "@/server/data/team-tendencies";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const SPORT = "baseball_mlb";

// ---- fixtures -------------------------------------------------------------

type Row = { homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; gameDate: Date };

function gr(over: Partial<Row> = {}): Row {
  return {
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    homeScore: 5,
    awayScore: 3,
    gameDate: new Date("2026-06-01T23:05:00Z"),
    ...over,
  };
}

// An OddsGame whose commenceTime lines up with `row.gameDate` (so
// findOddsGameForResult matches it), with a moneyline favorite and a total.
function oddsFor(
  row: Row,
  opts: { homePrice?: number; awayPrice?: number; total?: number | null } = {}
): OddsGame {
  const homePrice = opts.homePrice ?? -150;
  const awayPrice = opts.awayPrice ?? 130;
  const markets: OddsGame["bookmakers"][number]["markets"] = [
    { key: "h2h", outcomes: [
      { name: row.homeTeam, price: homePrice },
      { name: row.awayTeam, price: awayPrice },
    ] },
  ];
  const total = opts.total === undefined ? 8.5 : opts.total;
  if (total !== null) {
    markets.push({ key: "totals", outcomes: [
      { name: "Over", price: -110, point: total },
      { name: "Under", price: -110, point: total },
    ] });
  }
  return {
    id: `og-${row.homeTeam}-${row.gameDate.getTime()}`,
    sportKey: SPORT,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    commenceTime: row.gameDate.toISOString(),
    bookmakers: [{ key: "book1", title: "Book 1", markets }],
  };
}

// ---- prisma spies -------------------------------------------------------

const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

type Counts = {
  favWins: number; favLosses: number; favPushes: number;
  dogWins: number; dogLosses: number; dogPushes: number;
  overCount: number; underCount: number; totalPushCount: number;
};

async function runRecompute(rows: Row[], oddsGames: OddsGame[]) {
  patch("gameResult.findMany", async () => rows);
  patch("oddsSnapshot.findMany", async () => [{ data: oddsGames }]);
  const upserts: { where: { sportKey_teamName: { teamName: string } }; create: Counts & { teamName: string } }[] = [];
  patch("teamTendency.upsert", async (args: (typeof upserts)[number]) => {
    upserts.push(args);
    return {};
  });
  const summary = await recomputeTeamTendencies(SPORT);
  const byTeam = new Map<string, Counts>();
  for (const u of upserts) byTeam.set(u.where.sportKey_teamName.teamName, u.create);
  return { summary, byTeam };
}

function favDecided(c: Counts) {
  return c.favWins + c.favLosses + c.favPushes;
}
function totalDecided(c: Counts) {
  return c.overCount + c.underCount + c.totalPushCount;
}

async function main() {
  // ---- 1. Full history is in scope - games years apart are ALL counted ----
  {
    const base = new Date("2026-06-01T23:05:00Z").getTime();
    const day = 86_400_000;
    const rows: Row[] = [
      gr({ homeTeam: "Yankees", awayTeam: "Red Sox", gameDate: new Date(base - 900 * day) }),
      gr({ homeTeam: "Cubs", awayTeam: "Cardinals", gameDate: new Date(base - 300 * day) }),
      gr({ homeTeam: "Mets", awayTeam: "Braves", gameDate: new Date(base - 1 * day) }),
    ];
    const { summary, byTeam } = await runRecompute(rows, rows.map((r) => oddsFor(r)));
    expect("all 3 games processed regardless of age", summary.gamesProcessed, 3);
    expect("every team from every era got a row", byTeam.size, 6);
    expect("instrumentation reports the scan size", summary.gameResultRows, 3);
    expect("oddsGamesFlattened counts every snapshot game", summary.oddsGamesFlattened, 3);
  }

  // ---- 2. REGRESSION: a 400-day-old GameResult MUST be counted ----
  // A future `where: { gameDate: { gte: <~1yr ago> } }` would drop this game
  // and this assertion would fail. That is the point of the test.
  {
    const now = new Date("2026-08-31T00:00:00Z").getTime();
    const day = 86_400_000;
    const oldRow = gr({
      homeTeam: "Athletics",
      awayTeam: "Mariners",
      homeScore: 2,
      awayScore: 7, // away (dog at +130) wins
      gameDate: new Date(now - 400 * day),
    });
    const recentRow = gr({
      homeTeam: "Yankees",
      awayTeam: "Red Sox",
      homeScore: 6,
      awayScore: 1, // home (fav at -150) wins
      gameDate: new Date(now - 2 * day),
    });
    const { summary, byTeam } = await runRecompute(
      [oldRow, recentRow],
      [oldRow, recentRow].map((r) => oddsFor(r))
    );
    expect("both games counted (400-day-old one is NOT filtered out)", summary.gamesProcessed, 2);

    // Athletics were the -150 home favorite and lost by 5.
    const ath = byTeam.get("Athletics")!;
    expect("400-day-old game recorded a favorite LOSS for the Athletics", { w: ath.favWins, l: ath.favLosses }, { w: 0, l: 1 });
    const mar = byTeam.get("Mariners")!;
    expect("400-day-old game recorded an underdog WIN for the Mariners", { w: mar.dogWins, l: mar.dogLosses }, { w: 1, l: 0 });
  }

  // ---- 3. Pick'em (equal moneylines) is excluded from fav/dog, kept for O/U ----
  {
    const row = gr({ homeTeam: "Rays", awayTeam: "Jays", homeScore: 4, awayScore: 4 });
    const { byTeam } = await runRecompute(
      [row],
      [oddsFor(row, { homePrice: -110, awayPrice: -110, total: 7.5 })]
    );
    const rays = byTeam.get("Rays")!;
    const jays = byTeam.get("Jays")!;
    expect("pick'em contributes NOTHING to either team's fav/dog split", [favDecided(rays), favDecided(jays)], [0, 0]);
    expect("pick'em still counts toward the total (8 > 7.5 -> over both sides)", [rays.overCount, jays.overCount], [1, 1]);
  }

  // ---- 4. Tie score -> favPushes / dogPushes, never W/L ----
  {
    const row = gr({ homeTeam: "Reds", awayTeam: "Pirates", homeScore: 3, awayScore: 3 });
    const { byTeam } = await runRecompute(
      [row],
      [oddsFor(row, { homePrice: -200, awayPrice: 170, total: null })]
    );
    const reds = byTeam.get("Reds")!; // -200 favorite
    const bucs = byTeam.get("Pirates")!; // +170 underdog
    expect("tie -> favorite gets a push, not a W or L", { w: reds.favWins, l: reds.favLosses, p: reds.favPushes }, { w: 0, l: 0, p: 1 });
    expect("tie -> underdog gets a push, not a W or L", { w: bucs.dogWins, l: bucs.dogLosses, p: bucs.dogPushes }, { w: 0, l: 0, p: 1 });
  }

  // ---- 5. computeTendencyRates: MIN_TENDENCY_SAMPLE is a FLOOR, not a window ----
  {
    const nineteen = computeTendencyRates({
      favWins: 10, favLosses: 9, favPushes: 0, // 19 decided
      dogWins: 0, dogLosses: 0, dogPushes: 0,
      overCount: 0, underCount: 0, totalPushCount: 0,
    });
    expect("19 decided favorite games -> favWinPct hidden (null)", nineteen.favWinPct, null);

    const twenty = computeTendencyRates({
      favWins: 11, favLosses: 9, favPushes: 0, // 20 decided
      dogWins: 0, dogLosses: 0, dogPushes: 0,
      overCount: 0, underCount: 0, totalPushCount: 0,
    });
    expect("20 decided favorite games -> favWinPct shown", twenty.favWinPct, 0.55);
    expect("MIN_TENDENCY_SAMPLE unchanged", MIN_TENDENCY_SAMPLE, 20);
  }

  // ---- 6. findOddsGameForResult: closest-by-commence-time collapses re-fetches ----
  {
    const gameDate = new Date("2026-06-01T23:05:00Z");
    const near: OddsGame = {
      id: "near", sportKey: SPORT, homeTeam: "Yankees", awayTeam: "Red Sox",
      commenceTime: "2026-06-01T23:00:00Z", bookmakers: [],
    };
    const far: OddsGame = {
      id: "far", sportKey: SPORT, homeTeam: "Yankees", awayTeam: "Red Sox",
      commenceTime: "2026-06-01T20:00:00Z", bookmakers: [],
    };
    const picked = findOddsGameForResult([far, near], { homeTeam: "Yankees", awayTeam: "Red Sox", gameDate });
    expect("picks the snapshot whose commenceTime is closest to the final game", picked?.id, "near");

    const none = findOddsGameForResult([], { homeTeam: "Yankees", awayTeam: "Red Sox", gameDate });
    expect("no candidates -> null (game contributes nothing)", none, null);
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
