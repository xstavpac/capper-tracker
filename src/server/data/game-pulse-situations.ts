import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { ScoreGameInning } from "@/server/data/odds";

// The fixed list of situational questions Game Pulse tallies (see VISION.md-
// adjacent investigation: this is deliberately NOT an AI-interpreted or
// open-ended stat set - each question is hand-picked and answered by a pure
// function over a game's per-inning runs). Adding a new question later means
// adding one entry here, nothing else in this file changes.
export type SituationalQuestionKey = "scoredFirst" | "leadingAfter5" | "leadingAfter7" | "bigInning" | "trailingAfter7";

export type SituationalQuestion = {
  key: SituationalQuestionKey;
  label: string;
  // Given a game's per-inning runs in inning order (starting at inning 1,
  // index 0), returns which side currently holds this situation - "home",
  // "away", or null if the situation doesn't (yet, for a live game) apply to
  // either side. A null entry in a runs array means that half-inning hasn't
  // been played yet - callers must not treat it as 0.
  evaluate: (homeRuns: (number | null)[], awayRuns: (number | null)[]) => "home" | "away" | null;
};

const BIG_INNING_RUN_THRESHOLD = 3;

function sumThroughInning(runs: (number | null)[], inningNumber: number): number | null {
  let sum = 0;
  for (let i = 0; i < inningNumber; i++) {
    const r = runs[i];
    if (r === null || r === undefined) return null;
    sum += r;
  }
  return sum;
}

// Chronological scan: within a single inning, the away team always bats
// first (top half) and home bats second (bottom half) - so "who scored
// first" is decided by walking innings in order and checking away-then-home
// at each one, stopping as soon as an unplayed half is reached (can't look
// past it without skipping ahead of what's actually happened yet).
function scoredFirst(homeRuns: (number | null)[], awayRuns: (number | null)[]): "home" | "away" | null {
  const inningCount = Math.max(homeRuns.length, awayRuns.length);
  for (let i = 0; i < inningCount; i++) {
    const away = awayRuns[i];
    if (away === null || away === undefined) return null;
    if (away > 0) return "away";

    const home = homeRuns[i];
    if (home === null || home === undefined) return null;
    if (home > 0) return "home";
  }
  return null;
}

function leadingAfter(inningNumber: number) {
  return (homeRuns: (number | null)[], awayRuns: (number | null)[]): "home" | "away" | null => {
    const homeSum = sumThroughInning(homeRuns, inningNumber);
    const awaySum = sumThroughInning(awayRuns, inningNumber);
    if (homeSum === null || awaySum === null || homeSum === awaySum) return null;
    return homeSum > awaySum ? "home" : "away";
  };
}

function trailingAfter(inningNumber: number) {
  return (homeRuns: (number | null)[], awayRuns: (number | null)[]): "home" | "away" | null => {
    const homeSum = sumThroughInning(homeRuns, inningNumber);
    const awaySum = sumThroughInning(awayRuns, inningNumber);
    if (homeSum === null || awaySum === null || homeSum === awaySum) return null;
    return homeSum < awaySum ? "home" : "away";
  };
}

// Whichever side reaches the threshold in a single half-inning first,
// scanning chronologically (same away-then-home ordering as scoredFirst) -
// keeps the result single-valued like every other question here, rather
// than a set of qualifying innings.
function bigInning(homeRuns: (number | null)[], awayRuns: (number | null)[]): "home" | "away" | null {
  const inningCount = Math.max(homeRuns.length, awayRuns.length);
  for (let i = 0; i < inningCount; i++) {
    const away = awayRuns[i];
    if (away !== null && away !== undefined && away >= BIG_INNING_RUN_THRESHOLD) return "away";
    const home = homeRuns[i];
    if (home !== null && home !== undefined && home >= BIG_INNING_RUN_THRESHOLD) return "home";
  }
  return null;
}

export const SITUATIONAL_QUESTIONS: SituationalQuestion[] = [
  { key: "scoredFirst", label: "scored first", evaluate: scoredFirst },
  { key: "leadingAfter5", label: "leading after 5", evaluate: leadingAfter(5) },
  { key: "leadingAfter7", label: "leading after 7", evaluate: leadingAfter(7) },
  { key: "bigInning", label: "had a " + BIG_INNING_RUN_THRESHOLD + "+ run inning", evaluate: bigInning },
  { key: "trailingAfter7", label: "trailing after 7", evaluate: trailingAfter(7) },
];

export type SituationalRate = { wins: number; total: number; winPct: number };

function inningsToRunsArrays(innings: ScoreGameInning[]): { homeRuns: (number | null)[]; awayRuns: (number | null)[] } {
  const sorted = [...innings].sort((a, b) => a.num - b.num);
  return {
    homeRuns: sorted.map((i) => i.home?.runs ?? null),
    awayRuns: sorted.map((i) => i.away?.runs ?? null),
  };
}

// Team's historical win rate in MLB games (any season captured so far) where
// `questionKey`'s situation held true for them specifically - e.g. for
// "leadingAfter5", only games this team was actually ahead after 5 count
// toward wins/total, not every game they played. Draws only from
// GameResult rows with inningsJson set (see persistFinalScores) - rows
// predating that field, and every non-MLB sport, are silently excluded, so
// the eligible sample starts at 0 and grows as games are graded going
// forward. Returns { wins: 0, total: 0, winPct: 0 } rather than null when no
// eligible games exist yet - callers apply their own minimum-sample-size
// floor before treating a rate as meaningful.
export async function getTeamSituationalRate(team: string, questionKey: SituationalQuestionKey): Promise<SituationalRate> {
  const question = SITUATIONAL_QUESTIONS.find((q) => q.key === questionKey);
  if (!question) return { wins: 0, total: 0, winPct: 0 };

  const rows = await prisma.gameResult.findMany({
    where: {
      sportKey: "baseball_mlb",
      inningsJson: { not: Prisma.DbNull },
      OR: [{ homeTeam: team }, { awayTeam: team }],
    },
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, inningsJson: true },
  });

  let wins = 0;
  let total = 0;
  for (const row of rows) {
    const isHome = row.homeTeam === team;
    const innings = (row.inningsJson as unknown as ScoreGameInning[] | null) ?? [];
    const { homeRuns, awayRuns } = inningsToRunsArrays(innings);
    const holder = question.evaluate(homeRuns, awayRuns);
    if (holder === null || holder !== (isHome ? "home" : "away")) continue;

    total++;
    const teamScore = isHome ? row.homeScore : row.awayScore;
    const oppScore = isHome ? row.awayScore : row.homeScore;
    if (teamScore > oppScore) wins++;
  }

  return total === 0 ? { wins: 0, total: 0, winPct: 0 } : { wins, total, winPct: (wins / total) * 100 };
}
