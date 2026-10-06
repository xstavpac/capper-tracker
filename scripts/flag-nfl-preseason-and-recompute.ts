// One-time, explicitly-authorized historical correction (see PR #56).
//
//   npx tsx scripts/flag-nfl-preseason-and-recompute.ts            # dry run
//   npx tsx scripts/flag-nfl-preseason-and-recompute.ts --commit   # apply
//
// What --commit does, in order:
//   1. Sets isPreseason = true on every americanfootball_nfl GameResult
//      whose gameDate falls in the configured NFL preseason window
//      [seasonStart, regularSeasonStart) and isn't already flagged.
//   2. DELETES every americanfootball_nfl TeamTendency row. recomputeTeam
//      Tendencies only upserts teams it accumulates a game for - it never
//      zeroes a stale row - so with no graded regular-season games yet the
//      old contaminated rows would otherwise survive untouched. Deleting
//      first is what makes "rebuild from scratch" actually rebuild.
//   3. Runs recomputeTeamTendencies("americanfootball_nfl") - now rebuilds
//      from regular-season + postseason games only.
//   4. Prints the resulting TeamTendency state.
//
// Pre-existing TeamTendencySnapshot rows (dated copies from the preseason
// period) are NOT touched - that's a separate call. The next refresh-scores
// cron writes a fresh, clean snapshot for the current day.
import { PrismaClient } from "@prisma/client";
import { recomputeTeamTendencies, findOddsGameForResult } from "@/server/data/team-tendencies";
import { isPreseasonGame } from "@/lib/sport-seasons";
import { easternDateKey } from "@/lib/dates";
import type { OddsGame } from "@/server/data/odds";

const SPORT = "americanfootball_nfl";
const COMMIT = process.argv.includes("--commit");
const prisma = new PrismaClient();

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[flag-nfl-preseason] db=${dbHost}  mode=${COMMIT ? "COMMIT" : "dry-run"}\n`);

  // ---- identify the preseason rows -------------------------------------
  const [allNfl, snapshots] = await Promise.all([
    prisma.gameResult.findMany({
      where: { sportKey: SPORT },
      select: { id: true, externalId: true, homeTeam: true, awayTeam: true, gameDate: true, isPreseason: true, homeScore: true, awayScore: true },
    }),
    prisma.oddsSnapshot.findMany({ where: { sportKey: SPORT }, select: { data: true } }),
  ]);
  const oddsGames: OddsGame[] = snapshots.flatMap((s) => s.data as unknown as OddsGame[]);

  const inWindow = allNfl.filter((g) => isPreseasonGame(SPORT, g.gameDate));
  const toFlag = inWindow.filter((g) => !g.isPreseason);
  const matchedOdds = toFlag.filter((g) => findOddsGameForResult(oddsGames, g) !== null);

  console.log(`NFL GameResult rows:                       ${allNfl.length}`);
  console.log(`  in the preseason window:                 ${inWindow.length}`);
  console.log(`  already flagged isPreseason=true:        ${inWindow.length - toFlag.length}`);
  console.log(`  to be flagged now:                       ${toFlag.length}  (${matchedOdds.length} matched an odds snapshot)`);
  console.log("");
  for (const g of [...toFlag].sort((a, b) => +a.gameDate - +b.gameDate)) {
    const odds = findOddsGameForResult(oddsGames, g) ? "odds" : "no-odds";
    console.log(`  ${easternDateKey(g.gameDate)}  ${g.externalId.padEnd(12)}  ${g.awayTeam} @ ${g.homeTeam}  (${odds})`);
  }
  console.log("");

  // ---- BEFORE snapshot of TeamTendency --------------------------------
  const before = await prisma.teamTendency.findMany({ where: { sportKey: SPORT } });
  const sum = (rows: typeof before) =>
    rows.reduce(
      (a, r) => ({
        favGames: a.favGames + r.favWins + r.favLosses + r.favPushes,
        dogGames: a.dogGames + r.dogWins + r.dogLosses + r.dogPushes,
        totalGames: a.totalGames + r.overCount + r.underCount + r.totalPushCount,
      }),
      { favGames: 0, dogGames: 0, totalGames: 0 }
    );
  const b = sum(before);
  console.log(`BEFORE  TeamTendency rows: ${before.length}   fav-role game-outcomes: ${b.favGames}   dog-role: ${b.dogGames}   O/U outcomes: ${b.totalGames}`);

  if (!COMMIT) {
    console.log("\n[dry run] nothing written. re-run with --commit to apply.");
    return;
  }

  // ---- 1. flag ------------------------------------------------------
  const flagged = await prisma.gameResult.updateMany({
    where: { id: { in: toFlag.map((g) => g.id) } },
    data: { isPreseason: true },
  });

  // ---- 2. delete stale NFL TeamTendency rows ----------------------
  const deleted = await prisma.teamTendency.deleteMany({ where: { sportKey: SPORT } });

  // ---- 3. recompute (preseason now filtered by the where clause) --
  const summary = await recomputeTeamTendencies(SPORT);

  // ---- 4. AFTER ---------------------------------------------------
  const after = await prisma.teamTendency.findMany({ where: { sportKey: SPORT }, orderBy: { teamName: "asc" } });
  const a = sum(after);

  console.log("");
  console.log(`flagged GameResult rows isPreseason=true:  ${flagged.count}`);
  console.log(`deleted NFL TeamTendency rows:             ${deleted.count}`);
  console.log(`recompute: gamesProcessed=${summary.gamesProcessed}  teamsUpdated=${summary.teamsUpdated}  gameResultRows(scanned, preseason excluded)=${summary.gameResultRows}`);
  console.log("");
  console.log(`AFTER   TeamTendency rows: ${after.length}   fav-role game-outcomes: ${a.favGames}   dog-role: ${a.dogGames}   O/U outcomes: ${a.totalGames}`);
  console.log("");
  if (after.length === 0) {
    console.log("NFL TeamTendency is now EMPTY - no graded regular-season game yet. Rows re-create as games go final.");
  } else {
    for (const r of after) {
      console.log(
        `  ${r.teamName.padEnd(26)} fav ${r.favWins}-${r.favLosses}-${r.favPushes}  dog ${r.dogWins}-${r.dogLosses}-${r.dogPushes}  O/U ${r.overCount}/${r.underCount}/${r.totalPushCount}`
      );
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
