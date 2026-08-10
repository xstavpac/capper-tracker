// Daily point-in-time captures of team/pitcher season stats - the historical
// dataset team_stats/pitcher_stats condition backtesting needs (see
// model-evaluation.ts's unsupportedBacktestReason: mlb-stats.ts only ever
// exposed CURRENT totals, with no way to know what a team's ERA was on a
// past date). Piggybacked on the existing refresh-scores cron rather than a
// new scheduled job - confirmed against the live API before building this:
// 4-5 requests/day total (1 schedule call, 1 standings call, 2 league-wide
// team-stats calls, 1 batched multi-pitcher call), via endpoints that return
// every team/every probable starter in one response instead of one call each.
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { currentMlbSeason } from "@/server/data/mlb-stats";

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
      const teamName = teamRecord.team?.name;
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

// Every probable starter (home and away) across today's MLB schedule, one
// request - hydrate=probablePitcher returns them inline on the schedule
// response instead of needing a per-game live-feed fetch (getProbablePitcher
// in mlb-stats.ts does that heavier per-game lookup for the live preview's
// single-game case; this batch capture needs all of today's starters at
// once, so it uses the cheaper schedule-level hydration instead).
async function getTodaysProbableStarters(date: string): Promise<ProbableStarter[]> {
  const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher`, {
    cache: "no-store",
  });
  if (!res.ok) return [];

  const data = await res.json();
  const games = data.dates?.[0]?.games ?? [];
  const byId = new Map<number, string>();
  for (const game of games) {
    for (const side of ["home", "away"] as const) {
      const pitcher = game.teams?.[side]?.probablePitcher;
      if (pitcher?.id && pitcher?.fullName) byId.set(pitcher.id, pitcher.fullName);
    }
  }
  return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
}

// The season-total split (not one of the per-team splits a mid-season trade
// produces) - the entry with no `team` field is MLB's own aggregate across
// every team played for; falls back to the first split for a player with
// only one team on record, where no separate no-team aggregate is returned.
function findAggregateSplit(splits: any[] | undefined): any | undefined {
  if (!splits || splits.length === 0) return undefined;
  return splits.find((s) => !s.team) ?? splits[0];
}

// Same aggregate-preference logic as findAggregateSplit, scoped to one
// home/away split code - see the multi-team case investigated live before
// writing this (a traded pitcher's statSplits includes both per-team entries
// and, when he played that side for more than one team, a no-team aggregate;
// a single-team season only has the one per-team entry for that code).
function findSplitByCode(splits: any[] | undefined, code: string): any | undefined {
  if (!splits) return undefined;
  return splits.find((s) => !s.team && s.split?.code === code) ?? splits.find((s) => s.split?.code === code);
}

// Captures today's probable starters' season-to-date lines - 2 requests
// total (the schedule call above, plus one batched call for every starter's
// season/home-away-split/game-log stats together, via the personIds hydrate
// endpoint verified live to support multiple ids and multiple stat types in
// a single response). Returns 0 without error on a scheduleless day (e.g.
// all-star break) - not every cron run will have starters to capture.
export async function capturePitcherStatSnapshots(date: string = easternDateKey(new Date())): Promise<number> {
  const season = currentMlbSeason();
  const starters = await getTodaysProbableStarters(date);
  if (starters.length === 0) return 0;

  const ids = starters.map((s) => s.id).join(",");
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/people?personIds=${ids}&hydrate=stats(group=[pitching],type=[season,statSplits,gameLog],sitCodes=[h,a],season=${season})`,
    { cache: "no-store" }
  );
  if (!res.ok) return 0;

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

  return rows.length;
}
