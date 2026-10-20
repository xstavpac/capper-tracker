// Local-only statement capture for the DB Monitor fixtures.
// Run from the target worktree root (WT env = that worktree, OUT env = json path, MODE = current|pre128):
//   node --env-file=.env --require <scratch>/server-only-stub.cjs --require <scratch>/react-cache-shim.cjs --import tsx <this file>
// Installs a logging PrismaClient as globalThis.prisma BEFORE any app module loads, so
// src/lib/prisma.ts reuses it. Seeds prefixed rows under the dev-bypass user, runs each
// entry point, then deletes the seeded rows by id. Network is stubbed out; writes are
// refused during the grading entry points (they scan every user's local picks).
import { writeFileSync } from "node:fs";

const WT_DIR = process.env.WT!;
const MODE = process.env.MODE ?? "current";
const OUT = process.env.OUT!;
const WT = "file:///" + WT_DIR.replace(/\\/g, "/") + "/src";

for (const k of ["DATABASE_URL", "DIRECT_URL"]) {
  const h = new URL(process.env[k] ?? "postgres://unset").hostname;
  console.log("guard: " + k + " host = " + h);
  if (!["localhost", "127.0.0.1"].includes(h)) {
    console.error("ABORT: " + k + " host is " + h);
    process.exit(1);
  }
}
delete process.env.ODDS_API_KEY;
globalThis.fetch = (async () => {
  throw new Error("network disabled in capture harness");
}) as typeof fetch;

const { PrismaClient } = await import("file:///" + WT_DIR.replace(/\\/g, "/") + "/node_modules/@prisma/client/index.js");

type Stmt = { label: string; sql: string };
const stmts: Stmt[] = [];
let label = "setup";
let blockWrites = false;
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "$executeRaw", "$executeRawUnsafe"]);

const base = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
base.$on("query", (e: { query: string }) => {
  if (label !== "setup" && label !== "cleanup") stmts.push({ label, sql: e.query });
});
const client = base.$extends({
  query: {
    async $allOperations({ operation, args, query }: { operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
      if (blockWrites && WRITE_OPS.has(operation)) throw new Error("write refused in capture harness: " + operation);
      return query(args);
    },
  },
});
(globalThis as unknown as { prisma: unknown }).prisma = client;

const PREFIX = "dbmon-";

async function main() {
  const db = client as any;
  const { getCurrentUser } = await import(WT + "/server/auth.ts");
  const user = await getCurrentUser();
  if (!user) throw new Error("dev bypass user not resolved");
  const nfl = await db.sport.findFirstOrThrow({ where: { name: "NFL" } });
  const cappers = await db.capper.findMany({ where: { userId: user.id }, take: 3, orderBy: { name: "asc" } });
  if (cappers.length < 2) throw new Error("need 2+ cappers for the dev user");

  const { easternDateKey } = await import(WT + "/lib/dates.ts");
  const now = Date.now();
  const H = 3600000;
  const games = [1, 2].map((i) => ({
    id: PREFIX + "game-" + i,
    sportKey: "americanfootball_nfl",
    homeTeam: "Dbm Home" + i + " Hawks",
    awayTeam: "Dbm Away" + i + " Owls",
    commenceTime: new Date(now + i * H).toISOString(),
    bookmakers: [],
  }));
  const fetchDate = easternDateKey(new Date());
  const existingSnap = await db.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey: "americanfootball_nfl", fetchDate } } });
  if (existingSnap) throw new Error("an NFL snapshot for " + fetchDate + " already exists locally - refusing to touch it");
  const snap = await db.oddsSnapshot.create({ data: { id: PREFIX + "snap", sportKey: "americanfootball_nfl", fetchDate, data: games } });

  const pickRows = games.flatMap((g, gi) =>
    [0, 1].map((oi) => ({
      id: PREFIX + "pick-" + gi + "-" + oi,
      userId: user.id,
      capperId: cappers[(gi + oi) % cappers.length].id,
      sportId: nfl.id,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      betType: "MONEYLINE" as const,
      betDetail: oi % 2 === 0 ? g.homeTeam : g.awayTeam,
      odds: oi % 2 === 0 ? -150 : 130,
      units: 1,
      gameTime: new Date(g.commenceTime),
      status: "PENDING" as const,
      pickedSide: oi % 2 === 0 ? ("HOME" as const) : ("AWAY" as const),
      category: oi % 2 === 0 ? "FAV_ML" : "DOG_ML",
      categoryVersion: 2,
    }))
  );
  await db.pick.createMany({ data: pickRows });
  const pickIds = pickRows.map((p) => p.id);

  const run = async (name: string, fn: () => Promise<unknown>, opts: { readOnly?: boolean } = {}) => {
    label = name;
    blockWrites = !!opts.readOnly;
    try {
      await fn();
    } catch (err) {
      console.log("[" + name + "] threw: " + (err instanceof Error ? err.message.split("\n")[0] : String(err)));
    } finally {
      blockWrites = false;
    }
  };

  try {
    if (MODE === "board") {
      const { getPicksForGame } = await import(WT + "/server/data/picks.ts");
      await run("board window (#277): getPicksForGame", () =>
        getPicksForGame(user.id, { sportName: "NFL", homeTeam: games[0].homeTeam, awayTeam: games[0].awayTeam, commenceTime: new Date(games[0].commenceTime) })
      );
    } else if (MODE === "pre128") {
      const { getCapperLeagueRecords } = await import(WT + "/server/data/picks.ts");
      const { getSportCategoryPanelData } = await import(WT + "/server/data/cappers.ts");
      const { getDashboardSummary } = await import(WT + "/server/data/stats.ts");
      await run("retired A: fetchPicksByCapper (getCapperLeagueRecords)", () =>
        getCapperLeagueRecords(user.id, cappers.map((c: { id: string }) => ({ capperId: c.id, leagueSport: "NFL", category: null })))
      );
      await run("retired B: raw getSportCategoryPanelData (MLB)", () => getSportCategoryPanelData(user.id, "MLB"));
      await run("retired C: getPickRowsForStats (getDashboardSummary)", () => getDashboardSummary(user.id));
    } else {
      const { getLiveBoardData } = await import(WT + "/server/data/live-board-picks.ts");
      const { getSportCategoryPanelData } = await import(WT + "/server/data/pick-aggregates-cappers-adapter.ts");
      const { getPicksForGame, getCapperLeagueRecords, getFilteredPicksForUser, getPendingPicksForUser } = await import(WT + "/server/data/picks.ts");
      const { getSlipPickStatesAction } = await import(WT + "/server/actions/parlay-slip.ts");
      const { getCapperComparisonAction } = await import(WT + "/server/actions/capper-comparison.ts");
      const { getCappersPageData } = await import(WT + "/server/data/cappers-page-aggregates.ts");
      const { getCapperPageData } = await import(WT + "/server/data/capper-detail.ts");
      const { getDashboardSummary } = await import(WT + "/server/data/dashboard-summary.ts");
      const { gradeAllPendingPicks, regradeAllFuzzyMatchedPicks } = await import(WT + "/server/data/grading.ts");

      await run("board window: getLiveBoardData NFL", () => getLiveBoardData(user.id, "americanfootball_nfl", "NFL"));
      await run("board window: getPicksForGame", () =>
        getPicksForGame(user.id, { sportName: "NFL", homeTeam: games[0].homeTeam, awayTeam: games[0].awayTeam, commenceTime: new Date(games[0].commenceTime) })
      );
      await run("category panel: getSportCategoryPanelData MLB", () => getSportCategoryPanelData(user.id, "MLB"));
      await run("record bundle: getCapperLeagueRecords", () =>
        getCapperLeagueRecords(user.id, cappers.map((c: { id: string }) => ({ capperId: c.id, leagueSport: "NFL", category: null })))
      );
      await run("slip id IN: getSlipPickStatesAction", () => getSlipPickStatesAction([pickIds[0], pickIds[2]]));
      await run("capper comparison: getCapperComparisonAction", () =>
        getCapperComparisonAction(cappers[0].id, cappers[1].id, { sportId: null, betType: null, favDog: null, dayOfWeek: null, month: null, streak: null, dateRange: null, betCount: 0 })
      );
      const today = easternDateKey(new Date());
      await run("/picks: getFilteredPicksForUser today", () => getFilteredPicksForUser(user.id, { startDateKey: today, endDateKey: today }));
      await run("/picks: getPendingPicksForUser", () => getPendingPicksForUser(user.id));
      await run("grading pending: gradeAllPendingPicks NFL", () => gradeAllPendingPicks("americanfootball_nfl", "NFL"), { readOnly: true });
      await run("fuzzy grading: regradeAllFuzzyMatchedPicks NFL", () => regradeAllFuzzyMatchedPicks("americanfootball_nfl", "NFL"), { readOnly: true });
      // Negative controls: real statements that should stay Unlabeled and unflagged.
      await run("control: /cappers page", () => getCappersPageData({ userId: user.id, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 }));
      await run("control: /cappers/[id] page", () => getCapperPageData(user.id, cappers[0].id, { window: "ALL", recentLimit: 20 }));
      await run("control: /dashboard summary", () => getDashboardSummary(user.id));
    }
  } finally {
    label = "cleanup";
    const del = await db.pick.deleteMany({ where: { id: { in: pickIds }, userId: user.id } });
    await db.oddsSnapshot.delete({ where: { id: snap.id } });
    console.log("cleanup: deleted " + del.count + " seeded picks and the seeded snapshot");
  }

  // One entry per distinct statement text per label.
  const seen = new Set<string>();
  const out = stmts.filter((s) => {
    const k = s.label + "\0" + s.sql;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const byLabel = new Map<string, number>();
  for (const s of out) byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + 1);
  for (const [l, n] of byLabel) console.log(n.toString().padStart(3) + "  " + l);
  console.log("wrote " + out.length + " statements to " + OUT);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => base.$disconnect());
