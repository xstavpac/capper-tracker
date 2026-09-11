// The per-GAME live-state layer for NFL Momentum - the NFL sibling of
// live-game-state.ts's MLB implementation, kept as its own file rather than
// folded into that one (same "one function per sport rather than a generic
// dispatcher" precedent nfl-game-pulse.ts already follows relative to
// game-pulse.ts - each sport's live-state shape is different enough that a
// shared implementation would mean nullable-field sprawl, and this way NFL
// can change without risking MLB's already-shipped behavior).
//
// Verified live against a real in-progress NFL game (ESPN event 401872657,
// SF @ LAR, Week 1) before any of this was written - see the PR description
// for the raw response samples. Two field-name traps this file exists to
// avoid:
//   - NFL's win-probability field is `homeWinPercentage`, a 0..1 FRACTION.
//     MLB's `homeTeamWinProbability` is 0..100. Do not reuse MLB's threshold
//     constants against this without converting scale (nfl-momentum.ts does
//     the *100 conversion at the boundary, once).
//   - NFL games can end in a tie (`tiePercentage` can be nonzero), unlike
//     MLB - awayWinPercentage is never a field on this endpoint at all and
//     must be derived as 1 - home - tie, not assumed to be 1 - home.
//
// Two upstream fetches, not one (unlike MLB's single winProbability
// endpoint):
//   1. ESPN's summary endpoint - bundles win probability, every drive
//      (previous + current), and both teams' live boxscore stats
//      (turnovers, third-down, red-zone, total yards/drives, possession
//      time) in one call. This is the PRIMARY fetch and the only one
//      wrapped in the circuit breaker - if it's down, there is no momentum
//      signal at all, same as MLB's single endpoint.
//   2. The ESPN "core" API's per-competition `situation` sub-resource -
//      down/distance/yard line/red zone flag/timeouts. Confirmed via a
//      dedicated per-game resource
//      (sports.core.api.espn.com/.../competitions/{id}/situation), NOT the
//      full multi-game scoreboard payload, so this stays scoped to one
//      game. Best-effort: a failure here degrades the situation-dependent
//      factors to "unavailable" rather than failing the whole poll - it
//      feeds context only, not the win-probability trend the gauge itself
//      is built from. It does NOT carry current possession (confirmed by
//      the real response - no `possession` field on this sub-resource,
//      unlike the full scoreboard's per-event situation object); current
//      possession instead comes from the summary fetch's own
//      `drives.current.team`, so no second possession-specific call is
//      needed.
import { unstable_cache } from "next/cache";
import { cacheKeys } from "@/lib/cache-keys";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { CircuitBreaker } from "@/lib/circuit-breaker";

const NFL_SPORT_KEY = "americanfootball_nfl";

export type NflWinProbabilityPoint = {
  playId: string;
  homeWinPercentage: number; // 0..1
  tiePercentage: number; // 0..1
};

export type NflDriveSummary = {
  teamAbbreviation: string;
  // "PUNT" | "TOUCHDOWN" | "FIELD GOAL" | "INTERCEPTION" | ... - ESPN's own
  // short result string. null for a drive still in progress (drives.current
  // never has this).
  result: string | null;
  isScore: boolean;
  yards: number;
  offensivePlays: number;
};

// Parsed once here, at the boundary, so every consumer works with numbers -
// "7-12" (thirdDownEff/redZoneAttempts) and "33:50" (possessionTime) are
// ESPN's own display-string conventions, confirmed live, not documented.
export type NflTeamBoxscore = {
  turnovers: number | null;
  thirdDownMade: number | null;
  thirdDownAttempted: number | null;
  redZoneScores: number | null;
  redZoneAttempts: number | null;
  totalYards: number | null;
  totalDrives: number | null;
  possessionSeconds: number | null;
};

export type NflSituation = {
  down: number | null;
  distance: number | null;
  yardLine: number | null;
  isRedZone: boolean;
  homeTimeouts: number | null;
  awayTimeouts: number | null;
};

// Built for Pace's quarter-and-clock-aware trajectory math - the NFL analog
// of MLB's per-play inning/outs state (live-game-state.ts's
// MlbWinProbabilityPlay). Not consumed by any Momentum factor. Added here
// rather than a second per-game fetch because the summary response already
// carries this on every play (confirmed live - see normalizeGameClockPlay
// below): one summary fetch already made for win probability/drives/
// boxscore covers this too, so Pace needs no live poll of its own.
export type NflGameClockPlay = {
  playId: string;
  period: number;
  // Seconds remaining in the CURRENT period, parsed from the same "MM:SS"
  // display-string convention as possessionTime above (parseClockToSeconds).
  // null when it doesn't parse - kept (not dropped) since the play's score/
  // period are still usable for a fraction-complete estimate without a
  // clock reading, same graceful-degradation convention as the rest of this
  // file.
  clockSeconds: number | null;
  homeScore: number;
  awayScore: number;
};

export type NflLiveGameState = {
  eventId: string;
  // From the same summary fetch's header.competitions[0].competitors -
  // authoritative for THIS event, so the momentum engine never needs a
  // separate full-name -> abbreviation lookup table to split drives/boxscore
  // (both abbreviation-keyed) into home/away.
  homeAbbreviation: string | null;
  awayAbbreviation: string | null;
  wp: NflWinProbabilityPoint[];
  // The two most recently COMPLETED drives lists, home/away split by
  // ESPN's own homeAway competitor field elsewhere - drives themselves are
  // team-abbreviation-tagged (see NflDriveSummary), not home/away-tagged, so
  // the momentum engine does the home/away split itself against the
  // abbreviations the caller already knows.
  previousDrives: NflDriveSummary[];
  // Team abbreviation currently on offense - null once the game has no
  // current drive (pregame, or final). From drives.current.team, not the
  // situation sub-resource (see file header).
  possessionTeamAbbreviation: string | null;
  homeBoxscore: NflTeamBoxscore | null;
  awayBoxscore: NflTeamBoxscore | null;
  // null when the situation sub-resource couldn't be fetched/parsed -
  // degrades the situation-dependent factors, never the WP trend itself.
  situation: NflSituation | null;
  // Chronologically ordered: every previous drive's plays, then the current
  // (in-progress) drive's plays, if any - see dispatchNflLiveGameState. Used
  // by Pace only; empty (not null) before kickoff, same "no plays yet"
  // convention as `wp` above.
  clockPlays: NflGameClockPlay[];
  fetchedAt: Date;
};

function nflSummaryUrl(eventId: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`;
}

function nflSituationUrl(eventId: string): string {
  return `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/situation`;
}

// Exported so the acceptance test can lock this parsing down against real
// ESPN response shapes (captured live during the Phase 1 investigation and
// this build's own verification, see the PR description) without needing a
// network call or the cache/breaker layers around it.
export function normalizeWpPoint(raw: any): NflWinProbabilityPoint | null {
  if (typeof raw?.homeWinPercentage !== "number") return null;
  return {
    playId: typeof raw.playId === "string" ? raw.playId : String(raw.playId ?? ""),
    homeWinPercentage: raw.homeWinPercentage,
    tiePercentage: typeof raw.tiePercentage === "number" ? raw.tiePercentage : 0,
  };
}

export function normalizeDrive(raw: any): NflDriveSummary | null {
  const abbr = raw?.team?.abbreviation;
  if (typeof abbr !== "string") return null;
  return {
    teamAbbreviation: abbr,
    result: typeof raw.result === "string" ? raw.result : null,
    isScore: raw?.isScore === true,
    yards: typeof raw.yards === "number" ? raw.yards : 0,
    offensivePlays: typeof raw.offensivePlays === "number" ? raw.offensivePlays : 0,
  };
}

// "7-12" -> {made: 7, attempted: 12}. Returns nulls (not zeros) for
// anything that doesn't parse - a genuine 0-0 must stay distinguishable
// from "ESPN didn't send this stat".
function parseMadeAttempted(displayValue: unknown): { made: number | null; attempted: number | null } {
  if (typeof displayValue !== "string") return { made: null, attempted: null };
  const match = displayValue.match(/^(\d+)-(\d+)$/);
  if (!match) return { made: null, attempted: null };
  return { made: Number(match[1]), attempted: Number(match[2]) };
}

// "33:50" -> 2030 seconds. Same null-not-zero convention as above.
function parseClockToSeconds(displayValue: unknown): number | null {
  if (typeof displayValue !== "string") return null;
  const match = displayValue.match(/^(\d+):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function findStat(statistics: any[] | undefined, name: string): string | undefined {
  return statistics?.find((s: any) => s?.name === name)?.displayValue;
}

export function normalizeBoxscore(teamBox: any): NflTeamBoxscore | null {
  const stats = teamBox?.statistics;
  if (!Array.isArray(stats)) return null;
  const turnoversRaw = findStat(stats, "turnovers");
  const thirdDown = parseMadeAttempted(findStat(stats, "thirdDownEff"));
  const redZone = parseMadeAttempted(findStat(stats, "redZoneAttempts"));
  const totalYardsRaw = findStat(stats, "totalYards");
  const totalDrivesRaw = findStat(stats, "totalDrives");
  return {
    turnovers: turnoversRaw !== undefined && !Number.isNaN(Number(turnoversRaw)) ? Number(turnoversRaw) : null,
    thirdDownMade: thirdDown.made,
    thirdDownAttempted: thirdDown.attempted,
    // The stat named "redZoneAttempts" is labeled "Red Zone (Made-Att)" in
    // the same response (confirmed live) - its displayValue is
    // scores-made/trips-attempted, not attempts alone despite the field
    // name.
    redZoneScores: redZone.made,
    redZoneAttempts: redZone.attempted,
    totalYards: totalYardsRaw !== undefined && !Number.isNaN(Number(totalYardsRaw)) ? Number(totalYardsRaw) : null,
    totalDrives: totalDrivesRaw !== undefined && !Number.isNaN(Number(totalDrivesRaw)) ? Number(totalDrivesRaw) : null,
    possessionSeconds: parseClockToSeconds(findStat(stats, "possessionTime")),
  };
}

// Real play shape confirmed live (drives.previous[].plays[] and
// drives.current.plays[] share this shape): {"id":"4018726573916",
// "period":{"number":4},"clock":{"displayValue":"0:00"},"homeScore":7,
// "awayScore":27, ...}. Trimmed to what Pace reads.
export function normalizeGameClockPlay(raw: any): NflGameClockPlay | null {
  const idRaw = raw?.id;
  if (typeof idRaw !== "string" && typeof idRaw !== "number") return null;
  const period = raw?.period?.number;
  if (typeof period !== "number") return null;
  if (typeof raw?.homeScore !== "number" || typeof raw?.awayScore !== "number") return null;
  return {
    playId: String(idRaw),
    period,
    clockSeconds: parseClockToSeconds(raw?.clock?.displayValue),
    homeScore: raw.homeScore,
    awayScore: raw.awayScore,
  };
}

export function normalizeSituation(raw: any): NflSituation | null {
  if (!raw || raw.__status) return null;
  return {
    down: typeof raw.down === "number" ? raw.down : null,
    distance: typeof raw.distance === "number" ? raw.distance : null,
    yardLine: typeof raw.yardLine === "number" ? raw.yardLine : null,
    isRedZone: raw.isRedZone === true,
    homeTimeouts: typeof raw.homeTimeouts === "number" ? raw.homeTimeouts : null,
    awayTimeouts: typeof raw.awayTimeouts === "number" ? raw.awayTimeouts : null,
  };
}

async function fetchNflSummaryRaw(eventId: string): Promise<any> {
  const res = await fetch(nflSummaryUrl(eventId));
  if (!res.ok) throw new Error(`NFL summary ${res.status} for event ${eventId}`);
  return res.json();
}

// Best-effort - failures here never throw, they resolve to null so a flaky
// situation sub-resource can't take down the whole live-state fetch (see
// file header).
async function fetchNflSituation(eventId: string): Promise<NflSituation | null> {
  try {
    const res = await fetch(nflSituationUrl(eventId));
    if (!res.ok) return null;
    return normalizeSituation(await res.json());
  } catch {
    return null;
  }
}

// Own instance, not MLB's - a different upstream host (ESPN vs MLB
// StatsAPI) with its own independent health, so it must trip and recover
// independently. Same failureThreshold/cooldown as MLB's for now (no
// evidence yet either upstream needs different tuning).
const nflSummaryBreaker = new CircuitBreaker({
  name: "nfl-summary",
  failureThreshold: 5,
  cooldownMs: 60_000,
});

async function dispatchNflLiveGameState(eventId: string): Promise<NflLiveGameState> {
  const [summary, situation] = await Promise.all([
    nflSummaryBreaker.run(() => fetchNflSummaryRaw(eventId)),
    fetchNflSituation(eventId),
  ]);

  const wp: NflWinProbabilityPoint[] = Array.isArray(summary?.winprobability)
    ? summary.winprobability.map(normalizeWpPoint).filter((p: NflWinProbabilityPoint | null): p is NflWinProbabilityPoint => p !== null)
    : [];

  const previousDrives: NflDriveSummary[] = Array.isArray(summary?.drives?.previous)
    ? summary.drives.previous.map(normalizeDrive).filter((d: NflDriveSummary | null): d is NflDriveSummary => d !== null)
    : [];

  const possessionTeamAbbreviation: string | null =
    typeof summary?.drives?.current?.team?.abbreviation === "string" ? summary.drives.current.team.abbreviation : null;

  // Same summary payload drives/previous and drives/current already fetched
  // above for the momentum drive-success factor - flattened here in
  // chronological order (previous drives first, then the in-progress
  // current drive's own plays, if any) so the LAST entry is always the
  // game's most current known state (score/period/clock), the same
  // "latest play = current state" shape live-game-state.ts's MLB plays use.
  const clockPlayRaws: any[] = [
    ...(Array.isArray(summary?.drives?.previous) ? summary.drives.previous.flatMap((d: any) => (Array.isArray(d?.plays) ? d.plays : [])) : []),
    ...(Array.isArray(summary?.drives?.current?.plays) ? summary.drives.current.plays : []),
  ];
  const clockPlays: NflGameClockPlay[] = clockPlayRaws
    .map(normalizeGameClockPlay)
    .filter((p: NflGameClockPlay | null): p is NflGameClockPlay => p !== null);

  const boxscoreTeams = summary?.boxscore?.teams;
  const homeBox = Array.isArray(boxscoreTeams) ? boxscoreTeams.find((t: any) => t?.homeAway === "home") : undefined;
  const awayBox = Array.isArray(boxscoreTeams) ? boxscoreTeams.find((t: any) => t?.homeAway === "away") : undefined;

  const competitors = summary?.header?.competitions?.[0]?.competitors;
  const homeCompetitor = Array.isArray(competitors) ? competitors.find((c: any) => c?.homeAway === "home") : undefined;
  const awayCompetitor = Array.isArray(competitors) ? competitors.find((c: any) => c?.homeAway === "away") : undefined;

  return {
    eventId,
    homeAbbreviation: typeof homeCompetitor?.team?.abbreviation === "string" ? homeCompetitor.team.abbreviation : null,
    awayAbbreviation: typeof awayCompetitor?.team?.abbreviation === "string" ? awayCompetitor.team.abbreviation : null,
    wp,
    previousDrives,
    possessionTeamAbbreviation,
    homeBoxscore: normalizeBoxscore(homeBox),
    awayBoxscore: normalizeBoxscore(awayBox),
    situation,
    clockPlays,
    fetchedAt: new Date(),
  };
}

// Same TTL as MLB's live-game-state (20s) - matches the ~20-30s poll
// cadence both sports' panels use.
const NFL_LIVE_GAME_STATE_TTL_SECONDS = 20;

function dataCachedNflLiveGameState(eventId: string): Promise<NflLiveGameState> {
  const key = cacheKeys.liveGameState(NFL_SPORT_KEY, eventId);
  const run = unstable_cache(() => dispatchNflLiveGameState(eventId), [key], {
    revalidate: NFL_LIVE_GAME_STATE_TTL_SECONDS,
    tags: [key],
  });
  return run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("incrementalCache")) return dispatchNflLiveGameState(eventId);
    throw err;
  });
}

export async function getNflLiveGameState(eventId: string): Promise<NflLiveGameState> {
  return memoizeWithTtl(cacheKeys.liveGameState(NFL_SPORT_KEY, eventId), () => dataCachedNflLiveGameState(eventId), {
    ttlMs: NFL_LIVE_GAME_STATE_TTL_SECONDS * 1000,
  });
}
