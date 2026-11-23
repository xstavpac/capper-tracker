// One-off regrade of team-side picks graded on the WRONG TEAM because their score row (game_results) lists home/away
// the other way round (neutral sites: the pick stored the Odds API's orientation, the score row ESPN's). Before the
// grading fix, resolveOutcome applied pickedSide by position on the reversed row.
//
//   npx tsx --env-file=<file with DATABASE_URL> scripts/regrade-neutral-site-picks.ts            (dry run: reads only)
//   npx tsx --env-file=<file with DATABASE_URL> scripts/regrade-neutral-site-picks.ts --apply    (writes picks.status)
//
// Prints the DATABASE_URL host (password masked) first so the target is obvious.
//
// Which picks: graded (WIN/LOSS/PUSH) MONEYLINE / SPREAD / TEAM_TOTAL picks with a stored pickedSide, graded via the
// fuzzy match (an exact match needs the same home/away strings, so it can never be reversed), every copy (recipients'
// copies are rows of their own). Each is re-matched with matchGameResult - the grader's own matcher - and:
//   - score row reversed by full team names (scoreRowOrientation "reversed"): regraded with the fixed resolveOutcome;
//     a different status is a change. Only picks.status moves - picks store no profit/payout (both are derived from
//     status, odds and units at read time) - and gradedAt is left alone, as regradeFuzzyPool does for a correction.
//   - score row the names can't place (null): listed as NEEDS REVIEW and never changed - in prod 2026-11 these were
//     different games whose mascots collide (LSU Tigers / Louisiana Tech Bulldogs -> Mississippi State Bulldogs /
//     Jackson State Tigers), a matcher problem this script does not touch.
// --apply writes each change with the old status as a guard (updateMany where id and status), so a pick re-graded
// in between is left alone and counted.
//
// Afterwards: dashboard / capper / cappers-page caches expire in 60 s, recent swings in 1 h; platform_category_rates
// is recomputed from all history by the nightly refresh-scores run; heavy_consensus_markets only recomputes the last
// 3 Eastern dates nightly - if a changed pick's game is older and has a stored market, run
// scripts/backfill-heavy-consensus.ts.
import { prisma } from "@/lib/prisma";
import { matchGameResult, resolveOutcome, scoreRowOrientation } from "@/server/data/grading";
import { LIVE_SPORTS } from "@/server/data/odds";

const APPLY = process.argv.includes("--apply");
const DAY_MS = 86400000;
// Only the columns matching and grading read (CLAUDE.md: no findMany without a select).
const PICK_SELECT = {
  id: true, status: true, isRecipientCopy: true, betType: true, period: true, betDetail: true, line: true, pickedSide: true,
  homeTeam: true, awayTeam: true, gameTime: true, gameNumber: true,
} as const;
const GAME_SELECT = {
  homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, firstFiveHomeScore: true, firstFiveAwayScore: true,
  firstInningHomeScore: true, firstInningAwayScore: true, linescoreJson: true, gameDate: true, gameNumber: true,
} as const;
type Row = { id: string; status: string; isRecipientCopy: boolean; betType: string; period: string; betDetail: string | null; line: number | null; pickedSide: "HOME" | "AWAY" | "DRAW" | null; homeTeam: string; awayTeam: string; gameTime: Date; gameNumber: number | null };

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "") || "(DATABASE_URL unset)";
  console.log("Database: " + dbHost);
  console.log(APPLY ? "Mode: APPLY (writes picks.status)\n" : "Mode: dry run (reads only; pass --apply to write)\n");

  type Change = { pick: Row; sport: string; from: string; to: string; scoreRow: string };
  const changes: Change[] = [];
  const review: { pick: Row; sport: string; scoreRow: string }[] = [];
  let checked = 0;

  for (const sport of LIVE_SPORTS) {
    const picks = await prisma.pick.findMany({
      where: {
        sport: { name: sport.label },
        status: { in: ["WIN", "LOSS", "PUSH"] },
        betType: { in: ["MONEYLINE", "SPREAD", "TEAM_TOTAL"] },
        pickedSide: { in: ["HOME", "AWAY"] },
        gradedViaFuzzyMatch: true,
      },
      select: PICK_SELECT,
    });
    if (picks.length === 0) continue;
    checked += picks.length;
    const times = picks.map((p) => p.gameTime.getTime());
    const candidates = (
      await prisma.gameResult.findMany({
        where: { sportKey: sport.key, gameDate: { gte: new Date(Math.min(...times) - 2 * DAY_MS), lt: new Date(Math.max(...times) + 2 * DAY_MS) } },
        select: GAME_SELECT,
      })
    ).map((g) => ({ ...g, sportKey: sport.key }));

    for (const pick of picks) {
      const match = matchGameResult(candidates, pick, sport.key);
      if (!match || match.matchType !== "fuzzy") continue;
      const game = match.game;
      const scoreRow = `${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}`;
      const orientation = scoreRowOrientation(pick, game);
      if (orientation === "same") continue;
      if (orientation === null) {
        review.push({ pick, sport: sport.label, scoreRow });
        continue;
      }
      const outcome = resolveOutcome(pick, game);
      if (outcome && outcome !== pick.status) changes.push({ pick, sport: sport.label, from: pick.status, to: outcome, scoreRow });
    }
  }

  console.log(`Checked: ${checked} fuzzy-graded team-side picks with a stored side`);
  console.log(`Changes: ${changes.length}`);
  const groups = new Map<string, number>();
  for (const c of changes) groups.set(`${c.sport} ${c.pick.betType} ${c.pick.period}`, (groups.get(`${c.sport} ${c.pick.betType} ${c.pick.period}`) ?? 0) + 1);
  for (const [k, n] of groups) console.log(`  ${k}: ${n}`);
  for (const c of changes) {
    console.log(`  ${c.pick.id}${c.pick.isRecipientCopy ? " (recipient copy)" : ""}  ${c.sport} ${c.pick.betDetail}  [${c.scoreRow}]  ${c.from} -> ${c.to}`);
  }
  console.log(`\nNeeds review (score row the team names can't place; never changed here): ${review.length}`);
  for (const r of review) console.log(`  ${r.pick.id}  ${r.sport} ${r.pick.betDetail} (${r.pick.awayTeam} @ ${r.pick.homeTeam})  matched [${r.scoreRow}]  stored ${r.pick.status}`);

  if (!APPLY || changes.length === 0) return;
  let written = 0;
  let skipped = 0;
  for (const c of changes) {
    const { count } = await prisma.pick.updateMany({ where: { id: c.pick.id, status: c.pick.status as "WIN" | "LOSS" | "PUSH" }, data: { status: c.to as "WIN" | "LOSS" | "PUSH" } });
    if (count === 1) written++;
    else skipped++;
  }
  console.log(`\nWritten: ${written}; skipped (status changed since the read): ${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
