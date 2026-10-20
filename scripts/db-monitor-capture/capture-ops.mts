// Local-only statement capture for the ops-console DB Monitor labels (PR A).
// Run from the worktree root:
//   WT=<worktree> OUT=<json> node --env-file=.env --env-file=.env.local --require <s>/server-only-stub.cjs --require <s>/react-cache-shim.cjs --import tsx <this>
// Every write the app code issues runs inside a transaction that is rolled
// back, so the statement is logged but nothing persists. Seeded picks/snapshot
// are deleted by id at the end.
import { writeFileSync } from "node:fs";

const WT_DIR = process.env.WT!;
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
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
class Rollback extends Error {}

const base = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
base.$on("query", (e: { query: string }) => {
  if (label === "setup" || label === "cleanup") return;
  if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(e.query.trim())) return;
  stmts.push({ label, sql: e.query });
});
const delegate = (model: string) => model[0].toLowerCase() + model.slice(1);
const client = base.$extends({
  query: {
    async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
      if (label !== "setup" && label !== "cleanup" && model && WRITE_OPS.has(operation)) {
        try {
          await base.$transaction(async (tx: any) => {
            await tx[delegate(model)][operation](args);
            throw new Rollback();
          });
        } catch (err) {
          if (!(err instanceof Rollback)) throw err;
        }
        return operation.endsWith("Many") ? { count: 0 } : {};
      }
      return query(args);
    },
  },
});
(globalThis as unknown as { prisma: unknown }).prisma = client;

const PREFIX = "opsmon-";

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
    homeTeam: "Opm Home" + i + " Hawks",
    awayTeam: "Opm Away" + i + " Owls",
    commenceTime: new Date(now - i * H),
  }));
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
      gameTime: g.commenceTime,
      status: "PENDING" as const,
      pickedSide: oi % 2 === 0 ? ("HOME" as const) : ("AWAY" as const),
      category: oi % 2 === 0 ? "FAV_ML" : "DOG_ML",
      categoryVersion: 2,
    }))
  );
  await db.pick.createMany({ data: pickRows });
  const pickIds = pickRows.map((p) => p.id);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    label = name;
    try {
      await fn();
    } catch (err) {
      console.log("[" + name + "] threw: " + (err instanceof Error ? err.message.split("\n")[0] : String(err)));
    } finally {
      label = "between";
    }
  };

  try {
    const auth = await import(WT + "/server/auth.ts");
    const cappersData = await import(WT + "/server/data/cappers.ts");
    const picks = await import(WT + "/server/data/picks.ts");
    const summary = await import(WT + "/server/data/picks-summary.ts");
    const glance = await import(WT + "/server/data/picks-glance.ts");
    const grading = await import(WT + "/server/data/grading.ts");
    const legs = await import(WT + "/server/data/parlay-grading.ts");
    const tend = await import(WT + "/server/data/team-tendencies.ts");
    const decay = await import(WT + "/server/data/model-engine/decay-delta-predictions.ts");
    const record = await import(WT + "/server/data/team-record.ts");
    const situ = await import(WT + "/server/data/situational-snapshots.ts");
    const resolver = await import(WT + "/server/data/model-engine/resolver.ts");
    const zone = await import(WT + "/server/data/zone-model.ts");
    const today = easternDateKey(new Date());

    await run("session user: getCurrentUser", () => auth.getCurrentUser());
    await run("capper roster: getCappersForUser", () => cappersData.getCappersForUser(user.id));
    await run("capper include: getPendingPicksForUser", () => picks.getPendingPicksForUser(user.id));
    await run("capper include: getPicksForGames", () => picks.getPicksForGames(user.id, "NFL", games));
    await run("cappers with pick counts: getCappersWithPickCounts", () => cappersData.getCappersWithPickCounts(user.id));
    await run("capper all-time W-L: getCapperAllTimeRecords", () => summary.getCapperAllTimeRecords(user.id, cappers.map((c: { id: string }) => c.id)));
    await run("/picks final scores: getFinalScoresForPicks", () =>
      summary.getFinalScoresForPicks(
        [
          { id: "a", sportName: "NFL", status: "WIN", gameTime: new Date(now - 30 * H), homeTeam: "A", awayTeam: "B", betDetail: null, gameNumber: null },
          { id: "b", sportName: "MLB", status: "LOSS", gameTime: new Date(now - 30 * H), homeTeam: "C", awayTeam: "D", betDetail: null, gameNumber: null },
        ],
        new Date()
      )
    );
    await run("day consensus: getDayConsensus", () => glance.getDayConsensus(user.id, today, today));
    await run("grading cron: gradeAllPendingPicks NFL", () => grading.gradeAllPendingPicks("americanfootball_nfl", "NFL"));
    await run("grading cron: gradeAllPendingLegs NFL", () => legs.gradeAllPendingLegs("americanfootball_nfl", "NFL"));
    await run("final-score state: fetchExistingResultState", () => grading.fetchExistingResultState("baseball_mlb", ["x1", "x2"]));
    await run("refresh-scores: recomputeTeamTendencies MLB", () => tend.recomputeTeamTendencies("baseball_mlb"));
    await run("refresh-scores: snapshotTeamTendencies MLB", () => tend.snapshotTeamTendencies("baseball_mlb"));
    await run("refresh-scores: syncDecayDeltaPredictions MLB", () => decay.syncDecayDeltaPredictions("baseball_mlb"));
    await run("refresh-scores: captureTeamRecordSnapshots NFL", () => record.captureTeamRecordSnapshots("americanfootball_nfl"));
    await run("refresh-scores: captureSituationalRateSnapshots", () => situ.captureSituationalRateSnapshots());
    await run("tendency history: resolveVariable", () =>
      resolver.resolveVariable("tendency_fav_win_pct", { type: "team", teamName: "New York Yankees" }, new Date(), { sportKey: "baseball_mlb" })
    );
    await run("control: zone model", () => zone.computeZoneModel("baseball_mlb"));
  } finally {
    label = "cleanup";
    const del = await db.pick.deleteMany({ where: { id: { in: pickIds }, userId: user.id } });
    console.log("cleanup: deleted " + del.count + " seeded picks");
  }

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
