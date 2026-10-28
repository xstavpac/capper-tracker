// Statement count for the Parlay Generator's per-market prop records: a Generate
// on a slate with player props still sends exactly ONE record bundle - the prop
// records ride in that same statement (its propRec CTE), never a second fetch -
// and only the slate's own (capper, propMarket) pairs are asked for. The records
// come back right: in-league NFL, all-time across football (NCAAF counts), a
// legacy prop with no propMarket counts toward neither, and a result from a game
// at or after the Generate (asOf = now) is left out. Regenerates read nothing.
//
// Same query-logging harness as parlay-generate-zero-reads-acceptance-test.ts: a
// PrismaClient with query-event logging installed as the app's client before any
// app module loads, drained with drainQueryLog before every count; only
// requireUser is stubbed. Prints every Generate statement's opening so a
// before/after run can be compared line by line.
//
// DB-backed and WRITING: ids prefixed `__GenProp__`, deleted by exact id.
// Refuses to run unless DATABASE_URL is local; skips if a real NFL odds snapshot
// for today exists locally (never overwritten).
//   node --env-file=.env --require ./scripts/server-only-stub.cjs --import tsx src/server/actions/parlay-generate-prop-records-statements-acceptance-test.ts
import { PrismaClient, type Prisma } from "@prisma/client";
import type { OddsGame } from "@/server/data/odds";
import type { GeneratorSettings } from "@/lib/parlay/generator";
import type { GenerateResponse } from "./parlay-generate";
import { drainQueryLog } from "@/server/data/query-log-drain";

const queries: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => queries.push(e.query));
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;
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

const PREFIX = "__GenProp__";
const USER_ID = PREFIX + "user";
const H = 3600000;
const D = 86400000;
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

  // ---- Fixture: an NFL board; a moneyline capper, a TD-prop capper and a passing-yards capper.
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
        markets: [{ key: "h2h", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] }],
      },
    ],
  })) as unknown as OddsGame[];
  const snapId = `${PREFIX}snap`;
  seeded = true;
  await logged.oddsSnapshot.create({ data: { id: snapId, sportKey: "americanfootball_nfl", fetchDate: todayKey, data: board as unknown as Prisma.InputJsonValue } });
  created.snapshots.push(snapId);

  const sportId = async (name: string) => {
    const existing = await logged.sport.findUnique({ where: { name } });
    if (existing) return existing.id;
    const id = (await logged.sport.create({ data: { name } })).id;
    created.sports.push(id);
    return id;
  };
  const nfl = await sportId("NFL");
  const ncaaf = await sportId("NCAAF");
  await logged.user.create({ data: { id: USER_ID, supabaseId: USER_ID + "-sb", email: USER_ID + "@example.invalid" } });
  const [favCapper, tdCapper, ydsCapper] = ["fav", "td", "yds"].map((c) => `${PREFIX}cap-${c}`);
  for (const id of [favCapper, tdCapper, ydsCapper]) {
    await logged.capper.create({ data: { id, userId: USER_ID, name: id, source: "OTHER" } });
    created.cappers.push(id);
  }

  type Kind = "FAV" | "TD" | "YDS" | "TD_LEGACY";
  const rows: Prisma.PickCreateManyInput[] = [];
  let seq = 0;
  const add = (capperId: string, sport: { id: string; name: string }, home: string, away: string, gameTime: number, kind: Kind, status: "PENDING" | "WIN" | "LOSS", nick: string) => {
    const base =
      kind === "FAV"
        ? { betType: "MONEYLINE" as const, betDetail: nick + " ML", odds: -150, line: null, pickedSide: "HOME" as const, mlFavoredSide: "HOME" as const, propMarket: null, playerName: null }
        : kind === "YDS"
          ? { betType: "PLAYER_PROP" as const, betDetail: "Patrick Mahomes Over 250.5 Passing Yards", odds: -110, line: null, pickedSide: null, mlFavoredSide: null, propMarket: "PASS_YDS" as const, playerName: "Patrick Mahomes" }
          : { betType: "PLAYER_PROP" as const, betDetail: "Travis Kelce Anytime TD", odds: 120, line: null, pickedSide: null, mlFavoredSide: null, propMarket: kind === "TD" ? ("TD" as const) : null, playerName: kind === "TD" ? "Travis Kelce" : null };
    const id = `${PREFIX}p-${++seq}`;
    created.picks.push(id);
    rows.push({
      id,
      userId: USER_ID,
      capperId,
      sportId: sport.id,
      homeTeam: home,
      awayTeam: away,
      ...base,
      period: "FULL_GAME",
      units: 1,
      gameTime: new Date(gameTime),
      datePosted: new Date(gameTime - 2 * H),
      status,
      gradedAt: status === "PENDING" ? null : new Date(gameTime + 4 * H),
      category: pickCategory({ ...base, period: "FULL_GAME", sportName: sport.name }),
      categoryVersion: PICK_CATEGORY_VERSION,
    });
    return id;
  };
  const NFL = { id: nfl, name: "NFL" };
  const NCAAF = { id: ncaaf, name: "NCAAF" };
  TEAMS.forEach(([home, away, nick], i) => {
    const t = new Date(board[i].commenceTime).getTime();
    add(favCapper, NFL, home, away, t, "FAV", "PENDING", nick);
    add(tdCapper, NFL, home, away, t, "TD", "PENDING", nick);
    add(ydsCapper, NFL, home, away, t, "YDS", "PENDING", nick);
  });
  // History. fav: 14-6 favorite MLs. td: NFL TD props 7-3, NCAAF TD props 3-1 (football:
  // all-time only), legacy no-propMarket TD props 0-5 (counted by neither), and one WIN
  // on a game AFTER now (left out by asOf). yds: NFL passing yards 6-4.
  for (let k = 0; k < 20; k++) add(favCapper, NFL, "Hist Home", "Hist Away", NOW - (30 + k) * D, "FAV", k < 14 ? "WIN" : "LOSS", "Home");
  for (let k = 0; k < 10; k++) add(tdCapper, NFL, "Hist Home", "Hist Away", NOW - (30 + k) * D, "TD", k < 7 ? "WIN" : "LOSS", "Home");
  for (let k = 0; k < 4; k++) add(tdCapper, NCAAF, "College Home", "College Away", NOW - (40 + k) * D, "TD", k < 3 ? "WIN" : "LOSS", "Home");
  for (let k = 0; k < 5; k++) add(tdCapper, NFL, "Old Home", "Old Away", NOW - (60 + k) * D, "TD_LEGACY", "LOSS", "Home");
  add(tdCapper, NFL, "Later Home", "Later Away", NOW + 2 * D, "TD", "WIN", "Home");
  for (let k = 0; k < 10; k++) add(ydsCapper, NFL, "Hist Home", "Hist Away", NOW - (30 + k) * D, "YDS", k < 6 ? "WIN" : "LOSS", "Home");
  await logged.pick.createMany({ data: rows });

  // ---- The real action, through the real browser-side session.
  const { generateParlayAction } = await import("./parlay-generate");
  const { createGeneratorSession } = await import("@/lib/parlay/generator-session");
  const { propMarketRecordKey } = await import("@/lib/record-keys");
  // The action's own response, kept to read the snapshot it sent the browser.
  const captured: { response: GenerateResponse | null } = { response: null };
  const session = createGeneratorSession({
    generate: async (r) => {
      const res = await generateParlayAction(r);
      if (!("error" in res)) captured.response = res;
      return res;
    },
    now: () => new Date(NOW),
  });
  const inputs = { leagues: ["NFL"], slipPickIds: [] as string[], targets: [] as { gameId: string; leagueName: string }[] };
  // Two legs a game, so each game's second leg is a prop: TD (7-3 / 10-4) over passing yards (6-4).
  const settings: GeneratorSettings = { legCount: 8, maxLegsPerGame: 2, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };

  await drain();
  const q0 = queries.length;
  const first = await session.generate(inputs, settings);
  if ("error" in first) throw new Error(first.error);
  await drain();
  const statements = queries.slice(q0);
  console.log(`Generate: ${statements.length} SQL statement(s):`);
  statements.forEach((s, i) => console.log(`  ${i + 1}. ${s.replace(/\s+/g, " ").slice(0, 110)}`));
  const bundles = statements.filter((q) => q.includes('"cardReq"'));
  check("Generate: exactly one record bundle", bundles.length === 1, `${bundles.length}`);
  check("Generate: no other statement asks for prop records", statements.filter((q) => q.includes('"propReq"') || q.includes('"propRec"')).length === 1);
  const propReq = bundles[0]?.match(/"propReq"\(cid, mkt\) AS \((.*?)\),\s*"propRec"/s)?.[1] ?? "";
  check("the bundle asks for the slate's prop pairs: (td capper, TD) and (yds capper, PASS_YDS) - 2 rows", (propReq.match(/::text, \$\d+::text\)/g) ?? []).length === 2, propReq.replace(/\s+/g, " "));

  if (!captured.response) throw new Error("no Generate response");
  const { snapshot } = captured.response;
  const recs = snapshot.propMarketRecords ?? {};
  const td = recs[propMarketRecordKey(tdCapper, "NFL", "FOOTBALL:TD")];
  const yds = recs[propMarketRecordKey(ydsCapper, "NFL", "FOOTBALL:PASS_YDS")];
  const wl = (c: { wins: number; losses: number } | undefined) => (c ? `${c.wins}-${c.losses}` : "none");
  check("TD in-league (NFL): 7-3 - legacy no-propMarket picks and the future WIN left out", wl(td?.league) === "7-3", wl(td?.league));
  check("TD all-time (football): 10-4 - NCAAF counts", wl(td?.allTime) === "10-4", wl(td?.allTime));
  check("passing yards: 6-4 in-league and all-time", wl(yds?.league) === "6-4" && wl(yds?.allTime) === "6-4", `${wl(yds?.league)} / ${wl(yds?.allTime)}`);
  check("only the slate's entries: 2 records", Object.keys(recs).length === 2, Object.keys(recs).join(", "));
  const tdCard = snapshot.leagueRecords.records[`${tdCapper}|NFL|TD_PROP`];
  // 7-3 NFL + 3-1 NCAAF + 0-5 legacy + the future WIN: 11-9.
  check("the TD_PROP card itself is unchanged: every decided TD_PROP pick, as before (11-9)", wl(tdCard?.overall) === "11-9", wl(tdCard?.overall));
  const tdLegs = first.parlay.legs.filter((l) => l.pick.capperId === tdCapper);
  // Best of two at z = 1.5: all-time 10-4 (Wilson ~0.514) beats in-league 7-3 (~0.463).
  check(
    "TD legs are gated on their per-market record: all-time football 10-4",
    tdLegs.length > 0 && tdLegs.every((l) => l.propMarket === "FOOTBALL:TD" && l.basis === "OVERALL" && wl(l.record ?? undefined) === "10-4"),
    tdLegs.map((l) => `${l.basis} ${wl(l.record ?? undefined)} ${l.propMarket}`).join("; ") || "no TD leg"
  );

  // ---- Regenerates: zero reads.
  await drain();
  const afterGenerate = queries.length;
  for (let i = 0; i < 3; i++) {
    const r = await session.regenerate(inputs, settings);
    if ("error" in r) throw new Error(r.error);
  }
  await drain();
  check("3 Regenerates: ZERO additional DB reads", queries.length === afterGenerate, `${queries.length - afterGenerate} statements`);
}

let seeded = false;

async function cleanup() {
  if (!seeded) return;
  // Exact ids only.
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
