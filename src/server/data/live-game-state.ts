// The per-GAME live-state layer - distinct from getLiveScoresForSport
// (odds.ts), which is one batch scoreboard call per SPORT and carries no
// win-probability, base/out, or current-pitcher detail. Investigated for
// Phase 1 of the Command Center whitepaper: Game Pulse does no live fetching
// at all (it's historical-only), so nothing existing could be reused here -
// this is the architectural shift that investigation flagged as required.
//
// Built as reusable infrastructure, not single-purpose to Momentum: the
// dispatch shape (getLiveGameState(sportKey, gameId)) is the same
// one-function-per-sport pattern odds.ts already uses for scoreboards, so a
// future Pace indicator (or any other per-game feature) adds a sport here
// rather than standing up a second per-game fetch layer.
//
// Politeness / rate-limit posture for concurrent live games:
//  - Caching is keyed per GAME (cacheKeys.liveGameState), so N concurrent
//    live games poll independently and one slow/failing game never blocks
//    another's cache entry.
//  - Two cache layers, same shape as getLiveScoresForSport: memoizeWithTtl
//    (process-local, collapses a burst of near-simultaneous callers on one
//    warm instance) in front of unstable_cache (Next's Data Cache, shared
//    across the fleet) - so the whole app makes at most ~1 upstream request
//    per game per LIVE_GAME_STATE_TTL_SECONDS, independent of how many users
//    have that game's page open.
//  - A CircuitBreaker sits in front of the upstream fetch itself, shared
//    across every game (one flaky/down upstream affects all MLB games
//    equally, so one breaker instance is the right scope) - once it trips,
//    calls fail fast with CircuitOpenError instead of adding to load on a
//    struggling upstream.
//  - The route handler that calls this (api/live/momentum) additionally
//    enforces a per-user+game, per-user, and route-global RateLimiter
//    ceiling (see rate-limit.ts) as the hard backstop against a runaway
//    client poll loop - independent of this module's own caching.
import { unstable_cache } from "next/cache";
import { cacheKeys } from "@/lib/cache-keys";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { CircuitBreaker } from "@/lib/circuit-breaker";

// One normalized play from MLB Stats API's per-game winProbability feed -
// the single endpoint this reads, chosen because (verified live against a
// real completed game during the Phase 1 investigation) it already carries
// everything Momentum's factors need: win probability, running score,
// count/runners (base-out state), and the current matchup's pitcher - no
// second per-game fetch (e.g. feed/live) needed for a v1.
export type MlbWinProbabilityPlay = {
  atBatIndex: number;
  inning: number;
  isTopInning: boolean;
  homeWinProbability: number; // 0-100
  awayWinProbability: number; // 0-100
  homeScore: number;
  awayScore: number;
  outs: number;
  // Bases occupied AFTER this play resolved, derived from that play's own
  // runner movements (not a full inning-long reconstruction) - a reasonable
  // "current threat level" read for the base/out factor without needing a
  // second, heavier live-feed fetch.
  runnersOnBase: Array<"1B" | "2B" | "3B">;
  // The pitcher involved in this play's matchup - i.e. whichever team was
  // fielding at the time. Scanning backward for the most recent play a team
  // fielded (see mlb-momentum.ts's currentPitcherForTeam) is how each team's
  // own current/most-recent pitcher is resolved from this one array.
  currentPitcherId: number | null;
  currentPitcherName: string | null;
};

export type MlbLiveGameState = {
  gamePk: string;
  // Empty array (not null) both before first pitch and for a genuinely
  // wobbly upstream response - "no plays yet" and "couldn't parse the plays
  // we got" are both meaningfully "no live state available", never a crash.
  plays: MlbWinProbabilityPlay[];
  fetchedAt: Date;
};

function mlbWinProbabilityUrl(gamePk: string): string {
  return `https://statsapi.mlb.com/api/v1/game/${gamePk}/winProbability`;
}

// A game that hasn't started yet 404s on this endpoint (confirmed live) -
// that is "no plays yet", not an upstream failure, so it resolves to []
// rather than throwing (and therefore never trips the circuit breaker).
async function fetchMlbWinProbabilityRaw(gamePk: string): Promise<unknown[]> {
  const res = await fetch(mlbWinProbabilityUrl(gamePk));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`MLB winProbability ${res.status} for game ${gamePk}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function asBase(value: unknown): "1B" | "2B" | "3B" | null {
  return value === "1B" || value === "2B" || value === "3B" ? value : null;
}

// Exported so the acceptance test can lock this parsing down against real
// MLB Stats API response shapes (captured live during the Phase 1
// investigation) without needing a network call or the cache/breaker layers
// around it.
export function normalizePlay(raw: any): MlbWinProbabilityPlay | null {
  // homeTeamWinProbability/awayTeamWinProbability are the one pair of fields
  // every real play in this feed carries - anything missing them isn't a
  // usable play (defends against a malformed or partial upstream entry).
  if (typeof raw?.homeTeamWinProbability !== "number" || typeof raw?.awayTeamWinProbability !== "number") return null;

  const runnersOnBase: Array<"1B" | "2B" | "3B"> = Array.isArray(raw.runners)
    ? raw.runners
        .filter((r: any) => r?.movement?.isOut !== true)
        .map((r: any) => asBase(r?.movement?.end))
        .filter((b: "1B" | "2B" | "3B" | null): b is "1B" | "2B" | "3B" => b !== null)
    : [];

  return {
    atBatIndex: typeof raw.atBatIndex === "number" ? raw.atBatIndex : (raw.about?.atBatIndex ?? 0),
    inning: raw.about?.inning ?? 0,
    isTopInning: raw.about?.isTopInning === true,
    homeWinProbability: raw.homeTeamWinProbability,
    awayWinProbability: raw.awayTeamWinProbability,
    homeScore: typeof raw.result?.homeScore === "number" ? raw.result.homeScore : 0,
    awayScore: typeof raw.result?.awayScore === "number" ? raw.result.awayScore : 0,
    outs: typeof raw.count?.outs === "number" ? raw.count.outs : 0,
    runnersOnBase,
    currentPitcherId: typeof raw.matchup?.pitcher?.id === "number" ? raw.matchup.pitcher.id : null,
    currentPitcherName: raw.matchup?.pitcher?.fullName ?? null,
  };
}

// Shared across every game on purpose - see file header. 5 consecutive
// failures (any mix of games) opens it; a minute is long enough to ride out
// a brief MLB Stats API blip without every poller hammering a dead upstream
// for the whole cooldown.
const mlbWinProbabilityBreaker = new CircuitBreaker({
  name: "mlb-win-probability",
  failureThreshold: 5,
  cooldownMs: 60_000,
});

async function dispatchMlbLiveGameState(gamePk: string): Promise<MlbLiveGameState> {
  const raw = await mlbWinProbabilityBreaker.run(() => fetchMlbWinProbabilityRaw(gamePk));
  const plays = raw.map(normalizePlay).filter((p): p is MlbWinProbabilityPlay => p !== null);
  return { gamePk, plays, fetchedAt: new Date() };
}

// Live game state moves fast (a new play every 20-40s of real time) and this
// is read on every poll tick, so the TTL is short - matches the ~20-30s
// cadence the whitepaper calls for and the existing live-scores TTL's order
// of magnitude (odds.ts, LIVE_SCORES_TTL_SECONDS).
const LIVE_GAME_STATE_TTL_SECONDS = 20;

function dataCachedMlbLiveGameState(gamePk: string): Promise<MlbLiveGameState> {
  const key = cacheKeys.liveGameState("baseball_mlb", gamePk);
  const run = unstable_cache(() => dispatchMlbLiveGameState(gamePk), [key], {
    revalidate: LIVE_GAME_STATE_TTL_SECONDS,
    tags: [key],
  });
  return run().catch((err: unknown) => {
    // Same escape hatch as getLiveScoresForSport: outside a Next request
    // context (bare scripts, acceptance tests) unstable_cache has no
    // incremental cache to attach to and throws - fall back to calling
    // straight through rather than failing every non-request caller.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("incrementalCache")) return dispatchMlbLiveGameState(gamePk);
    throw err;
  });
}

export async function getMlbLiveGameState(gamePk: string): Promise<MlbLiveGameState> {
  return memoizeWithTtl(cacheKeys.liveGameState("baseball_mlb", gamePk), () => dataCachedMlbLiveGameState(gamePk), {
    ttlMs: LIVE_GAME_STATE_TTL_SECONDS * 1000,
  });
}

// Public dispatch entry point, mirroring dispatchLiveScoresForSport's
// one-function-per-sport shape in odds.ts. Only MLB is wired up (Task A's
// scope); every other sport returns null rather than a sport-specific empty
// shape, so a caller can tell "no live-state source exists for this sport
// yet" apart from "this MLB game has no plays yet" (empty array). Add a
// branch here - not a second dispatcher - when Pace or another sport's
// Momentum needs its own live-state source.
export async function getLiveGameState(sportKey: string, gameId: string): Promise<MlbLiveGameState | null> {
  if (sportKey === "baseball_mlb") return getMlbLiveGameState(gameId);
  return null;
}
