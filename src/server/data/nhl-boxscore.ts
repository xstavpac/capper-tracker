// NHL box-score extraction from ESPN's summary endpoint
// (site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event={id}) - the
// grading source for NHL player props. `event` is GameResult.externalId (ESPN's
// own event id), so no id mapping is needed.
//
// Layered like nfl-passer-rows.ts: extractNhlBoxScore is a PURE transform of an
// already-fetched response (unit-tested against saved fixtures, no network);
// fetchNhlBoxScore is the thin fetch wrapper.
//
// Verified against 58 completed 2026 preseason games (2026-09-30):
//   - boxscore.players[team].statistics[] has groups forwards / defenses /
//     skaters (empty) / goalies, each with `labels` and per-athlete `stats[]`
//     indexed by those labels. Columns are read BY LABEL, never by position.
//   - "G" goals, "A" assists, "S" SHOTS ON GOAL, "SV" saves. Do NOT read the
//     "SOG" label: in ESPN's NHL box score that column is SHOOTOUT GOALS and is
//     0 for everyone in a normal game. Shots on goal is "S" (its per-team sum
//     equals the opposing goalies' SA in 47/58 games; see the PR note on the
//     other 11, all off by exactly one - trusting skater S).
//   - Box-score G and S exclude shootout attempts (verified in a shootout game:
//     G sums to regulation+OT goals only), but the shootout-winning goal DOES
//     appear in plays[] as scoringPlay:true in period 5. First-goal ordering
//     therefore only considers periods <= 4.
//   - Player ids here equal the roster endpoint ids (nhl-roster.ts).
//   - A player who did not dress/play is simply absent (no zero row).
export type NhlSkaterRow = {
  espnPlayerId: string;
  playerName: string;
  team: string;
  goals: number;
  assists: number;
  shotsOnGoal: number;
};

export type NhlGoalieRow = {
  espnPlayerId: string;
  playerName: string;
  team: string;
  saves: number;
  shotsAgainst: number;
  goalsAgainst: number;
};

export type NhlGoal = {
  sequence: number;
  period: number;
  scorerId: string | null;
  scorerName: string | null;
  team: string | null; // ESPN team id of the scoring team
};

export type NhlBoxScore = {
  // The event reported completed (status.type.completed).
  isFinal: boolean;
  // Final AND both teams have populated skater AND goalie groups. The did-not-play
  // push in nhl-prop-grading.ts requires this: absence from a partial box score
  // proves nothing.
  isComplete: boolean;
  homeTeam: string | null;
  awayTeam: string | null;
  skaters: NhlSkaterRow[];
  goalies: NhlGoalieRow[];
  // Scoring plays in periods 1-4 (regulation + OT; shootout excluded), ordered by
  // sequenceNumber.
  goals: NhlGoal[];
};

function toInt(v: string | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

type EspnGroup = {
  name?: string;
  labels?: string[];
  athletes?: { athlete?: { id?: string; displayName?: string }; stats?: string[] }[];
};

// Returns null when the response has no usable box score at all (missing
// boxscore.players, or a group whose expected label columns are absent - a
// changed ESPN shape must fail closed to "box score not available", never
// silently grade against a wrong column).
export function extractNhlBoxScore(espnSummaryResponse: unknown): NhlBoxScore | null {
  const data = espnSummaryResponse as {
    boxscore?: { players?: { team?: { id?: string; displayName?: string }; statistics?: EspnGroup[] }[] };
    plays?: {
      sequenceNumber?: string | number;
      scoringPlay?: boolean;
      period?: { number?: number };
      team?: { id?: string };
      participants?: { type?: string; athlete?: { id?: string; displayName?: string } }[];
    }[];
    header?: { competitions?: { status?: { type?: { completed?: boolean } }; competitors?: { homeAway?: string; team?: { displayName?: string } }[] }[] };
  } | null;
  const teams = data?.boxscore?.players;
  if (!Array.isArray(teams) || teams.length === 0) return null;

  const skaters: NhlSkaterRow[] = [];
  const goalies: NhlGoalieRow[] = [];
  let populatedTeams = 0;

  for (const t of teams) {
    const teamName = t.team?.displayName;
    if (!teamName) return null;
    let teamSkaters = 0;
    let teamGoalies = 0;
    for (const group of t.statistics ?? []) {
      const labels = group.labels ?? [];
      const athletes = group.athletes ?? [];
      if (athletes.length === 0) continue;
      if (group.name === "goalies") {
        const iSV = labels.indexOf("SV");
        const iSA = labels.indexOf("SA");
        const iGA = labels.indexOf("GA");
        if (iSV < 0) return null;
        for (const a of athletes) {
          if (!a.athlete?.id || !a.athlete.displayName) continue;
          goalies.push({
            espnPlayerId: a.athlete.id,
            playerName: a.athlete.displayName,
            team: teamName,
            saves: toInt(a.stats?.[iSV]),
            shotsAgainst: iSA >= 0 ? toInt(a.stats?.[iSA]) : 0,
            goalsAgainst: iGA >= 0 ? toInt(a.stats?.[iGA]) : 0,
          });
          teamGoalies++;
        }
      } else {
        // forwards / defenses / skaters: "S" is shots on goal - never "SOG" (shootout goals).
        const iG = labels.indexOf("G");
        const iA = labels.indexOf("A");
        const iS = labels.indexOf("S");
        if (iG < 0 || iA < 0 || iS < 0) return null;
        for (const a of athletes) {
          if (!a.athlete?.id || !a.athlete.displayName) continue;
          skaters.push({
            espnPlayerId: a.athlete.id,
            playerName: a.athlete.displayName,
            team: teamName,
            goals: toInt(a.stats?.[iG]),
            assists: toInt(a.stats?.[iA]),
            shotsOnGoal: toInt(a.stats?.[iS]),
          });
          teamSkaters++;
        }
      }
    }
    if (teamSkaters > 0 && teamGoalies > 0) populatedTeams++;
  }

  const comp = data?.header?.competitions?.[0];
  const isFinal = comp?.status?.type?.completed === true;
  const home = comp?.competitors?.find((c) => c.homeAway === "home")?.team?.displayName ?? null;
  const away = comp?.competitors?.find((c) => c.homeAway === "away")?.team?.displayName ?? null;

  const goals: NhlGoal[] = (data?.plays ?? [])
    .filter((p) => p.scoringPlay === true && (p.period?.number ?? 99) <= 4)
    .map((p) => {
      const scorer = p.participants?.find((x) => x.type === "scorer")?.athlete;
      return {
        sequence: Number(p.sequenceNumber),
        period: p.period?.number ?? 0,
        scorerId: scorer?.id ?? null,
        scorerName: scorer?.displayName ?? null,
        team: p.team?.id ?? null,
      };
    })
    .sort((a, b) => a.sequence - b.sequence);

  return {
    isFinal,
    isComplete: isFinal && teams.length === 2 && populatedTeams === 2,
    homeTeam: home,
    awayTeam: away,
    skaters,
    goalies,
    goals,
  };
}

// Same URL/host pattern as the NFL box-score fetches. Revalidate is short (5 min,
// not the NFL 1h): a box score cached while ESPN was still finalizing would
// otherwise pin "not complete" for an hour; the 15-minute grade cron retries.
export async function fetchNhlBoxScore(eventId: string): Promise<NhlBoxScore | null> {
  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=" + eventId, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return extractNhlBoxScore(await res.json());
  } catch (err) {
    console.error("fetchNhlBoxScore: ESPN summary fetch failed for event " + eventId, err);
    return null;
  }
}
