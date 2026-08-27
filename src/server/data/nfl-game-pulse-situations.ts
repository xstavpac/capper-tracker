import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { SituationalRate } from "@/server/data/game-pulse-situations";

// The fixed list of situational questions NFL Game Pulse tallies - same
// "hand-picked, answered by a pure function over captured game data" design
// as MLB's SITUATIONAL_QUESTIONS (game-pulse-situations.ts), but football-
// specific rather than a mechanical port of MLB's innings-based ones: NFL
// has no equivalent to "away always bats first within an inning" to derive
// scoring order from quarter totals alone, and needed its own data capture
// (quartersJson/scoringPlaysJson/turnovers on GameResult, see
// getNflGameFacts in odds.ts) to answer these at all. Confirmed feasible
// against 8 real finished 2026 preseason games before building this - see
// the NFL Game Pulse data-feasibility investigation.
export type NflSituationalQuestionKey =
  | "scoredFirst"
  | "leadingAtHalftime"
  | "wonTurnoverBattle"
  | "ledByDoubleDigits"
  | "trailingEntering4th";

// The raw per-game data getNflGameFacts captures and GameResult persists -
// each question's evaluate() reads only the piece(s) it needs, so a row
// missing one field (e.g. an older row captured before scoringPlaysJson
// existed) still answers whichever questions its available fields support.
export type NflGameRawFacts = {
  quarters: { home: number; away: number }[] | null;
  scoringPlays: { home: number; away: number }[] | null;
  homeTurnovers: number | null;
  awayTurnovers: number | null;
};

export type NflSituationalQuestion = {
  key: NflSituationalQuestionKey;
  // Present tense, written to read naturally after "when they " - same
  // convention as MLB's SituationalQuestion.label, though nothing currently
  // renders it (the panel uses its own fixed row titles, see nfl-game-pulse.ts).
  label: string;
  evaluate: (facts: NflGameRawFacts) => "home" | "away" | null;
};

const DOUBLE_DIGIT_MARGIN = 10;

// scoringPlays' first entry is, by construction, the moment either
// team's running score first left 0-0 - exactly one of home/away is
// nonzero there (only one team can score on a single play), so no
// chronological-ordering assumption beyond "the array is already in game
// order" (confirmed against 8 real games) is needed here.
function scoredFirst(facts: NflGameRawFacts): "home" | "away" | null {
  const plays = facts.scoringPlays;
  if (!plays || plays.length === 0) return null;
  const first = plays[0];
  if (first.home > 0 && first.away === 0) return "home";
  if (first.away > 0 && first.home === 0) return "away";
  return null;
}

function leadingAtHalftime(facts: NflGameRawFacts): "home" | "away" | null {
  const q = facts.quarters;
  if (!q || q.length < 2) return null;
  const home = q[0].home + q[1].home;
  const away = q[0].away + q[1].away;
  if (home === away) return null;
  return home > away ? "home" : "away";
}

// Mirrors leadingAtHalftime but through Q3 and inverted (behind, not
// ahead) - same "trailing" framing as MLB's trailingAfter7, just fixed at
// exactly 3 quarters rather than a parameterized inning count, since NFL
// always has exactly 4 regulation quarters (no "5 or 7 of how many"
// ambiguity the way MLB's inning count varies by game).
function trailingEntering4th(facts: NflGameRawFacts): "home" | "away" | null {
  const q = facts.quarters;
  if (!q || q.length < 3) return null;
  const home = q[0].home + q[1].home + q[2].home;
  const away = q[0].away + q[1].away + q[2].away;
  if (home === away) return null;
  return home < away ? "home" : "away";
}

function wonTurnoverBattle(facts: NflGameRawFacts): "home" | "away" | null {
  if (facts.homeTurnovers === null || facts.awayTurnovers === null) return null;
  if (facts.homeTurnovers === facts.awayTurnovers) return null;
  return facts.homeTurnovers < facts.awayTurnovers ? "home" : "away";
}

// Scans scoringPlays chronologically and returns whichever side's margin
// reaches DOUBLE_DIGIT_MARGIN FIRST - same "first side to reach the
// threshold, not whichever led by more at any single point" convention as
// MLB's bigInning question. A game where the margin swings past double
// digits for BOTH sides at different points (a real comeback) still
// resolves to a single side this way, matching the single-valued shape
// every other question here returns.
function ledByDoubleDigits(facts: NflGameRawFacts): "home" | "away" | null {
  const plays = facts.scoringPlays;
  if (!plays) return null;
  for (const p of plays) {
    const margin = p.home - p.away;
    if (margin >= DOUBLE_DIGIT_MARGIN) return "home";
    if (-margin >= DOUBLE_DIGIT_MARGIN) return "away";
  }
  return null;
}

export const NFL_SITUATIONAL_QUESTIONS: NflSituationalQuestion[] = [
  { key: "scoredFirst", label: "score first", evaluate: scoredFirst },
  { key: "leadingAtHalftime", label: "lead at halftime", evaluate: leadingAtHalftime },
  { key: "wonTurnoverBattle", label: "win the turnover battle", evaluate: wonTurnoverBattle },
  { key: "ledByDoubleDigits", label: "lead by double digits", evaluate: ledByDoubleDigits },
  { key: "trailingEntering4th", label: "trail entering the 4th", evaluate: trailingEntering4th },
];

export type NflSituationalRatesByQuestion = Record<NflSituationalQuestionKey, SituationalRate>;

// Team's historical win rate in NFL games (any season captured so far),
// broken out per situational question - same shape and semantics as MLB's
// getTeamSituationalRates. Draws only from GameResult rows carrying at
// least one of quartersJson/scoringPlaysJson/homeTurnovers (rows predating
// NFL Game Pulse, and every non-NFL sport, are excluded) - each question's
// evaluate() then independently decides whether ITS specific field is
// present on a given row, so a row with turnovers but no quartersJson yet
// still counts toward wonTurnoverBattle even though it can't answer the
// other four.
export async function getNflTeamSituationalRates(team: string): Promise<NflSituationalRatesByQuestion> {
  const rows = await prisma.gameResult.findMany({
    where: {
      sportKey: "americanfootball_nfl",
      AND: [
        { OR: [{ homeTeam: team }, { awayTeam: team }] },
        {
          OR: [
            { quartersJson: { not: Prisma.DbNull } },
            { scoringPlaysJson: { not: Prisma.DbNull } },
            { homeTurnovers: { not: null } },
          ],
        },
      ],
    },
    select: {
      homeTeam: true,
      awayTeam: true,
      homeScore: true,
      awayScore: true,
      quartersJson: true,
      scoringPlaysJson: true,
      homeTurnovers: true,
      awayTurnovers: true,
    },
  });

  const result = {} as NflSituationalRatesByQuestion;
  for (const question of NFL_SITUATIONAL_QUESTIONS) {
    let wins = 0;
    let total = 0;
    for (const row of rows) {
      const isHome = row.homeTeam === team;
      const facts: NflGameRawFacts = {
        quarters: (row.quartersJson as unknown as { home: number; away: number }[] | null) ?? null,
        scoringPlays: (row.scoringPlaysJson as unknown as { home: number; away: number }[] | null) ?? null,
        homeTurnovers: row.homeTurnovers,
        awayTurnovers: row.awayTurnovers,
      };
      const holder = question.evaluate(facts);
      if (holder === null || holder !== (isHome ? "home" : "away")) continue;

      total++;
      const teamScore = isHome ? row.homeScore : row.awayScore;
      const oppScore = isHome ? row.awayScore : row.homeScore;
      if (teamScore > oppScore) wins++;
    }
    result[question.key] = total === 0 ? { wins: 0, total: 0, winPct: 0 } : { wins, total, winPct: (wins / total) * 100 };
  }
  return result;
}
