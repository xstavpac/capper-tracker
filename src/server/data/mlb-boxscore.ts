// MLB box-score extraction from the MLB Stats API
// (statsapi.mlb.com/api/v1/game/{gamePk}/boxscore) - the grading source for MLB player
// props. GameResult.externalId for MLB IS the gamePk (getMlbLiveScores), so no id mapping
// is needed. ESPN's MLB box score was ruled out: it has no total bases / doubles / triples
// per player (only H, AB, R, RBI, HR, BB, K), so TB could only be rebuilt from play-by-play.
//
// Layered like nhl-boxscore.ts: extractMlbBoxScore is a PURE transform of an already-fetched
// response (unit-tested against saved real fixtures, no network); fetchMlbBoxScore is the
// thin fetch wrapper.
//
// Verified 2026-09-30 against 238 final games (Sep 10-29, incl. the 4 Wild Card games):
//   - teams.{home,away}.players is keyed "ID<personId>" and lists the WHOLE active roster
//     (~26 a side): ~45% of entries have EMPTY stats.batting / stats.pitching objects - they
//     did not play. A player who played has stats.batting.atBats (etc.) defined.
//   - batting: hits, doubles, triples, homeRuns, totalBases, baseOnBalls, runs, rbi,
//     plateAppearances. totalBases always equals (H-2B-3B-HR) + 2*2B + 3*3B + 4*HR.
//   - pitching: strikeOuts, outs (== inningsPitched converted, e.g. "6.1" -> 19), gamesStarted.
//   - Pitchers who enter a game also carry a ZERO batting line (atBats 0, PA 0), so a batting line alone
//     does not make someone a hitter - see mlb-prop-grading.ts.
//   - 250 batters appear with plateAppearances 0 (defensive subs, pinch runners - 33 of them
//     scored or stole), 22 pitchers faced batters but recorded 0 outs.
//   - The boxscore carries no game status; fetchMlbBoxScore reads it from the schedule.
export type MlbBattingLine = {
  plateAppearances: number;
  atBats: number;
  hits: number;
  totalBases: number;
  homeRuns: number;
  walks: number;
  runs: number;
  rbis: number;
};

export type MlbPitchingLine = {
  gamesStarted: number;
  outs: number;
  strikeouts: number;
};

export type MlbBoxPlayer = {
  mlbPlayerId: string;
  playerName: string;
  team: string;
  // The Stats API box position (P, C, 1B..RF, DH, PH, PR) - per GAME, not the roster position.
  position: string;
  // null = no batting / pitching line in this game (did not bat / did not pitch).
  batting: MlbBattingLine | null;
  pitching: MlbPitchingLine | null;
};

export type MlbBoxScore = {
  // The schedule reports the game Final.
  isFinal: boolean;
  // Final AND both teams have at least one batting line and one pitching line. True absence
  // (a rostered player missing from the box entirely) only proves a did-not-play on a complete box.
  isComplete: boolean;
  homeTeam: string | null;
  awayTeam: string | null;
  players: MlbBoxPlayer[];
};

type RawStats = Record<string, unknown> | undefined;
type RawPlayer = {
  person?: { id?: number; fullName?: string };
  position?: { abbreviation?: string };
  stats?: { batting?: RawStats; pitching?: RawStats };
};
type RawTeam = { team?: { name?: string }; players?: Record<string, RawPlayer> };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function battingLine(s: RawStats): MlbBattingLine | null {
  // An empty {} (or a missing key) means no batting line. atBats + plateAppearances present
  // is the signal a real line exists; a pinch runner has atBats 0 but the keys are there.
  if (!s || typeof s.atBats !== "number" || typeof s.plateAppearances !== "number") return null;
  return {
    plateAppearances: num(s.plateAppearances),
    atBats: num(s.atBats),
    hits: num(s.hits),
    totalBases: num(s.totalBases),
    homeRuns: num(s.homeRuns),
    walks: num(s.baseOnBalls),
    runs: num(s.runs),
    rbis: num(s.rbi),
  };
}

function pitchingLine(s: RawStats): MlbPitchingLine | null {
  if (!s || typeof s.outs !== "number" || typeof s.strikeOuts !== "number") return null;
  return { gamesStarted: num(s.gamesStarted), outs: num(s.outs), strikeouts: num(s.strikeOuts) };
}

// Returns null when the response has no usable box score (missing teams/players, or no
// team name) - a changed Stats API shape must fail closed to "box score not available",
// never silently grade against a wrong field.
export function extractMlbBoxScore(boxResponse: unknown, isFinal: boolean): MlbBoxScore | null {
  const teams = (boxResponse as { teams?: { home?: RawTeam; away?: RawTeam } } | null)?.teams;
  if (!teams?.home?.players || !teams.away?.players) return null;
  const homeTeam = teams.home.team?.name;
  const awayTeam = teams.away.team?.name;
  if (!homeTeam || !awayTeam) return null;

  const players: MlbBoxPlayer[] = [];
  let populatedTeams = 0;
  for (const [teamName, raw] of [
    [homeTeam, teams.home],
    [awayTeam, teams.away],
  ] as [string, RawTeam][]) {
    let batters = 0;
    let pitchers = 0;
    for (const p of Object.values(raw.players ?? {})) {
      if (p.person?.id === undefined || !p.person.fullName) continue;
      const batting = battingLine(p.stats?.batting);
      const pitching = pitchingLine(p.stats?.pitching);
      if (batting) batters++;
      if (pitching) pitchers++;
      players.push({
        mlbPlayerId: String(p.person.id),
        playerName: p.person.fullName,
        team: teamName,
        position: p.position?.abbreviation ?? "",
        batting,
        pitching,
      });
    }
    if (batters > 0 && pitchers > 0) populatedTeams++;
  }
  if (players.length === 0) return null;

  return { isFinal, isComplete: isFinal && populatedTeams === 2, homeTeam, awayTeam, players };
}

// Two cheap calls in parallel: the box score, and the schedule row for its status (the box
// has none). Short revalidate so a box cached while the game was still finalizing can't pin
// "not final" - the 15-minute grade cron retries anyway.
export async function fetchMlbBoxScore(gamePk: string): Promise<MlbBoxScore | null> {
  try {
    const [boxRes, schedRes] = await Promise.all([
      fetch("https://statsapi.mlb.com/api/v1/game/" + gamePk + "/boxscore", { next: { revalidate: 300 } }),
      fetch("https://statsapi.mlb.com/api/v1/schedule?gamePk=" + gamePk, { next: { revalidate: 300 } }),
    ]);
    if (!boxRes.ok || !schedRes.ok) return null;
    const sched = (await schedRes.json()) as { dates?: { games?: { status?: { abstractGameState?: string } }[] }[] };
    const isFinal = sched.dates?.[0]?.games?.[0]?.status?.abstractGameState === "Final";
    return extractMlbBoxScore(await boxRes.json(), isFinal);
  } catch (err) {
    console.error("fetchMlbBoxScore: Stats API fetch failed for gamePk " + gamePk, err);
    return null;
  }
}
