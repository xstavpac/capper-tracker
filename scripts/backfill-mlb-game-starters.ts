// One-time historical backfill for GameStarters + point-in-time pitcher
// lines. Run with tsx:
//
//   npx tsx scripts/backfill-mlb-game-starters.ts --from 2025-03-27 --to 2025-09-28
//   npx tsx scripts/backfill-mlb-game-starters.ts --from 2025-03-27 --to 2025-09-28 --commit
//
// Without --commit it is a dry run: it makes the same MLB Stats API calls
// and prints what it WOULD write, but touches no database row. The daily
// cron (stat-snapshots.ts) keeps GameStarters current going forward; this is
// only for filling in history the cron never saw.
//
// What it does, per Eastern calendar day in [from, to]:
//   1. schedule?hydrate=probablePitcher over the whole week in one call
//   2. for each FINAL game: one boxscore call for the confirmed starters,
//      then upsert a GameStarters row (probable + actual + confirmed-at)
//   3. one batched people?hydrate=stats(byDateRange ...) call for every
//      distinct starter that day, endDate = day - 1 (genuinely
//      point-in-time), then upsert those lines into PitcherStatSnapshot
//      dated day - 1 - the same table and shape the daily cron writes, so
//      the existing resolver reads them with no change.
//
// Polite usage: fully sequential, with a short delay between network calls.
// A full season is ~27 schedule calls + ~2400 boxscore calls + ~185 batched
// stat calls - a few minutes, no bursts.
import { PrismaClient } from "@prisma/client";
import {
  fetchMlbScheduleWithProbables,
  fetchActualStarters,
  fetchPointInTimePitcherLines,
} from "@/server/data/mlb-pitcher-history";
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";

const MLB_SPORT_KEY = "baseball_mlb";
const REQUEST_DELAY_MS = 120;

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const FROM = arg("from");
const TO = arg("to");
const COMMIT = process.argv.includes("--commit");

if (!FROM || !TO || !/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error("usage: tsx scripts/backfill-mlb-game-starters.ts --from YYYY-MM-DD --to YYYY-MM-DD [--commit]");
  process.exit(1);
}

// Weekly windows so each schedule fetch is one call for ~7 days of games.
function weekWindows(fromKey: string, toKey: string): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  let cursor = fromKey;
  while (cursor <= toKey) {
    const end = addDaysToDateKey(cursor, 6);
    windows.push([cursor, end > toKey ? toKey : end]);
    cursor = addDaysToDateKey(end, 1);
  }
  return windows;
}

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[backfill] db=${dbHost}  range=${FROM}..${TO}  mode=${COMMIT ? "COMMIT" : "dry-run"}`);

  let gamesSeen = 0;
  let startersUpserted = 0;
  let actualsConfirmed = 0;
  let pitcherLinesUpserted = 0;

  for (const [wStart, wEnd] of weekWindows(FROM!, TO!)) {
    const games = await fetchMlbScheduleWithProbables(wStart, wEnd);
    await sleep(REQUEST_DELAY_MS);

    // Group by the game's own Eastern day so each byDateRange batch shares
    // one endDate.
    const byDay = new Map<string, typeof games>();
    for (const g of games) {
      const dayKey = easternDateKey(g.gameDate);
      const list = byDay.get(dayKey);
      if (list) list.push(g);
      else byDay.set(dayKey, [g]);
    }

    for (const [dayKey, dayGames] of [...byDay.entries()].sort()) {
      const asOfKey = addDaysToDateKey(dayKey, -1);
      const season = Number(dayKey.slice(0, 4));
      const starterIdByGame: Array<{ home: number | null; away: number | null }> = [];

      for (const g of dayGames) {
        gamesSeen++;
        let actual = null as Awaited<ReturnType<typeof fetchActualStarters>>;
        if (g.isFinal) {
          actual = await fetchActualStarters(g.gamePk);
          await sleep(REQUEST_DELAY_MS);
        }

        const homeActualId = actual?.home?.id ?? null;
        const awayActualId = actual?.away?.id ?? null;
        starterIdByGame.push({
          home: homeActualId ?? g.homeProbable?.id ?? null,
          away: awayActualId ?? g.awayProbable?.id ?? null,
        });

        if (!g.homeProbable && !g.awayProbable && !homeActualId && !awayActualId) continue;

        const row = {
          sportKey: MLB_SPORT_KEY,
          externalId: g.gamePk,
          homeTeam: g.homeTeamName,
          awayTeam: g.awayTeamName,
          gameDate: g.gameDate,
          homeProbablePitcherId: g.homeProbable?.id ?? null,
          homeProbablePitcherName: g.homeProbable?.name ?? null,
          awayProbablePitcherId: g.awayProbable?.id ?? null,
          awayProbablePitcherName: g.awayProbable?.name ?? null,
          homeStartingPitcherId: homeActualId,
          homeStartingPitcherName: actual?.home?.name ?? null,
          awayStartingPitcherId: awayActualId,
          awayStartingPitcherName: actual?.away?.name ?? null,
          startersConfirmedAt: actual ? new Date() : null,
        };
        startersUpserted++;
        if (actual) actualsConfirmed++;
        if (COMMIT) {
          await prisma.gameStarters.upsert({
            where: { sportKey_externalId: { sportKey: MLB_SPORT_KEY, externalId: g.gamePk } },
            update: row,
            create: row,
          });
        }
      }

      const ids = [...new Set(starterIdByGame.flatMap((s) => [s.home, s.away]))].filter(
        (x): x is number => typeof x === "number"
      );
      if (ids.length === 0) continue;

      const lines = await fetchPointInTimePitcherLines(ids, asOfKey, season);
      await sleep(REQUEST_DELAY_MS);

      for (const line of lines.values()) {
        pitcherLinesUpserted++;
        if (COMMIT) {
          const snap = {
            sportKey: MLB_SPORT_KEY,
            pitcherId: line.pitcherId,
            pitcherName: line.pitcherName,
            snapshotDate: asOfKey,
            era: line.era,
            whip: line.whip,
            wins: 0,
            losses: 0,
            strikeouts: line.strikeouts,
            walks: line.walks,
            inningsPitched: line.inningsPitched,
          };
          await prisma.pitcherStatSnapshot.upsert({
            where: {
              sportKey_pitcherId_snapshotDate: {
                sportKey: MLB_SPORT_KEY,
                pitcherId: line.pitcherId,
                snapshotDate: asOfKey,
              },
            },
            update: snap,
            create: snap,
          });
        }
      }

      console.log(
        `[backfill] ${dayKey}  games=${dayGames.length}  starters+=${dayGames.length}  pitcherLines=${lines.size}  (asOf ${asOfKey})`
      );
    }
  }

  console.log(
    `[backfill] done. gamesSeen=${gamesSeen} gameStarters${COMMIT ? "" : " (would)"} upsert=${startersUpserted} actualsConfirmed=${actualsConfirmed} pitcherLines${COMMIT ? "" : " (would)"} upsert=${pitcherLinesUpserted}`
  );
  if (!COMMIT) console.log("[backfill] dry run - nothing written. re-run with --commit to persist.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
