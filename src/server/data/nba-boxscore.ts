// NBA box-score extraction from ESPN's summary endpoint
// (site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}) - the
// grading source for NBA player props. `event` is GameResult.externalId (ESPN's
// own event id), so no id mapping is needed. The NBA twin of nhl-boxscore.ts.
//
// Layered the same way: extractNbaBoxScore is a PURE transform of an
// already-fetched response (unit-tested against saved fixtures, no network);
// fetchNbaBoxScore is the thin fetch wrapper.
//
// Verified live against 21 completed 2026 preseason games (2026-10-10 .. 10-13):
//   - boxscore.players[team].statistics[] is ONE unnamed group per team, with
//     `keys` (minutes, points, ..., rebounds, assists, turnovers, steals,
//     blocks, ...) and per-athlete `stats[]` indexed by them. Columns are read
//     BY KEY, never by position.
//   - Threes made is the left half of "threePointFieldGoalsMade-threePointFieldGoalsAttempted"
//     ("4-10" -> 4).
//   - Unlike the NHL, a player who did not play is LISTED: didNotPlay: true,
//     stats: [] and a reason ("COACH'S DECISION", "DID NOT DRESS", an injury).
//     A player can also be absent altogether. Both are handled by the grader's
//     did-not-play rule (nba-prop-grading.ts).
//   - Athlete ids equal the roster endpoint ids (nba-roster.ts; proved in
//     nba-roster-acceptance-test.ts PART B).
export type NbaPlayerRow = {
  espnPlayerId: string;
  playerName: string;
  team: string;
  // Listed with didNotPlay: true (and no stats). Every stat below is 0 then.
  didNotPlay: boolean;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  threesMade: number;
};

export type NbaBoxScore = {
  // The event reported completed (status.type.completed).
  isFinal: boolean;
  // Final AND both teams have at least one player with stats. The did-not-play
  // push in nba-prop-grading.ts requires this: absence from a partial box score
  // proves nothing.
  isComplete: boolean;
  homeTeam: string | null;
  awayTeam: string | null;
  players: NbaPlayerRow[];
};

function toInt(v: string | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

type EspnGroup = {
  keys?: string[];
  athletes?: { athlete?: { id?: string; displayName?: string }; didNotPlay?: boolean; stats?: string[] }[];
};

const REQUIRED_KEYS = ["points", "rebounds", "assists", "steals", "blocks", "turnovers", "threePointFieldGoalsMade-threePointFieldGoalsAttempted"] as const;

// Returns null when the response has no usable box score at all (missing
// boxscore.players, or a group whose expected key columns are absent - a
// changed ESPN shape must fail closed to "box score not available", never
// silently grade against a wrong column).
export function extractNbaBoxScore(espnSummaryResponse: unknown): NbaBoxScore | null {
  const data = espnSummaryResponse as {
    boxscore?: { players?: { team?: { displayName?: string }; statistics?: EspnGroup[] }[] };
    header?: { competitions?: { status?: { type?: { completed?: boolean } }; competitors?: { homeAway?: string; team?: { displayName?: string } }[] }[] };
  } | null;
  const teams = data?.boxscore?.players;
  if (!Array.isArray(teams) || teams.length === 0) return null;

  const players: NbaPlayerRow[] = [];
  let populatedTeams = 0;

  for (const t of teams) {
    const teamName = t.team?.displayName;
    if (!teamName) return null;
    let played = 0;
    for (const group of t.statistics ?? []) {
      const athletes = group.athletes ?? [];
      if (athletes.length === 0) continue;
      const keys = group.keys ?? [];
      const [iPts, iReb, iAst, iStl, iBlk, iTo, i3] = REQUIRED_KEYS.map((k) => keys.indexOf(k));
      if ([iPts, iReb, iAst, iStl, iBlk, iTo, i3].some((i) => i < 0)) return null;
      for (const a of athletes) {
        if (!a.athlete?.id || !a.athlete.displayName) continue;
        const stats = a.stats ?? [];
        // ESPN's flag, or a row with no stat line at all: both mean no minutes.
        const didNotPlay = a.didNotPlay === true || stats.length === 0;
        players.push({
          espnPlayerId: a.athlete.id,
          playerName: a.athlete.displayName,
          team: teamName,
          didNotPlay,
          points: didNotPlay ? 0 : toInt(stats[iPts]),
          rebounds: didNotPlay ? 0 : toInt(stats[iReb]),
          assists: didNotPlay ? 0 : toInt(stats[iAst]),
          steals: didNotPlay ? 0 : toInt(stats[iStl]),
          blocks: didNotPlay ? 0 : toInt(stats[iBlk]),
          turnovers: didNotPlay ? 0 : toInt(stats[iTo]),
          threesMade: didNotPlay ? 0 : toInt(stats[i3]?.split("-")[0]),
        });
        if (!didNotPlay) played++;
      }
    }
    if (played > 0) populatedTeams++;
  }

  const comp = data?.header?.competitions?.[0];
  const isFinal = comp?.status?.type?.completed === true;
  const home = comp?.competitors?.find((c) => c.homeAway === "home")?.team?.displayName ?? null;
  const away = comp?.competitors?.find((c) => c.homeAway === "away")?.team?.displayName ?? null;

  return {
    isFinal,
    isComplete: isFinal && teams.length === 2 && populatedTeams === 2,
    homeTeam: home,
    awayTeam: away,
    players,
  };
}

// Same URL/host pattern and 5-minute revalidate as fetchNhlBoxScore: a box score
// cached while ESPN was still finalizing would otherwise pin "not complete" for
// longer than the 15-minute grade cron's retry.
export async function fetchNbaBoxScore(eventId: string): Promise<NbaBoxScore | null> {
  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + eventId, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return extractNbaBoxScore(await res.json());
  } catch (err) {
    console.error("fetchNbaBoxScore: ESPN summary fetch failed for event " + eventId, err);
    return null;
  }
}
