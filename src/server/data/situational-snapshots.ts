// Daily snapshot + point-in-time reader for the situational-question rates
// (scored first, led/trailed at halftime, turnover battle, ...). These
// already exist as an on-page-load display feature
// (nfl-game-pulse-situations.ts); this gives them a dated history so they can
// be read as of any past date and fed to a backtest/model, with the same
// day-before point-in-time discipline as the rest of the snapshot layer.
//
// NFL only for now (MLB's equivalent getTeamSituationalRates has no snapshot
// yet - a follow-up if it's ever needed). The evaluator itself
// (computeAllTeamsNflSituationalRates) is shared with the live path, not
// duplicated.
import { prisma } from "@/lib/prisma";
import type { SituationalRateSnapshot } from "@prisma/client";
import { easternDateKey } from "@/lib/dates";
import { dayBefore, findLatestAtOrBefore } from "@/server/data/providers/snapshot-utils";
import {
  NFL_SITUATIONAL_QUESTIONS,
  getAllNflTeamSituationalRates,
  getNflTeamSituationalRates,
  emptyNflSituationalRates,
  type NflSituationalQuestionKey,
  type NflSituationalRatesByQuestion,
} from "@/server/data/nfl-game-pulse-situations";

const NFL_SPORT_KEY = "americanfootball_nfl";

// Charts variable id -> the SituationalRateSnapshot.questionKey it reads.
// The Charts adapter (historical-variables.ts) filters the snapshot table to
// one questionKey and maps each row's wins/total to a win fraction.
export const SITUATIONAL_VARIABLE_QUESTION: Record<string, NflSituationalQuestionKey> = {
  nfl_scored_first_win_pct: "scoredFirst",
  nfl_led_at_half_win_pct: "leadingAtHalftime",
  nfl_trailed_at_half_win_pct: "trailedAtHalftime",
  nfl_won_turnover_battle_win_pct: "wonTurnoverBattle",
  nfl_led_double_digits_win_pct: "ledByDoubleDigits",
  nfl_trailing_entering_4th_win_pct: "trailingEntering4th",
};

// wins/total as a 0..1 fraction - what the Charts "percent" unit expects
// (formatValueForUnit multiplies by 100). Distinct from SituationalRate.winPct,
// which is 0..100 for the Game Pulse panel's SKEW_FLOOR comparison. null when
// the team has no games in the situation (a chart gap).
export function situationalWinFraction(wins: number, total: number): number | null {
  return total > 0 ? wins / total : null;
}

// Materialises today's situational rates for every NFL team into
// SituationalRateSnapshot - one row per (team, question). Raw wins/total,
// no sample-size floor (that's a display-time gate). DB read-then-write off
// already-stored GameResult rows, no external API. Upserts.
export async function captureSituationalRateSnapshots(
  date: string = easternDateKey(new Date())
): Promise<number> {
  // "as of end of today" so a same-day final game is included - matches
  // captureTeamRecordSnapshots. getAllNflTeamSituationalRates' asOf is
  // exclusive, so passing undefined ("all games so far") is equivalent here
  // and avoids a redundant Date construction.
  const byTeam = await getAllNflTeamSituationalRates();
  if (byTeam.size === 0) return 0;

  const rows: { sportKey: string; teamName: string; questionKey: string; snapshotDate: string; wins: number; total: number }[] = [];
  for (const [teamName, rates] of byTeam) {
    for (const question of NFL_SITUATIONAL_QUESTIONS) {
      const rate = rates[question.key];
      rows.push({
        sportKey: NFL_SPORT_KEY,
        teamName,
        questionKey: question.key,
        snapshotDate: date,
        wins: rate.wins,
        total: rate.total,
      });
    }
  }

  await Promise.all(
    rows.map((row) =>
      prisma.situationalRateSnapshot.upsert({
        where: {
          sportKey_teamName_questionKey_snapshotDate: {
            sportKey: row.sportKey,
            teamName: row.teamName,
            questionKey: row.questionKey,
            snapshotDate: row.snapshotDate,
          },
        },
        update: { wins: row.wins, total: row.total },
        create: row,
      })
    )
  );

  return rows.length;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export type SituationalRatesAsOf = {
  rates: NflSituationalRatesByQuestion;
  asOfDateKey: string; // the point-in-time cutoff: the Eastern day before the game
  source: "snapshot" | "computed";
};

function ratesFromSnapshotRows(rows: SituationalRateSnapshot[]): NflSituationalRatesByQuestion {
  const rates = emptyNflSituationalRates();
  for (const row of rows) {
    const key = row.questionKey as NflSituationalQuestionKey;
    if (!(key in rates)) continue; // a retired question key - ignore
    rates[key] = row.total === 0 ? { wins: 0, total: 0, winPct: 0 } : { wins: row.wins, total: row.total, winPct: (row.wins / row.total) * 100 };
  }
  return rates;
}

// Prefers the latest snapshot dated at/before dayBefore(gameDate); falls
// back to computing straight from GameResult when snapshot history doesn't
// reach that far - same snapshot-first, compute-fallback shape as the MLB
// pitcher point-in-time reader and getTeamRecordAsOf.
export async function getSituationalRatesAsOf(
  teamName: string,
  gameDate: Date
): Promise<SituationalRatesAsOf> {
  const cutoff = dayBefore(gameDate);
  const asOfDateKey = easternDateKey(cutoff);

  const allRows = await prisma.situationalRateSnapshot.findMany({
    where: { sportKey: NFL_SPORT_KEY, teamName },
    orderBy: { snapshotDate: "asc" },
  });

  if (allRows.length > 0) {
    // findLatestAtOrBefore works on the distinct snapshot dates; the row set
    // for that date is every question's row.
    const dates = [...new Set(allRows.map((r) => r.snapshotDate))].map((snapshotDate) => ({ snapshotDate }));
    const latest = findLatestAtOrBefore(dates, cutoff);
    if (latest) {
      const rowsForDate = allRows.filter((r) => r.snapshotDate === latest.snapshotDate);
      return { rates: ratesFromSnapshotRows(rowsForDate), asOfDateKey, source: "snapshot" };
    }
  }

  return { rates: await getNflTeamSituationalRates(teamName, cutoff), asOfDateKey, source: "computed" };
}
