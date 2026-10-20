// One-off repair for the 2026 ALCS rainout (gamePk 849817) and the same
// stale-gameDate bug on 824785. Background: docs/design/postponed-games-followups.md
// ("Repair needed") and PR #306.
//
//   DATABASE_URL="<target db>" npx tsx scripts/repair-849817-postponed-slot.ts           # DRY RUN (default)
//   DATABASE_URL="<target db>" npx tsx scripts/repair-849817-postponed-slot.ts --apply   # actually writes
//
// What it does:
//   1. GameResult gameDate -> the makeup's real start, for 849817 and 824785.
//      Both targets are re-read from MLB StatsAPI at run time, and the run
//      aborts if StatsAPI disagrees with the constants below.
//   2. Voids (status CANCELLED, the app's void: excluded from record and
//      units like PENDING) every graded MLB pick in 849817's original slot
//      (TB/CLE, gameTime within 6h of 2026-10-17 00:00 UTC). That is the 22
//      graded off the phantom 0-0 plus the 3 F5 picks graded after the makeup.
//      Aborts unless exactly EXPECTED_SLOT_PICKS match, and if any graded
//      parlay leg sits in that slot.
//   2b. Shows each affected capper's record before -> after with the app's own
//      computeStats (W-L-P, units, ROI, streaks), plus the same totals through
//      the SQL filters the /cappers, capper-panels and Savant aggregates use,
//      and asserts the voided picks drop out of every one.
//   3. Never touches the 6 picks posted for the makeup (PENDING, 10/18
//      21:08). It replays the cron's own matchGameResult + resolveOutcome
//      against the post-repair rows and prints what the next grading run
//      should give each one.
//
// Writes are by id only, each guarded by the row's current value (gameDate /
// status as read), all in one transaction: any mismatch rolls everything
// back. The dry run's reads run in a SET TRANSACTION READ ONLY transaction,
// so Postgres itself guarantees it writes nothing.
//
// Recompute: records, units and capper panels are computed from picks on
// read. The only caches are the per-user dashboard / capper-panels entries
// (DASHBOARD_REPORTS_CACHE_TTL_SECONDS = 60), which this script can't
// revalidateTag from outside Next. They catch up within that TTL, the same
// as after a cron grade on any other user's page that isn't revalidated.
// gradedAt is left as-is: a correction, not a new grading event (same rule
// as regradeFuzzyPool).
import { Prisma, type PickStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { matchGameResult, resolveOutcome } from "@/server/data/grading";
import { computeStats, type OverallStats, type SeriesPick } from "@/server/data/stats";

const apply = process.argv.includes("--apply");
const unknownArg = process.argv.slice(2).find((a) => a !== "--apply");
if (unknownArg) {
  console.error(`unknown argument: ${unknownArg}`);
  process.exit(2);
}

const MLB = "baseball_mlb";
const TB = "Tampa Bay Rays";
const CLE = "Cleveland Guardians";
const HOUR = 3600000;
const DRIFT = 6 * HOUR;
const VOID_STATUS: PickStatus = "CANCELLED";

// gameDate targets: each makeup's start per StatsAPI (checked live 2026-10-20).
const GAME_DATE_FIXES = [
  { externalId: "849817", label: "TB @ CLE (ALCS, postponed 10/17 00:00)", to: "2026-10-18T21:08:00.000Z" },
  { externalId: "824785", label: "TOR @ BAL (postponed 9/22 22:35)", to: "2026-09-23T17:35:00.000Z" },
];
const ORIGINAL_SLOT = new Date("2026-10-17T00:00:00Z");
const MAKEUP_START = new Date("2026-10-18T21:08:00Z");
const EXPECTED_SLOT_PICKS = 25;
const EXPECTED_STUCK_PICKS = 6;

const fmt = (d: Date) => d.toISOString().replace(".000Z", "Z");
const tbCle = { OR: [{ homeTeam: CLE, awayTeam: TB }, { homeTeam: TB, awayTeam: CLE }] };

class Abort extends Error {}

// The makeup's final entry for a gamePk, straight from StatsAPI.
async function statsApiMakeup(gamePk: string): Promise<{ gameDate: string; home: string; away: string }> {
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?gamePk=${gamePk}`);
  if (!res.ok) throw new Abort(`StatsAPI ${gamePk}: HTTP ${res.status}`);
  const data = (await res.json()) as {
    dates?: { games?: { gameDate: string; status: { codedGameState?: string }; teams: { home: { team: { name: string } }; away: { team: { name: string } } } }[] }[];
  };
  const finals = (data.dates ?? []).flatMap((d) => d.games ?? []).filter((g) => g.status.codedGameState === "F");
  if (finals.length !== 1) throw new Abort(`StatsAPI ${gamePk}: expected exactly 1 final entry, got ${finals.length}`);
  const g = finals[0];
  return { gameDate: new Date(g.gameDate).toISOString(), home: g.teams.home.team.name, away: g.teams.away.team.name };
}

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[repair] db=${dbHost}`);
  console.log(`[repair] mode=${apply ? "APPLY (writes)" : "DRY RUN (read-only transaction, writes nothing)"}\n`);

  // StatsAPI first, outside any transaction.
  const makeups = new Map<string, Awaited<ReturnType<typeof statsApiMakeup>>>();
  for (const fix of GAME_DATE_FIXES) {
    const m = await statsApiMakeup(fix.externalId);
    if (m.gameDate !== fix.to) throw new Abort(`StatsAPI ${fix.externalId} makeup starts ${m.gameDate}, script expects ${fix.to}`);
    makeups.set(fix.externalId, m);
  }

  await prisma.$transaction(
    async (tx) => {
      if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;

      // ---- 1. GameResult gameDate ----
      console.log("== 1. GameResult gameDate");
      const rows = [];
      for (const fix of GAME_DATE_FIXES) {
        const row = await tx.gameResult.findUnique({
          where: { sportKey_externalId: { sportKey: MLB, externalId: fix.externalId } },
          select: { id: true, externalId: true, homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
        });
        if (!row) throw new Abort(`GameResult ${fix.externalId} not found`);
        const m = makeups.get(fix.externalId)!;
        if (row.homeTeam !== m.home || row.awayTeam !== m.away) {
          throw new Abort(`GameResult ${fix.externalId} teams ${row.awayTeam} @ ${row.homeTeam} differ from StatsAPI ${m.away} @ ${m.home}`);
        }
        const change = row.gameDate.toISOString() === fix.to ? "already correct, no change" : `${fmt(row.gameDate)} -> ${fmt(new Date(fix.to))}`;
        console.log(`  ${row.externalId} ${fix.label}  score ${row.awayScore}-${row.homeScore} (away-home)  gameDate ${change}`);
        rows.push({ row, fix });
      }

      // ---- 2. Void the original-slot picks ----
      console.log(`\n== 2. Graded picks in 849817's original slot (${fmt(ORIGINAL_SLOT)} +-6h) -> ${VOID_STATUS}`);
      const slotWhere = {
        sport: { name: "MLB" },
        gameTime: { gte: new Date(ORIGINAL_SLOT.getTime() - DRIFT), lte: new Date(ORIGINAL_SLOT.getTime() + DRIFT) },
        ...tbCle,
      };
      const slotPicks = await tx.pick.findMany({
        where: { ...slotWhere, status: { in: ["WIN", "LOSS", "PUSH"] } },
        select: { id: true, userId: true, capperId: true, betType: true, period: true, betDetail: true, status: true, gameTime: true, gradedAt: true },
        orderBy: [{ gradedAt: "asc" }, { id: "asc" }],
      });
      for (const p of slotPicks) {
        console.log(
          `  ${p.id}  ${p.betType}${p.period === "FULL_GAME" ? "" : " " + p.period}  "${p.betDetail ?? ""}"  ${p.status} -> ${VOID_STATUS}  (graded ${p.gradedAt ? fmt(p.gradedAt) : "-"})`
        );
      }
      const otherInSlot = await tx.pick.count({ where: { ...slotWhere, status: { notIn: ["WIN", "LOSS", "PUSH"] } } });
      console.log(`  ${slotPicks.length} graded picks, ${new Set(slotPicks.map((p) => p.userId)).size} users; ${otherInSlot} other picks in the slot (left alone)`);
      if (slotPicks.length !== EXPECTED_SLOT_PICKS) throw new Abort(`expected ${EXPECTED_SLOT_PICKS} graded slot picks, found ${slotPicks.length}`);
      const slotLegs = await tx.leg.count({
        where: { ...slotWhere, status: { in: ["WIN", "LOSS", "PUSH"] } },
      });
      if (slotLegs > 0) throw new Abort(`${slotLegs} graded parlay legs in the slot - not covered by this script`);

      // ---- 2b. Affected cappers: record before -> after ----
      console.log(`
== 2b. Affected cappers: record before -> after (${VOID_STATUS} excluded)`);
      const voidIds = new Set(slotPicks.map((p) => p.id));
      const groups = new Map<string, { userId: string; capperId: string }>();
      for (const p of slotPicks) groups.set(p.userId + "|" + p.capperId, { userId: p.userId, capperId: p.capperId });
      const line = (st: OverallStats) =>
        `${st.wins}-${st.losses}-${st.pushes}  net ${st.netUnits.toFixed(2)}u  ROI ${st.roi}%  streak ${st.currentStreak.type}${st.currentStreak.count}  longest W${st.longestWinStreak}/L${st.longestLossStreak}`;
      for (const { userId, capperId } of groups.values()) {
        const capper = await tx.capper.findUnique({ where: { id: capperId }, select: { name: true } });
        const all: SeriesPick[] = await tx.pick.findMany({
          where: { userId, capperId },
          select: { id: true, createdAt: true, gameTime: true, gradedAt: true, status: true, units: true, odds: true },
        });
        const after = all.map((p) => (voidIds.has(p.id) ? { ...p, status: VOID_STATUS } : p));
        const b = computeStats(all);
        const a = computeStats(after);
        // What leaves the record: exactly the voided picks' own results.
        const voided = all.filter((p) => voidIds.has(p.id));
        const count = (st: PickStatus) => voided.filter((p) => p.status === st).length;
        const risked = voided.reduce((t, p) => t + p.units, 0);
        const jsOk =
          a.wins === b.wins - count("WIN") && a.losses === b.losses - count("LOSS") && a.pushes === b.pushes - count("PUSH") &&
          computeStats(all.filter((p) => !voidIds.has(p.id))).roi === a.roi;
        // The SQL path (/cappers list, capper panels, Savant): same FILTER predicates, statuses overridden for the voided ids.
        const ids = [...voidIds];
        const [sql] = await tx.$queryRaw<{ w: number; l: number; pu: number; risked: number; aw: number; al: number; apu: number; arisked: number }[]>(Prisma.sql`
          SELECT (count(*) FILTER (WHERE status = 'WIN'))::int AS w, (count(*) FILTER (WHERE status = 'LOSS'))::int AS l,
                 (count(*) FILTER (WHERE status = 'PUSH'))::int AS pu,
                 COALESCE(sum(units) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS risked,
                 (count(*) FILTER (WHERE st = 'WIN'))::int AS aw, (count(*) FILTER (WHERE st = 'LOSS'))::int AS al,
                 (count(*) FILTER (WHERE st = 'PUSH'))::int AS apu,
                 COALESCE(sum(units) FILTER (WHERE st IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS arisked
          FROM (SELECT status::text AS status, units,
                       CASE WHEN id = ANY(${ids}::text[]) THEN ${VOID_STATUS}::text ELSE status::text END AS st
                FROM picks WHERE "userId" = ${userId} AND "capperId" = ${capperId}) x`);
        const sqlOk =
          sql.w === b.wins && sql.l === b.losses && sql.pu === b.pushes &&
          sql.aw === a.wins && sql.al === a.losses && sql.apu === a.pushes &&
          Math.abs(sql.risked - sql.arisked - risked) < 1e-9;
        console.log(`  ${capper?.name ?? capperId}  (user ${userId}, ${voided.length} voided)`);
        console.log(`    before: ${line(b)}`);
        console.log(`    after:  ${line(a)}`);
        console.log(`    excluded from W-L-P/units/ROI/streaks: JS ${jsOk ? "OK" : "MISMATCH"}, SQL panels ${sqlOk ? "OK" : "MISMATCH"}`);
        if (!jsOk || !sqlOk) throw new Abort(`record check failed for capper ${capperId}`);
      }

      // ---- 3. The 6 makeup picks: untouched, predicted next-cron grade ----
      console.log(`\n== 3. Makeup picks (${fmt(MAKEUP_START)}), NOT modified - what the next cron should give them`);
      const stuck = await tx.pick.findMany({
        where: {
          sport: { name: "MLB" },
          status: "PENDING",
          gameTime: { gte: new Date(MAKEUP_START.getTime() - DRIFT), lte: new Date(MAKEUP_START.getTime() + DRIFT) },
          ...tbCle,
        },
        orderBy: { id: "asc" },
      });
      // The cron's own candidate pool around the makeup, with 849817 as it
      // will read after step 1.
      const pool = (
        await tx.gameResult.findMany({
          where: {
            sportKey: MLB,
            gameDate: { gte: new Date(MAKEUP_START.getTime() - 3 * 86400000), lt: new Date(MAKEUP_START.getTime() + 3 * 86400000) },
          },
        })
      ).map((r) => {
        const fix = GAME_DATE_FIXES.find((f) => f.externalId === r.externalId);
        return fix ? { ...r, gameDate: new Date(fix.to) } : r;
      });
      if (!pool.some((r) => r.externalId === "849817")) {
        const r849817 = rows.find((x) => x.fix.externalId === "849817")!;
        const full = await tx.gameResult.findUnique({ where: { id: r849817.row.id } });
        pool.push({ ...full!, gameDate: new Date(r849817.fix.to) });
      }
      for (const p of stuck) {
        const m = matchGameResult(pool, p, MLB);
        const predicted =
          p.betType === "PLAYER_PROP" ? "player prop - graded by the cron's box-score path" : m ? (resolveOutcome(p, m.game) ?? "ungradeable from the score") : "-";
        console.log(
          `  ${p.id}  ${p.betType}  "${p.betDetail ?? ""}"  PENDING  match=${m ? m.game.externalId + " (" + m.matchType + ")" : "NONE"}  next cron -> ${predicted}`
        );
      }
      console.log(`  ${stuck.length} makeup picks`);
      if (stuck.length !== EXPECTED_STUCK_PICKS) console.log(`  WARNING: expected ${EXPECTED_STUCK_PICKS}`);

      if (!apply) {
        console.log("\n[repair] DRY RUN: nothing written. Re-run with --apply to write.");
        return;
      }

      // ---- Writes: by id, guarded by the value just read ----
      for (const { row, fix } of rows) {
        if (row.gameDate.toISOString() === fix.to) continue;
        const { count } = await tx.gameResult.updateMany({ where: { id: row.id, gameDate: row.gameDate }, data: { gameDate: new Date(fix.to) } });
        if (count !== 1) throw new Abort(`GameResult ${row.externalId} changed under us (updated ${count})`);
      }
      for (const p of slotPicks) {
        const { count } = await tx.pick.updateMany({
          where: { id: p.id, status: p.status },
          // Same as a manual grade (updatePickStatus): a fuzzy-match regrade must never overwrite it.
          data: { status: VOID_STATUS, gradedViaFuzzyMatch: false },
        });
        if (count !== 1) throw new Abort(`pick ${p.id} changed under us (updated ${count})`);
      }
      console.log(`\n[repair] APPLIED: ${rows.length} gameDate fixes, ${slotPicks.length} picks -> ${VOID_STATUS}.`);
    },
    { timeout: 60000 }
  );
}

main()
  .catch((err) => {
    console.error(`\n[repair] ABORTED, nothing written: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
