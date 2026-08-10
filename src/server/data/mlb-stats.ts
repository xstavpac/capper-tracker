// Team/pitcher season stats for the model builder's variable library -
// standard box-score-level data only (season hitting/pitching aggregates,
// standings splits, probable-pitcher lookup) via the same free MLB Stats API
// already used for live scores (server/data/odds.ts). Deliberately nothing
// from a Statcast/advanced-metrics endpoint (exit velocity, xFIP, xwOBA,
// etc.) - explicitly out of scope per the model builder spec.

const MLB_TEAM_IDS: Record<string, number> = {
  Athletics: 133,
  "Pittsburgh Pirates": 134,
  "San Diego Padres": 135,
  "Seattle Mariners": 136,
  "San Francisco Giants": 137,
  "St. Louis Cardinals": 138,
  "Tampa Bay Rays": 139,
  "Texas Rangers": 140,
  "Toronto Blue Jays": 141,
  "Minnesota Twins": 142,
  "Philadelphia Phillies": 143,
  "Atlanta Braves": 144,
  "Chicago White Sox": 145,
  "Miami Marlins": 146,
  "New York Yankees": 147,
  "Milwaukee Brewers": 158,
  "Los Angeles Angels": 108,
  "Arizona Diamondbacks": 109,
  "Baltimore Orioles": 110,
  "Boston Red Sox": 111,
  "Chicago Cubs": 112,
  "Cincinnati Reds": 113,
  "Cleveland Guardians": 114,
  "Colorado Rockies": 115,
  "Detroit Tigers": 116,
  "Houston Astros": 117,
  "Kansas City Royals": 118,
  "Los Angeles Dodgers": 119,
  "Washington Nationals": 120,
  "New York Mets": 121,
};

export function mlbTeamId(teamName: string): number | null {
  return MLB_TEAM_IDS[teamName] ?? null;
}

const MLB_TEAM_NAMES_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(MLB_TEAM_IDS).map(([name, id]) => [id, name])
);

// The canonical full team name this app uses everywhere else (GameResult,
// OddsSnapshot, TeamTendency - all sourced from The Odds API/ESPN, e.g.
// "Toronto Blue Jays"), keyed by MLB's own numeric team id. Needed because
// MLB Stats API's own endpoints (standings, team stats) return a shorter
// "club name" for the same team (e.g. "Blue Jays", "D-backs") - stat-
// snapshots.ts uses this to normalize captured rows to the one naming
// convention the rest of the app joins on, instead of silently storing a
// second, incompatible spelling per team.
export function mlbTeamNameById(id: number): string | null {
  return MLB_TEAM_NAMES_BY_ID[id] ?? null;
}

export function currentMlbSeason(): number {
  return new Date().getFullYear();
}

export type TeamSeasonStats = {
  wins: number;
  losses: number;
  winPct: number;
  runsScored: number;
  runsAllowed: number;
  runDifferential: number;
  battingAvg: number;
  obp: number;
  slg: number;
  ops: number;
  era: number;
  whip: number;
  homeRecord: { wins: number; losses: number };
  awayRecord: { wins: number; losses: number };
  last10: { wins: number; losses: number };
  streak: { type: "W" | "L" | null; count: number };
};

// One team's full season snapshot - standings (record/streak/splits) +
// season hitting + season pitching, fetched in parallel since they're
// independent endpoints. Returns null if the team isn't found or the API
// call fails, rather than throwing - a missing stat should make one
// variable unavailable for one game, not break the whole page.
export async function getTeamSeasonStats(teamName: string): Promise<TeamSeasonStats | null> {
  const teamId = mlbTeamId(teamName);
  if (!teamId) return null;

  const season = currentMlbSeason();
  try {
    const [standingsData, hittingRes, pitchingRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}`, {
        next: { revalidate: 3600 },
      }).then((r) => (r.ok ? r.json() : null)),
      fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&sportId=1`, {
        next: { revalidate: 3600 },
      }),
      fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&sportId=1`, {
        next: { revalidate: 3600 },
      }),
      // WHIP isn't a direct field on the pitching stat block below - derived
      // from baseOnBalls+hits / inningsPitched once all three responses land.
    ]);

    const hitting = hittingRes.ok ? (await hittingRes.json()).stats?.[0]?.splits?.[0]?.stat : null;
    const pitching = pitchingRes.ok ? (await pitchingRes.json()).stats?.[0]?.splits?.[0]?.stat : null;
    if (!hitting || !pitching) return null;

    let teamRecord: any = null;
    if (standingsData?.records) {
      for (const record of standingsData.records) {
        const found = record.teamRecords?.find((tr: any) => tr.team.id === teamId);
        if (found) {
          teamRecord = found;
          break;
        }
      }
    }
    if (!teamRecord) return null;

    const splitRecord = (type: string) => {
      const s = teamRecord.records?.splitRecords?.find((r: any) => r.type === type);
      return { wins: s?.wins ?? 0, losses: s?.losses ?? 0 };
    };
    const streakCode: string | undefined = teamRecord.streak?.streakCode;
    const streak =
      streakCode && /^[WL]\d+$/.test(streakCode)
        ? { type: streakCode[0] as "W" | "L", count: parseInt(streakCode.slice(1), 10) }
        : { type: null, count: 0 };

    return {
      wins: teamRecord.leagueRecord?.wins ?? 0,
      losses: teamRecord.leagueRecord?.losses ?? 0,
      winPct: parseFloat(teamRecord.leagueRecord?.pct ?? "0"),
      runsScored: teamRecord.runsScored ?? hitting.runs ?? 0,
      runsAllowed: teamRecord.runsAllowed ?? pitching.runs ?? 0,
      runDifferential: (teamRecord.runsScored ?? 0) - (teamRecord.runsAllowed ?? 0),
      battingAvg: parseFloat(hitting.avg ?? "0"),
      obp: parseFloat(hitting.obp ?? "0"),
      slg: parseFloat(hitting.slg ?? "0"),
      ops: parseFloat(hitting.ops ?? "0"),
      era: parseFloat(pitching.era ?? "0"),
      whip: parseFloat(pitching.whip ?? "0"),
      homeRecord: splitRecord("home"),
      awayRecord: splitRecord("away"),
      last10: splitRecord("lastTen"),
      streak,
    };
  } catch {
    return null;
  }
}

export type PitcherSeasonStats = {
  era: number;
  whip: number;
  strikeouts: number;
  walks: number;
  kbb: number;
  inningsPitched: number;
  homeEra: number | null;
  roadEra: number | null;
  daysRest: number | null;
};

// A pitcher's season line + home/road ERA split + days since their last
// appearance (derived from their own game log, not a direct API field).
export async function getPitcherSeasonStats(personId: number, referenceDate: Date = new Date()): Promise<PitcherSeasonStats | null> {
  const season = currentMlbSeason();
  try {
    const [seasonRes, splitRes, logRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${personId}/stats?stats=season&group=pitching&season=${season}`, {
        next: { revalidate: 3600 },
      }),
      fetch(
        `https://statsapi.mlb.com/api/v1/people/${personId}/stats?stats=statSplits&sitCodes=h,a&group=pitching&season=${season}`,
        { next: { revalidate: 3600 } }
      ),
      fetch(`https://statsapi.mlb.com/api/v1/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`, {
        next: { revalidate: 900 },
      }),
    ]);

    const seasonStat = seasonRes.ok ? (await seasonRes.json()).stats?.[0]?.splits?.[0]?.stat : null;
    if (!seasonStat) return null;

    const splitJson = splitRes.ok ? await splitRes.json() : null;
    const splits: any[] = splitJson?.stats?.[0]?.splits ?? [];
    const homeSplit = splits.find((s) => s.split?.code === "h")?.stat;
    const awaySplit = splits.find((s) => s.split?.code === "a")?.stat;

    const logJson = logRes.ok ? await logRes.json() : null;
    const appearances: any[] = logJson?.stats?.[0]?.splits ?? [];
    const lastAppearance = appearances
      .map((a) => new Date(a.date))
      .filter((d) => d.getTime() <= referenceDate.getTime())
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const daysRest = lastAppearance
      ? Math.round((referenceDate.getTime() - lastAppearance.getTime()) / 86400000)
      : null;

    return {
      era: parseFloat(seasonStat.era ?? "0"),
      whip: parseFloat(seasonStat.whip ?? "0"),
      strikeouts: seasonStat.strikeOuts ?? 0,
      walks: seasonStat.baseOnBalls ?? 0,
      kbb: seasonStat.baseOnBalls > 0 ? Math.round((seasonStat.strikeOuts / seasonStat.baseOnBalls) * 100) / 100 : 0,
      inningsPitched: parseFloat(seasonStat.inningsPitched ?? "0"),
      homeEra: homeSplit ? parseFloat(homeSplit.era ?? "0") : null,
      roadEra: awaySplit ? parseFloat(awaySplit.era ?? "0") : null,
      daysRest,
    };
  } catch {
    return null;
  }
}

// The scheduled probable starter for a specific game, if MLB has announced
// one yet (usually available a day or more ahead, but not guaranteed -
// returns null well in advance of most starters being set).
export async function getProbablePitcher(gamePk: string, side: "home" | "away"): Promise<{ id: number; name: string } | null> {
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`, { next: { revalidate: 900 } });
    if (!res.ok) return null;
    const data = await res.json();
    const pitcher = data.gameData?.probablePitchers?.[side];
    if (!pitcher?.id) return null;
    return { id: pitcher.id, name: pitcher.fullName };
  } catch {
    return null;
  }
}
