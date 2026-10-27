// Egress proof for the Parlay Generator: ONE Generate reads the database; the
// five Regenerates after it read NOTHING. Neither do settings that don't
// change the pool (leg count, max per game, Include Picks), Hedge or
// Contrarian. The pool is only re-read when it changes (a slip pick removed)
// or the snapshot goes stale (older than ~2 minutes).
//
// Query-logging harness: a PrismaClient with query-event logging is installed
// as the app's client (globalThis.prisma, which lib/prisma.ts reuses) BEFORE
// any app module loads, so every SQL statement the real code sends - model
// queries and raw SQL alike - is counted. The real action
// (generateParlayAction: slip rows, getLiveBoardData on a seeded odds
// snapshot, the record bundle) runs through the real browser-side session
// (generator-session.ts); only requireUser is stubbed.
//
// DB-backed and WRITING: ids prefixed `__GenZero__`, deleted by exact id.
// Refuses to run unless DATABASE_URL is local; skips if a real NFL odds
// snapshot for today exists locally (never overwritten).
//   npx tsx src/server/actions/parlay-generate-zero-reads-acceptance-test.ts
import { PrismaClient, type Prisma } from "@prisma/client";
import type { OddsGame } from "@/server/data/odds";
import type { GeneratorSettings } from "@/lib/parlay/generator";
import { drainQueryLog } from "@/server/data/query-log-drain";

const queries: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => queries.push(e.query));
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;
// Wait for every event of the calls so far before a snapshot or a count (the engine
// delivers them separately from the awaited promise).
const drain = () => drainQueryLog(logged, queries);

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  (" + detail + ")" : ""}`);
  if (!pass) failures++;
}

const PREFIX = "__GenZero__";
const USER_ID = PREFIX + "user";
const H = 3600000;
const NOW = Date.now();
const created = { picks: [] as string[], cappers: [] as string[], snapshots: [] as string[], sports: [] as string[] };

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: USER_ID }) });

const TEAMS: [string, string, string][] = [
  ["Kansas City Chiefs", "Los Angeles Chargers", "Chiefs"],
  ["Buffalo Bills", "Miami Dolphins", "Bills"],
  ["Philadelphia Eagles", "Dallas Cowboys", "Eagles"],
  ["Detroit Lions", "Chicago Bears", "Lions"],
  ["Baltimore Ravens", "Cincinnati Bengals", "Ravens"],
  ["San Francisco 49ers", "Seattle Seahawks", "49ers"],
];

async function main() {
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
    console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
    return;
  }
  const { easternDateKey } = await import("@/lib/dates");
  const { pickCategory, PICK_CATEGORY_VERSION } = await import("@/server/data/stats");
  const todayKey = easternDateKey(new Date(NOW));
  if (await logged.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey: "americanfootball_nfl", fetchDate: todayKey } } })) {
    console.log(`SKIP: a real NFL odds snapshot for ${todayKey} exists locally - not overwriting it.`);
    return;
  }

  // ---- Fixture: an NFL board, three cappers, pending picks on every game, graded history.
  const board: OddsGame[] = TEAMS.map(([home, away], i) => ({
    id: `${PREFIX}g${i}`,
    sportKey: "americanfootball_nfl",
    sport_title: "NFL",
    homeTeam: home,
    awayTeam: away,
    commenceTime: new Date(NOW + (3 + i) * H).toISOString(),
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        last_update: new Date(NOW).toISOString(),
        markets: [
          { key: "h2h", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] },
          { key: "totals", outcomes: [{ name: "Over", price: -110, point: 44.5 }, { name: "Under", price: -110, point: 44.5 }] },
        ],
      },
    ],
  })) as unknown as OddsGame[];
  const snapId = `${PREFIX}snap`;
  seeded = true;
  await logged.oddsSnapshot.create({ data: { id: snapId, sportKey: "americanfootball_nfl", fetchDate: todayKey, data: board as unknown as Prisma.InputJsonValue } });
  created.snapshots.push(snapId);

  const existingSport = await logged.sport.findUnique({ where: { name: "NFL" } });
  const sportId = existingSport?.id ?? (await logged.sport.create({ data: { name: "NFL" } })).id;
  if (!existingSport) created.sports.push(sportId);
  await logged.user.create({ data: { id: USER_ID, supabaseId: USER_ID + "-sb", email: USER_ID + "@example.invalid" } });
  const cappers = ["fav", "over", "dog"].map((c) => `${PREFIX}cap-${c}`);
  for (const id of cappers) {
    await logged.capper.create({ data: { id, userId: USER_ID, name: id, source: "OTHER" } });
    created.cappers.push(id);
  }
  const rows: Prisma.PickCreateManyInput[] = [];
  let seq = 0;
  const add = (capperId: string, home: string, away: string, gameTime: number, kind: "FAV" | "OVER" | "DOG", status: "PENDING" | "WIN" | "LOSS", nick: string) => {
    const base =
      kind === "FAV"
        ? { betType: "MONEYLINE" as const, betDetail: nick + " ML", odds: -150, line: null, pickedSide: "HOME" as const, mlFavoredSide: "HOME" as const }
        : kind === "DOG"
          ? { betType: "MONEYLINE" as const, betDetail: away.split(" ").pop() + " ML", odds: 130, line: null, pickedSide: "AWAY" as const, mlFavoredSide: "HOME" as const }
          : { betType: "TOTAL" as const, betDetail: "Over 44.5", odds: -110, line: 44.5, pickedSide: null, mlFavoredSide: null };
    const id = `${PREFIX}p-${++seq}`;
    created.picks.push(id);
    rows.push({
      id,
      userId: USER_ID,
      capperId,
      sportId,
      homeTeam: home,
      awayTeam: away,
      ...base,
      period: "FULL_GAME",
      units: 1,
      gameTime: new Date(gameTime),
      datePosted: new Date(gameTime - 2 * H),
      status,
      gradedAt: status === "PENDING" ? null : new Date(gameTime + 4 * H),
      category: pickCategory({ ...base, period: "FULL_GAME", propMarket: null, sportName: "NFL" }),
      categoryVersion: PICK_CATEGORY_VERSION,
    });
    return id;
  };
  let slipId = "";
  TEAMS.forEach(([home, away, nick], i) => {
    const t = new Date(board[i].commenceTime).getTime();
    add(cappers[0], home, away, t, "FAV", "PENDING", nick);
    add(cappers[1], home, away, t, "OVER", "PENDING", nick);
    const dog = add(cappers[2], home, away, t, "DOG", "PENDING", nick);
    if (i === 5) slipId = dog;
  });
  // History: the favorite capper 14-6 on favorite MLs, the over capper 13-7 on overs, the dog capper 6-14.
  for (let k = 0; k < 20; k++) {
    const t = NOW - (30 + k) * 86400000;
    add(cappers[0], "Hist Home", "Hist Away", t, "FAV", k < 14 ? "WIN" : "LOSS", "Home");
    add(cappers[1], "Hist Home", "Hist Away", t, "OVER", k < 13 ? "WIN" : "LOSS", "Home");
    add(cappers[2], "Hist Home", "Hist Away", t, "DOG", k < 6 ? "WIN" : "LOSS", "Home");
  }
  await logged.pick.createMany({ data: rows });

  // ---- The real action, through the real browser-side session.
  const { generateParlayAction } = await import("./parlay-generate");
  const { createGeneratorSession } = await import("@/lib/parlay/generator-session");
  let clock = NOW;
  const session = createGeneratorSession({ generate: (r) => generateParlayAction(r), now: () => new Date(clock) });
  const inputs = { leagues: ["NFL"], slipPickIds: [slipId], targets: [] as { gameId: string; leagueName: string }[] };
  const settings: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
  const bundleCalls = () => queries.filter((q) => q.includes('"cardReq"')).length;

  await drain();
  const q0 = queries.length;
  const first = await session.generate(inputs, settings);
  if ("error" in first) throw new Error(first.error);
  await drain();
  const generateReads = queries.length - q0;
  console.log(`Generate: ${generateReads} SQL statement(s), ${bundleCalls()} record bundle(s)`);
  check("Generate fetched and read the database", first.fetched && generateReads > 0, `${generateReads} statements`);
  check("Generate: exactly one record bundle", bundleCalls() === 1, `${bundleCalls()}`);
  check("Generate: a 3-leg parlay with the slip pick in it", first.parlay.legs.length === 3 && first.parlay.legs.some((l) => l.pick.pickId === slipId && l.source === "SLIP"));
  check("Generate: Hedge and Contrarian came with it", first.parlay.hedge.SUGGESTED.legs.length === 3 && first.parlay.contrarian.SUGGESTED.legs.length === 3);

  // ---- 5 Regenerates: zero reads.
  await drain();
  const afterGenerate = queries.length;
  const keys = [first.parlay.generatedKey];
  let anyFetched = false;
  for (let i = 1; i <= 5; i++) {
    const r = await session.regenerate(inputs, settings);
    if ("error" in r) throw new Error(r.error);
    anyFetched ||= r.fetched;
    keys.push(r.parlay.generatedKey);
    check(`Regenerate ${i}: slip pick still in, Hedge/Contrarian present`, r.parlay.legs.some((l) => l.pick.pickId === slipId) && r.parlay.hedge.SUGGESTED.legs.length === r.parlay.legs.length);
  }
  await drain();
  const regenerateReads = queries.length - afterGenerate;
  console.log(`5 Regenerates: ${regenerateReads} SQL statement(s)`);
  check("5 consecutive Regenerates after one Generate: ZERO additional DB reads", regenerateReads === 0 && !anyFetched, `${regenerateReads} statements`);
  check("...and they did vary (more than one distinct parlay)", new Set(keys).size > 1, keys.join(" / "));
  check("the session made exactly one request", session.requestCount() === 1, `${session.requestCount()}`);

  // ---- Settings that don't change the pool: zero reads.
  await drain();
  const beforeSettings = queries.length;
  for (const s of [{ legCount: 4 }, { maxLegsPerGame: 2, legCount: 6 }, { include: ["MONEYLINE", "SPREAD", "TOTALS"] as GeneratorSettings["include"] }, { mix: { MONEYLINE: 50, PROPS: 50 } }]) {
    const r = await session.generate(inputs, { ...settings, ...s });
    if ("error" in r) throw new Error(r.error);
    check(`settings ${JSON.stringify(s)}: rebuilt without a request`, !r.fetched);
  }
  await drain();
  check("settings changes: ZERO DB reads", queries.length === beforeSettings, `${queries.length - beforeSettings} statements`);

  // ---- The pool changes: one reload.
  await drain();
  const beforePool = queries.length;
  const changed = await session.generate({ ...inputs, slipPickIds: [] }, settings);
  await drain();
  const noError = !("error" in changed);
  const fetchedAgain = !("error" in changed) && changed.fetched;
  const queriesGrew = queries.length > beforePool;
  const secondBundle = bundleCalls() === 2;
  check(
    "slip pick removed: reloaded",
    noError && fetchedAgain && queriesGrew && secondBundle,
    `noError=${noError} fetched=${fetchedAgain} queriesGrew=${queriesGrew} bundleCalls=${bundleCalls()}`
  );

  // ---- Stale: older than ~2 minutes reloads before drawing.
  clock = NOW + 3 * 60 * 1000;
  await drain();
  const beforeStale = queries.length;
  const stale = await session.regenerate({ ...inputs, slipPickIds: [] }, settings);
  await drain();
  check("snapshot older than 2 minutes: Regenerate reloads first", !("error" in stale) && stale.fetched && queries.length > beforeStale);
}

let seeded = false;

async function cleanup() {
  if (!seeded) return;
  // Exact ids only; the user cascades to its cappers and picks.
  await logged.pick.deleteMany({ where: { id: { in: created.picks } } });
  await logged.capper.deleteMany({ where: { id: { in: created.cappers } } });
  await logged.user.deleteMany({ where: { id: USER_ID } });
  await logged.oddsSnapshot.deleteMany({ where: { id: { in: created.snapshots } } });
  if (created.sports.length > 0) await logged.sport.deleteMany({ where: { id: { in: created.sports } } });
  const left = await logged.pick.count({ where: { userId: USER_ID } });
  console.log(`cleanup: fixture picks left: ${left}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await logged.$disconnect();
    console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
    process.exit(failures > 0 ? 1 : 0);
  });
