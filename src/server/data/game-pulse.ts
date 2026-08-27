import type { ScoreGame, ScoreGameInning } from "@/server/data/odds";
import {
  SITUATIONAL_QUESTIONS,
  getTeamSituationalRates,
  inningsToRunsArrays,
  type SituationalQuestion,
  type SituationalRate,
  type SituationalRatesByQuestion,
} from "@/server/data/game-pulse-situations";

// Thresholds signed off on 2026-08-19 - see the investigation writeup this
// feature came out of. Not tunable via env/config for v1; change here and
// redeploy if they need revisiting.
const SAMPLE_SIZE_FLOOR = 10; // a team+situation needs this many historical GameResult rows before its rate counts at all
const SKEW_FLOOR_HIGH = 58; // win% at/above this favors the team that currently holds the situation
const SKEW_FLOOR_LOW = 42; // win% at/below this favors the OPPONENT of the team that currently holds the situation
const BADGE_MARGIN_MIN = 2; // net tally magnitude required before a badge shows at all
const BADGE_MIN_ELIGIBLE = 2; // minimum number of questions that must have cleared both floors above
const MAX_EVIDENCE = 4; // "the 3-4 strongest pieces of evidence" per the product spec

export type GamePulseEvidence = {
  questionKey: SituationalQuestion["key"];
  label: string;
  // Whose historical rate this evidence cites - the team that currently
  // holds the situation tonight, which is NOT always the leaning team (see
  // computeGamePulseFromRates: a team's own bad history in a situation they
  // hold can lean the badge toward their opponent instead). winPct/sampleSize
  // are always about subjectTeam, so a low winPct here reads as bad news for
  // subjectTeam regardless of which side the badge ultimately favors.
  subjectTeam: string;
  winPct: number;
  sampleSize: number;
};

export type GamePulseResult = {
  leaningTeam: string;
  margin: number;
  evidence: GamePulseEvidence[];
};

type PulseGame = { homeTeam: string; awayTeam: string; innings: ScoreGameInning[] | null };

type Contribution = {
  question: SituationalQuestion;
  creditedSide: "home" | "away";
  holderTeam: string;
  rate: SituationalRate;
};

// Pure tally logic - no I/O, so this is the part real-data verification and
// the acceptance test actually exercise directly. Evaluates all 5 fixed
// questions against the game's current innings, credits each eligible one
// to whichever side its historical rate actually favors (see
// SKEW_FLOOR_HIGH/LOW above - that's not always the side currently holding
// the situation), and returns null ("too close to call" = silence) unless
// the tally clears both the margin and eligible-question floors.
export function computeGamePulseFromRates(game: PulseGame, homeRates: SituationalRatesByQuestion, awayRates: SituationalRatesByQuestion): GamePulseResult | null {
  if (!game.innings || game.innings.length === 0) return null;
  const { homeRuns, awayRuns } = inningsToRunsArrays(game.innings);

  const tally = { home: 0, away: 0 };
  const contributions: Contribution[] = [];

  for (const question of SITUATIONAL_QUESTIONS) {
    const holder = question.evaluate(homeRuns, awayRuns);
    if (holder === null) continue;

    const holderTeam = holder === "home" ? game.homeTeam : game.awayTeam;
    const rate = (holder === "home" ? homeRates : awayRates)[question.key];
    if (rate.total < SAMPLE_SIZE_FLOOR) continue;

    if (rate.winPct >= SKEW_FLOOR_HIGH) {
      tally[holder]++;
      contributions.push({ question, creditedSide: holder, holderTeam, rate });
    } else if (rate.winPct <= SKEW_FLOOR_LOW) {
      const opponent: "home" | "away" = holder === "home" ? "away" : "home";
      tally[opponent]++;
      contributions.push({ question, creditedSide: opponent, holderTeam, rate });
    }
    // else: win% is a coin flip for this team+situation - not eligible, skip
  }

  const eligibleCount = tally.home + tally.away;
  const margin = Math.abs(tally.home - tally.away);
  if (eligibleCount < BADGE_MIN_ELIGIBLE || margin < BADGE_MARGIN_MIN) return null;

  const leaningSide: "home" | "away" = tally.home > tally.away ? "home" : "away";
  const evidence = contributions
    .filter((c) => c.creditedSide === leaningSide)
    .sort((a, b) => Math.abs(b.rate.winPct - 50) - Math.abs(a.rate.winPct - 50))
    .slice(0, MAX_EVIDENCE)
    .map((c) => ({
      questionKey: c.question.key,
      label: c.question.label,
      subjectTeam: c.holderTeam,
      winPct: Math.round(c.rate.winPct),
      sampleSize: c.rate.total,
    }));

  return {
    leaningTeam: leaningSide === "home" ? game.homeTeam : game.awayTeam,
    margin,
    evidence,
  };
}

// Per-team situational rates barely change poll to poll (they only move
// when persistFinalScores grades a new game), so re-querying GameResult on
// every 25s /live poll for every team in every live MLB game is pure waste.
// Cached in module scope, same "survives warm serverless invocations, reset
// on a cold one" reasoning lib/prisma.ts already relies on for its
// singleton client - a cold-start cache miss just recomputes, it's a cost
// optimization, not a correctness dependency.
const RATE_CACHE_TTL_MS = 60 * 60 * 1000;
const rateCache = new Map<string, { value: SituationalRatesByQuestion; expiresAt: number }>();

async function getCachedTeamRates(team: string): Promise<SituationalRatesByQuestion> {
  const cached = rateCache.get(team);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getTeamSituationalRates(team);
  rateCache.set(team, { value, expiresAt: Date.now() + RATE_CACHE_TTL_MS });
  return value;
}

export async function computeGamePulse(game: PulseGame): Promise<GamePulseResult | null> {
  if (!game.innings || game.innings.length === 0) return null;
  const [homeRates, awayRates] = await Promise.all([getCachedTeamRates(game.homeTeam), getCachedTeamRates(game.awayTeam)]);
  return computeGamePulseFromRates(game, homeRates, awayRates);
}

// Hooks into the /live poll cycle already running (see
// src/app/api/live/scores/route.ts) instead of adding a new timer - pulse is
// computed fresh on each existing poll response, MLB-only in practice since
// computeGamePulse immediately returns null for any game without innings
// data (every non-MLB sport, see getMlbLiveScores vs getEspnScores), and
// live-only since a finished/upcoming game isn't what this badge is for.
export async function attachGamePulse(games: ScoreGame[]): Promise<(ScoreGame & { pulse: GamePulseResult | null })[]> {
  return Promise.all(
    games.map(async (g) => ({
      ...g,
      pulse: g.status === "live" ? await computeGamePulse(g) : null,
    }))
  );
}
