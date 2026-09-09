// Daily point-in-time captures of team/pitcher season stats, plus which
// pitcher started each game - the historical dataset team_stats/
// pitcher_stats condition backtesting needs (see model-evaluation.ts's
// unsupportedBacktestReason: mlb-stats.ts only ever exposed CURRENT totals,
// with no way to know what a team/pitcher's stats were on a past date, or
// which pitcher even started a given historical game). Piggybacked on the
// existing refresh-scores cron rather than a new scheduled job - confirmed
// against the live API before building this: 4-5 requests/day total (1
// schedule call, 1 standings call, 2 league-wide team-stats calls, 1 batched
// multi-pitcher call), via endpoints that return every team/every probable
// starter in one response instead of one call each. Recording each game's
// probable starters (GameStarters) rides the same schedule call already
// fetched for pitcher snapshots, so it adds zero additional requests;
// reconcileGameStarters then fills in each finished game's CONFIRMED starter
// from its boxscore (one cheap call per newly-final game).
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { currentMlbSeason, mlbTeamNameById } from "@/server/data/mlb-stats";
import { currentNflSeason } from "@/server/data/nfl-team-stats";
import { buildNflTeamStatRows } from "@/server/data/nfl-team-stat-snapshots";
import {
  fetchMlbScheduleWithProbables,
  fetchActualStarters,
  findAggregateSplit,
} from "@/server/data/mlb-pitcher-history";

const MLB_SPORT_KEY = "baseball_mlb";

type StandingsSplit = { wins: number; losses: number };

function parseStandingsSplit(splitRecords: any[] | undefined, type: string): StandingsSplit {
  const s = splitRecords?.find((r: any) => r.type === type);
  return { wins: s?.wins ?? 0, losses: s?.losses ?? 0 };
}

// Captures every team's season-to-date line for one calendar day - 3
// requests total (standings covers all 30 teams' record/streak/home-away/
// last-10; the two team-stats calls cover all 30 teams' hitting and
// pitching aggregates each in one response). Upserts so re-running the same
// day (e.g. a manual cron retry) overwrites rather than duplicates.
export async function captureTeamStatSnapshots(date: string = easternDateKey(new Date())): Promise<number> {
  const season = currentMlbSeason();
  const [standingsRes, hittingRes, pitchingRes] = await Promise.all([
    fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}`, { cache: "no-store" }),
    fetch(`https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=${season}&sportId=1`, { cache: "no-store" }),
    fetch(`https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${season}&sportId=1`, { cache: "no-store" }),
  ]);
  if (!standingsRes.ok || !hittingRes.ok || !pitchingRes.ok) return 0;

  const [standingsData, hittingData, pitchingData] = await Promise.all([standingsRes.json(), hittingRes.json(), pitchingRes.json()]);

  const hittingByTeamId = new Map<number, any>();
  for (const split of hittingData.stats?.[0]?.splits ?? []) hittingByTeamId.set(split.team.id, split.stat);
  const pitchingByTeamId = new Map<number, any>();
  for (const split of pitchingData.stats?.[0]?.splits ?? []) pitchingByTeamId.set(split.team.id, split.stat);

  const rows: {
    sportKey: string;
    teamName: string;
    snapshotDate: string;
    wins: number;
    losses: number;
    winPct: number;
    runDifferential: number;
    battingAvg: number;
    obp: number;
    slg: number;
    ops: number;
    era: number;
    whip: number;
    homeWins: number;
    homeLosses: number;
    awayWins: number;
    awayLosses: number;
    last10Wins: number;
    last10Losses: number;
    streakType: string | null;
    streakCount: number;
  }[] = [];

  for (const record of standingsData.records ?? []) {
    for (const teamRecord of record.teamRecords ?? []) {
      const teamId = teamRecord.team?.id;
      // The standings response's own team.name is MLB's short "club name"
      // ("Blue Jays", "D-backs") - normalized here to the full name
      // ("Toronto Blue Jays", "Arizona Diamondbacks") every other team-keyed
      // table in this app uses (GameResult/OddsSnapshot/TeamTendency, all
      // sourced from The Odds API), otherwise this table's rows silently
      // never join against a real game's favorite/underdog team name.
      const teamName = teamId ? mlbTeamNameById(teamId) : null;
      const hitting = hittingByTeamId.get(teamId);
      const pitching = pitchingByTeamId.get(teamId);
      // A team missing from either league-wide stats response (shouldn't
      // happen mid-season, but possible around roster/league-structure
      // changes) skips rather than writing a half-populated row - missing
      // beats wrong, same convention as the rest of this app's data capture.
      if (!teamName || !hitting || !pitching) continue;

      const splitRecords = teamRecord.records?.splitRecords;
      const home = parseStandingsSplit(splitRecords, "home");
      const away = parseStandingsSplit(splitRecords, "away");
      const last10 = parseStandingsSplit(splitRecords, "lastTen");
      const streakCode: string | undefined = teamRecord.streak?.streakCode;
      const validStreak = streakCode && /^[WL]\d+$/.test(streakCode);

      rows.push({
        sportKey: MLB_SPORT_KEY,
        teamName,
        snapshotDate: date,
        wins: teamRecord.leagueRecord?.wins ?? 0,
        losses: teamRecord.leagueRecord?.losses ?? 0,
        winPct: parseFloat(teamRecord.leagueRecord?.pct ?? "0"),
        runDifferential: (teamRecord.runsScored ?? 0) - (teamRecord.runsAllowed ?? 0),
        battingAvg: parseFloat(hitting.avg ?? "0"),
        obp: parseFloat(hitting.obp ?? "0"),
        slg: parseFloat(hitting.slg ?? "0"),
        ops: parseFloat(hitting.ops ?? "0"),
        era: parseFloat(pitching.era ?? "0"),
        whip: parseFloat(pitching.whip ?? "0"),
        homeWins: home.wins,
        homeLosses: home.losses,
        awayWins: away.wins,
        awayLosses: away.losses,
        last10Wins: last10.wins,
        last10Losses: last10.losses,
        streakType: validStreak ? streakCode![0] : null,
        streakCount: validStreak ? parseInt(streakCode!.slice(1), 10) : 0,
      });
    }
  }

  await Promise.all(
    rows.map((row) =>
      prisma.teamStatSnapshot.upsert({
        where: { sportKey_teamName_snapshotDate: { sportKey: row.sportKey, teamName: row.teamName, snapshotDate: row.snapshotDate } },
        update: row,
        create: row,
      })
    )
  );

  return rows.length;
}

type ProbableStarter = { id: number; name: string };

type ScheduledGame = {
  gamePk: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: Date;
  homePitcher: ProbableStarter | null;
  awayPitcher: ProbableStarter | null;
};

// Today's MLB schedule with each game's probable starters, one request -
// hydrate=probablePitcher returns them inline on the schedule response
// instead of needing a per-game live-feed fetch. The fetch+parse itself
// lives in mlb-pitcher-history.ts (fetchMlbScheduleWithProbables, a
// date-range call the historical backfill also uses) so there is one
// schedule parser, not two - this just narrows it to a single day and maps
// to the local shape the snapshot code already expects.
async function getTodaysSchedule(date: string): Promise<ScheduledGame[]> {
  const games = await fetchMlbScheduleWithProbables(date, date);
  return games.map((g) => ({
    gamePk: g.gamePk,
    homeTeam: g.homeTeamName,
    awayTeam: g.awayTeamName,
    gameDate: g.gameDate,
    homePitcher: g.homeProbable,
    awayPitcher: g.awayProbable,
  }));
}

// Upserts one GameStarters row per game that has a probable starter, keyed
// like GameResult (sportKey + externalId/gamePk). Written here, pre-game,
// because that is the only time the probable is known and GameResult does
// not exist yet (persistFinalScores creates it a day or more later, once the
// game is final). The confirmed actual starter is filled in afterwards by
// reconcileGameStarters. Reads only fields already on the schedule response
// getTodaysSchedule just fetched - zero extra requests.
async function writeGameStarters(games: ScheduledGame[]): Promise<number> {
  const rows = games
    .filter((g) => g.homePitcher || g.awayPitcher)
    .map((g) => ({
      sportKey: MLB_SPORT_KEY,
      externalId: g.gamePk,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      gameDate: g.gameDate,
      homeProbablePitcherId: g.homePitcher?.id ?? null,
      homeProbablePitcherName: g.homePitcher?.name ?? null,
      awayProbablePitcherId: g.awayPitcher?.id ?? null,
      awayProbablePitcherName: g.awayPitcher?.name ?? null,
    }));

  await Promise.all(
    rows.map((row) =>
      prisma.gameStarters.upsert({
        where: { sportKey_externalId: { sportKey: row.sportKey, externalId: row.externalId } },
        // Only the probable fields on update - never clobber a confirmed
        // actual starter a later reconcile pass already wrote.
        update: {
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          gameDate: row.gameDate,
          homeProbablePitcherId: row.homeProbablePitcherId,
          homeProbablePitcherName: row.homeProbablePitcherName,
          awayProbablePitcherId: row.awayProbablePitcherId,
          awayProbablePitcherName: row.awayProbablePitcherName,
        },
        create: row,
      })
    )
  );

  return rows.length;
}

// Fills in the CONFIRMED actual starter (boxscore, first pitcher to appear)
// for every GameStarters row that has a matching final GameResult but has
// not been reconciled yet (startersConfirmedAt is null). One boxscore call
// per such game - normally a handful per daily run, since yesterday's games
// are the only ones going final between passes. A late scratch is exactly
// the case this catches: the probable stays on the row untouched, the
// actual is written alongside it, and readers prefer the actual.
export async function reconcileGameStarters(
  sportKey: string = MLB_SPORT_KEY
): Promise<{ reconciled: number; pending: number }> {
  const unconfirmed = await prisma.gameStarters.findMany({
    where: { sportKey, startersConfirmedAt: null },
    orderBy: { gameDate: "asc" },
  });
  if (unconfirmed.length === 0) return { reconciled: 0, pending: 0 };

  const finalIds = new Set(
    (
      await prisma.gameResult.findMany({
        where: { sportKey, externalId: { in: unconfirmed.map((r) => r.externalId) } },
        select: { externalId: true },
      })
    ).map((r) => r.externalId)
  );

  const due = unconfirmed.filter((r) => finalIds.has(r.externalId));
  let reconciled = 0;
  for (const row of due) {
    const actual = await fetchActualStarters(row.externalId);
    if (!actual) continue;
    await prisma.gameStarters.update({
      where: { id: row.id },
      data: {
        homeStartingPitcherId: actual.home?.id ?? null,
        homeStartingPitcherName: actual.home?.name ?? null,
        awayStartingPitcherId: actual.away?.id ?? null,
        awayStartingPitcherName: actual.away?.name ?? null,
        startersConfirmedAt: new Date(),
      },
    });
    reconciled++;
  }
  return { reconciled, pending: unconfirmed.length - reconciled };
}

// Same aggregate-preference logic as findAggregateSplit (imported from
// mlb-pitcher-history.ts, where the traded-pitcher case is documented and
// tested), scoped to one home/away split code - see the multi-team case
// investigated live before writing this (a traded pitcher's statSplits
// includes both per-team entries and, when he played that side for more than
// one team, a no-team aggregate; a single-team season only has the one
// per-team entry for that code).
function findSplitByCode(splits: any[] | undefined, code: string): any | undefined {
  if (!splits) return undefined;
  return splits.find((s) => !s.team && s.split?.code === code) ?? splits.find((s) => s.split?.code === code);
}

// Every distinct probable starter across today's games - a pitcher starting
// for two different games on the same date isn't possible, but the same
// dedup guards against any data oddity producing a duplicate id.
function dedupePitchers(games: ScheduledGame[]): ProbableStarter[] {
  const byId = new Map<number, string>();
  for (const game of games) {
    if (game.homePitcher) byId.set(game.homePitcher.id, game.homePitcher.name);
    if (game.awayPitcher) byId.set(game.awayPitcher.id, game.awayPitcher.name);
  }
  return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
}

// Captures today's probable starters' season-to-date lines AND which pitcher
// started for which team in which game - 2 requests total (the schedule
// call above, plus one batched call for every starter's season/home-away-
// split/game-log stats together, via the personIds hydrate endpoint
// verified live to support multiple ids and multiple stat types in a single
// response). Returns zero counts without error on a scheduleless day (e.g.
// all-star break) - not every cron run will have starters to capture.
export async function capturePitcherStatSnapshots(
  date: string = easternDateKey(new Date())
): Promise<{ starters: number; pitcherSnapshots: number }> {
  const season = currentMlbSeason();
  const games = await getTodaysSchedule(date);
  if (games.length === 0) return { starters: 0, pitcherSnapshots: 0 };

  // Record which pitcher is probable for which side of which game, keyed so
  // a consumer can later join GameResult -> GameStarters -> point-in-time
  // pitcher stats. Written from the schedule response already in hand.
  const starterCount = await writeGameStarters(games);

  const starters = dedupePitchers(games);
  if (starters.length === 0) return { starters: starterCount, pitcherSnapshots: 0 };

  const ids = starters.map((s) => s.id).join(",");
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/people?personIds=${ids}&hydrate=stats(group=[pitching],type=[season,statSplits,gameLog],sitCodes=[h,a],season=${season})`,
    { cache: "no-store" }
  );
  if (!res.ok) return { starters: starterCount, pitcherSnapshots: 0 };

  const data = await res.json();
  const people = data.people ?? [];
  const referenceMs = new Date().getTime();

  const rows: {
    sportKey: string;
    pitcherId: number;
    pitcherName: string;
    snapshotDate: string;
    era: number;
    whip: number;
    wins: number;
    losses: number;
    strikeouts: number;
    walks: number;
    inningsPitched: number;
    homeEra: number | null;
    roadEra: number | null;
    daysRest: number | null;
  }[] = [];

  for (const person of people) {
    const statGroups: any[] = person.stats ?? [];
    const seasonSplits = statGroups.find((g) => g.type?.displayName === "season")?.splits;
    const splitSplits = statGroups.find((g) => g.type?.displayName === "statSplits")?.splits;
    const gameLogSplits = statGroups.find((g) => g.type?.displayName === "gameLog")?.splits ?? [];

    const seasonStat = findAggregateSplit(seasonSplits)?.stat;
    if (!seasonStat) continue; // e.g. a starter with no pitching appearances yet this season

    const homeSplit = findSplitByCode(splitSplits, "h")?.stat;
    const awaySplit = findSplitByCode(splitSplits, "a")?.stat;

    const lastAppearanceMs = gameLogSplits
      .map((g: any) => new Date(g.date).getTime())
      .filter((t: number) => t <= referenceMs)
      .sort((a: number, b: number) => b - a)[0];
    const daysRest = lastAppearanceMs !== undefined ? Math.round((referenceMs - lastAppearanceMs) / 86400000) : null;

    rows.push({
      sportKey: MLB_SPORT_KEY,
      pitcherId: person.id,
      pitcherName: person.fullName ?? starters.find((s) => s.id === person.id)?.name ?? "Unknown",
      snapshotDate: date,
      era: parseFloat(seasonStat.era ?? "0"),
      whip: parseFloat(seasonStat.whip ?? "0"),
      wins: seasonStat.wins ?? 0,
      losses: seasonStat.losses ?? 0,
      strikeouts: seasonStat.strikeOuts ?? 0,
      walks: seasonStat.baseOnBalls ?? 0,
      inningsPitched: parseFloat(seasonStat.inningsPitched ?? "0"),
      homeEra: homeSplit ? parseFloat(homeSplit.era ?? "0") : null,
      roadEra: awaySplit ? parseFloat(awaySplit.era ?? "0") : null,
      daysRest,
    });
  }

  await Promise.all(
    rows.map((row) =>
      prisma.pitcherStatSnapshot.upsert({
        where: { sportKey_pitcherId_snapshotDate: { sportKey: row.sportKey, pitcherId: row.pitcherId, snapshotDate: row.snapshotDate } },
        update: row,
        create: row,
      })
    )
  );

  return { starters: starterCount, pitcherSnapshots: rows.length };
}

// ---------------------------------------------------------------------------
// NFL team-stat snapshots (nflverse)
// ---------------------------------------------------------------------------
//
// The NFL counterpart to captureTeamStatSnapshots above, but a completely
// different pipeline: no MLB Stats API equivalent exists for NFL, so this
// reads nflverse's static CSV release files over plain HTTP. These are not
// metered API calls - no key, no rate limit, no per-request cost - so unlike
// the Odds API fetches elsewhere there is nothing to throttle or conserve,
// and it runs unconditionally on every refresh-scores pass (same "piggyback
// the existing cron, don't add a schedule entry" choice as the MLB snapshots).
//
// Rows land in NflTeamStatSnapshot (its own table, NOT a sport-discriminated
// TeamStatSnapshot - the schemas barely overlap). See
// server/data/nfl-team-stat-snapshots.ts for the pure CSV -> row transform
// (joins stats_team_week to games.csv for dates/scores, self-joins on
// game_id for allowed-side stats) and server/data/nfl-team-stats.ts for the
// abbreviation -> full-name map.
//
// Data source: nflverse (github.com/nflverse/nflverse-data), CC-BY-4.0 -
// attribution is surfaced in the Charts UI.
const NFLVERSE_GAMES_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const nflverseStatsTeamWeekUrl = (season: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;

export async function captureNflTeamStatSnapshots(): Promise<{ rowsWritten: number; errors: number }> {
  const season = currentNflSeason();

  const [statsRes, gamesRes] = await Promise.all([
    fetch(nflverseStatsTeamWeekUrl(season), { cache: "no-store" }),
    fetch(NFLVERSE_GAMES_URL, { cache: "no-store" }),
  ]);

  // Expected, not an error: nflverse has no preseason data in this dataset
  // and does not create stats_team_week_{season}.csv until Week 1 of the
  // regular season, so this 404s for the entire preseason / early-week
  // window every year. Succeed with zero rows written - the first cron run
  // after Week 1 populates the file and this picks it up with no code change.
  if (statsRes.status === 404) return { rowsWritten: 0, errors: 0 };

  if (!statsRes.ok || !gamesRes.ok) {
    console.error(
      `[nfl-team-stats] nflverse fetch failed - stats_team_week_${season}=${statsRes.status}, games.csv=${gamesRes.status}`
    );
    return { rowsWritten: 0, errors: 1 };
  }

  const [statsCsv, gamesCsv] = await Promise.all([statsRes.text(), gamesRes.text()]);
  const { rows, errors } = buildNflTeamStatRows(statsCsv, gamesCsv);

  // Fail loudly per bad row (unmappable team, game_id missing from
  // schedules, missing opponent row, malformed row) - but one bad row never
  // aborts the run, same skip-and-continue partial-failure handling
  // captureTeamStatSnapshots uses for a team missing from the MLB response.
  for (const err of errors) {
    console.error(`[nfl-team-stats] ${err.kind}${err.gameId ? ` (${err.gameId})` : ""}: ${err.detail}`);
  }

  // Upsert keyed on (team, gameId) so a nightly re-fetch of the current
  // season's file never duplicates, and a revised source row (nflverse
  // restates stats during the week) updates the existing snapshot in place.
  await Promise.all(
    rows.map((row) =>
      prisma.nflTeamStatSnapshot.upsert({
        where: { team_gameId: { team: row.team, gameId: row.gameId } },
        update: row,
        create: row,
      })
    )
  );

  return { rowsWritten: rows.length, errors: errors.length };
}
