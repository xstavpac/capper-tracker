// Win-loss record splits (overall / home / away / last-10 / current streak)
// derived purely from this app's own finished GameResult rows - the NFL
// stand-in for the homeWins/awayWins/last10/streak columns MLB gets from the
// MLB Stats API standings endpoint (TeamStatSnapshot). No external API: every
// input already lives on GameResult.
//
// computeTeamRecords is pure and point-in-time - it applies the asOf cutoff
// and the preseason filter itself, so the caller hands it a team's full
// history and the function decides what counts, the same "one place owns the
// as-of decision" rule model-engine/resolver.ts follows for findLatestAtOrBefore.
//
// getTeamRecordAsOf is the reader: it prefers a persisted TeamRecordSnapshot
// (captureTeamRecordSnapshots writes one per team per day) at or before
// dayBefore(gameDate), and falls back to computing straight from GameResult
// when snapshot history doesn't reach back that far - the same snapshot-first,
// compute-fallback shape as the MLB pitcher point-in-time reader.
import { prisma } from "@/lib/prisma";
import type { TeamRecordSnapshot } from "@prisma/client";
import { addDaysToDateKey, easternDateKey, easternDayStart } from "@/lib/dates";
import { dayBefore, findLatestAtOrBefore } from "@/server/data/providers/snapshot-utils";

// Exactly the GameResult columns computeTeamRecords reads - so a caller's
// `select` and this stay in lockstep.
export type RecordGameRow = {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
  isPreseason: boolean;
};

export type TeamRecord = {
  wins: number;
  losses: number;
  ties: number;
  winPct: number | null; // wins / (wins + losses); null only when the team has zero decided games
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  last10Wins: number;
  last10Losses: number;
  streakType: "W" | "L" | null;
  streakCount: number;
  gamesInRecord: number;
};

type Outcome = "W" | "L" | "T";

function emptyRecord(): TeamRecord {
  return {
    wins: 0, losses: 0, ties: 0, winPct: null,
    homeWins: 0, homeLosses: 0, awayWins: 0, awayLosses: 0,
    last10Wins: 0, last10Losses: 0,
    streakType: null, streakCount: 0, gamesInRecord: 0,
  };
}

// Every game `team` played, oldest-first, as { outcome, isHome }.
function teamGames(games: RecordGameRow[], team: string, asOf: Date): Array<{ outcome: Outcome; isHome: boolean }> {
  return games
    .filter((g) => !g.isPreseason && g.gameDate < asOf && (g.homeTeam === team || g.awayTeam === team))
    .sort((a, b) => a.gameDate.getTime() - b.gameDate.getTime())
    .map((g) => {
      const isHome = g.homeTeam === team;
      const teamScore = isHome ? g.homeScore : g.awayScore;
      const oppScore = isHome ? g.awayScore : g.homeScore;
      const outcome: Outcome = teamScore > oppScore ? "W" : teamScore < oppScore ? "L" : "T";
      return { outcome, isHome };
    });
}

// One team's record as of `asOf` (exclusive), preseason games excluded.
export function computeTeamRecord(games: RecordGameRow[], team: string, asOf: Date): TeamRecord {
  const rec = emptyRecord();
  const played = teamGames(games, team, asOf);
  rec.gamesInRecord = played.length;

  for (const g of played) {
    if (g.outcome === "W") {
      rec.wins++;
      if (g.isHome) rec.homeWins++;
      else rec.awayWins++;
    } else if (g.outcome === "L") {
      rec.losses++;
      if (g.isHome) rec.homeLosses++;
      else rec.awayLosses++;
    } else {
      rec.ties++; // ties: overall count only, never a home/away W or L
    }
  }

  const decided = rec.wins + rec.losses;
  rec.winPct = decided > 0 ? rec.wins / decided : null;

  for (const g of played.slice(-10)) {
    if (g.outcome === "W") rec.last10Wins++;
    else if (g.outcome === "L") rec.last10Losses++;
  }

  // Streak: walk most-recent-first. A tie (or the opposite result) stops the
  // scan - "currently on a 3-game winning streak" can't be true across a
  // game that wasn't a win.
  for (let i = played.length - 1; i >= 0; i--) {
    const o = played[i].outcome;
    if (o === "T") break;
    if (rec.streakType === null) {
      rec.streakType = o;
      rec.streakCount = 1;
    } else if (o === rec.streakType) {
      rec.streakCount++;
    } else {
      break;
    }
  }

  return rec;
}

// Every team's record as of `asOf`, one pass - matches recomputeTeamTendencies'
// "produce a Map for all teams at once" shape.
export function computeTeamRecords(games: RecordGameRow[], asOf: Date): Map<string, TeamRecord> {
  const teams = new Set<string>();
  for (const g of games) {
    if (g.isPreseason) continue;
    teams.add(g.homeTeam);
    teams.add(g.awayTeam);
  }
  const out = new Map<string, TeamRecord>();
  for (const team of teams) out.set(team, computeTeamRecord(games, team, asOf));
  return out;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function recordFromSnapshot(s: TeamRecordSnapshot): TeamRecord {
  const decided = s.wins + s.losses;
  return {
    wins: s.wins, losses: s.losses, ties: s.ties,
    winPct: decided > 0 ? s.wins / decided : null,
    homeWins: s.homeWins, homeLosses: s.homeLosses,
    awayWins: s.awayWins, awayLosses: s.awayLosses,
    last10Wins: s.last10Wins, last10Losses: s.last10Losses,
    streakType: s.streakType === "W" || s.streakType === "L" ? s.streakType : null,
    streakCount: s.streakCount,
    gamesInRecord: s.gamesInRecord,
  };
}

export type TeamRecordAsOf = {
  record: TeamRecord;
  asOfDateKey: string; // the point-in-time cutoff: the Eastern day before the game
  source: "snapshot" | "computed";
};

const RECORD_SELECT = {
  homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true, isPreseason: true,
} as const;

export async function getTeamRecordAsOf(
  sportKey: string,
  teamName: string,
  gameDate: Date
): Promise<TeamRecordAsOf> {
  const cutoff = dayBefore(gameDate);
  const asOfDateKey = easternDateKey(cutoff);

  const snapshots = await prisma.teamRecordSnapshot.findMany({
    where: { sportKey, teamName },
    orderBy: { snapshotDate: "asc" },
  });
  const snap = findLatestAtOrBefore(snapshots, cutoff);
  if (snap) return { record: recordFromSnapshot(snap), asOfDateKey, source: "snapshot" };

  const games = await prisma.gameResult.findMany({
    where: { sportKey, OR: [{ homeTeam: teamName }, { awayTeam: teamName }] },
    select: RECORD_SELECT,
  });
  return { record: computeTeamRecord(games, teamName, cutoff), asOfDateKey, source: "computed" };
}

// ---------------------------------------------------------------------------
// Writer - daily snapshot
// ---------------------------------------------------------------------------

// Materialises today's record for every team in `sportKey` into
// TeamRecordSnapshot. Pure DB read-then-write off already-stored GameResult
// rows - no external API, same piggyback-the-cron pattern as the other
// snapshot captures. Upserts, so a same-day retry overwrites rather than
// duplicating. Today only invoked for americanfootball_nfl (see the schema
// comment for why MLB stays on its standings source).
export async function captureTeamRecordSnapshots(
  sportKey: string,
  date: string = easternDateKey(new Date())
): Promise<number> {
  const games = await prisma.gameResult.findMany({ where: { sportKey }, select: RECORD_SELECT });
  if (games.length === 0) return 0;

  // "as of the end of today" (start of the next Eastern day) - a same-day
  // game that is already final belongs in today's snapshot. The point-in-time
  // reader, by contrast, cuts at dayBefore so a game never scores itself.
  const asOf = easternDayStart(addDaysToDateKey(date, 1));
  const records = computeTeamRecords(games, asOf);

  const rows = [...records.entries()]
    .filter(([, r]) => r.gamesInRecord > 0)
    .map(([teamName, r]) => ({
      sportKey,
      teamName,
      snapshotDate: date,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      winPct: r.winPct ?? 0,
      homeWins: r.homeWins,
      homeLosses: r.homeLosses,
      awayWins: r.awayWins,
      awayLosses: r.awayLosses,
      last10Wins: r.last10Wins,
      last10Losses: r.last10Losses,
      streakType: r.streakType,
      streakCount: r.streakCount,
      gamesInRecord: r.gamesInRecord,
    }));

  await Promise.all(
    rows.map((row) =>
      prisma.teamRecordSnapshot.upsert({
        where: { sportKey_teamName_snapshotDate: { sportKey: row.sportKey, teamName: row.teamName, snapshotDate: row.snapshotDate } },
        update: row,
        create: row,
      })
    )
  );

  return rows.length;
}
