// One-off backfill for the 2026-09-19 NCAAF Saturday slate. Run with:
//
//   DATABASE_URL="<target db>" npx tsx scripts/backfill-ncaaf-20260919-scores.ts
//
// Background (2026-09-21 investigation, 63 stuck "no matching game found"
// picks): getEspnScoresForDate's old `limit=1000` param silently truncated
// that Saturday's fetch to 25 of the real 71 FBS games. persistFinalScores
// never saw the missing ~46 finals, so GameResult never got rows for them,
// and findMatchingGameResult (grading.ts) - which only ever reads GameResult,
// no live fallback - permanently returns null for every pending pick on
// those games. The `limit` param has since been removed from
// getEspnScoresForDate (see odds.ts), fixing this going forward, but
// getLiveScoresForSport only ever looks at yesterday/today/tomorrow - there
// is no historical fetch path - so once 2026-09-19 rolls out of that window
// (tomorrow, 2026-09-22) it can never be captured automatically again. This
// recovers it now, before that happens.
//
// Deliberately NOT a parallel implementation: this calls the real
// persistFinalScores() (grading.ts) - the exact function refresh-scores and
// grade-picks cron already call - so the backfilled rows go through the same
// upsert/ledger/segment logic as every other GameResult row, not a
// hand-rolled subset. The only thing this script does differently is make
// "now" briefly appear to be 2026-09-20T12:00:00Z (midday, comfortably after
// Saturday's last final and before Sunday's slate) by overriding the global
// Date class, so getEspnScores' yesterday/today/tomorrow window
// (fmt(now-1d)/fmt(now)/fmt(now+1d)) includes 2026-09-19 as "yesterday" -
// same fetch logic, just pointed at the right day. It also naturally sweeps
// up any 09-20/09-21 finals in the same run; upsert is idempotent, so that's
// harmless.
//
// No --commit flag: persistFinalScores() has no dry-run mode of its own (see
// grading.ts) and its upsert is safe-by-construction - it only ever fills in
// fields that are still null, never overwrites an already-captured final
// score - so there's nothing a dry run would meaningfully preview here. This
// was explicitly requested as a live recovery run.

const FAKE_NOW = new Date("2026-09-20T12:00:00Z").getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  // `any[]`, not ConstructorParameters<typeof Date> - that resolves to just
  // ONE of Date's overload signatures (a fixed-length tuple), which made
  // `args.length === 0` a TS error ("types '1' and '0' have no overlap")
  // since it narrowed length to a single literal instead of the real 0-7
  // range every Date constructor call can pass.
  constructor(...args: any[]) {
    if (args.length === 0) super(FAKE_NOW);
    else super(...(args as ConstructorParameters<typeof Date>));
  }
  static now() {
    return FAKE_NOW;
  }
}
// @ts-expect-error - deliberate global override, restored in finally below
globalThis.Date = FakeDate;

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[backfill] db=${dbHost}  fake-now=${new RealDate(FAKE_NOW).toISOString()}`);

  const { persistFinalScores, findMatchingGameResult } = await import("../src/server/data/grading");
  const { prisma } = await import("../src/lib/prisma");

  const persisted = await persistFinalScores("americanfootball_ncaaf");
  console.log(`[backfill] persistFinalScores("americanfootball_ncaaf") upserted/refreshed ${persisted} GameResult rows`);

  // Restore the real clock before verifying - findMatchingGameResult windows
  // off pick.gameTime (explicit, already-real dates), not "now", but no
  // reason to leave the override in place a moment longer than needed.
  globalThis.Date = RealDate;

  const pending = await prisma.pick.findMany({
    where: { status: "PENDING", sport: { name: "NCAAF" } },
    select: { id: true, homeTeam: true, awayTeam: true, gameTime: true, betDetail: true },
  });
  console.log(`[backfill] checking ${pending.length} PENDING NCAAF picks against GameResult...`);

  let stillUnmatched = 0;
  const unmatchedSample: string[] = [];
  for (const p of pending) {
    const match = await findMatchingGameResult("americanfootball_ncaaf", p);
    if (!match) {
      stillUnmatched++;
      if (unmatchedSample.length < 15) unmatchedSample.push(`${p.awayTeam} @ ${p.homeTeam} (${p.gameTime.toISOString()})`);
    }
  }

  console.log(`[backfill] result: ${pending.length - stillUnmatched}/${pending.length} PENDING NCAAF picks now match a GameResult row`);
  if (stillUnmatched > 0) {
    console.log(`[backfill] STILL UNMATCHED (${stillUnmatched}):`);
    for (const s of unmatchedSample) console.log(`  - ${s}`);
    if (stillUnmatched > unmatchedSample.length) console.log(`  ... and ${stillUnmatched - unmatchedSample.length} more`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  globalThis.Date = RealDate;
  process.exit(1);
});
