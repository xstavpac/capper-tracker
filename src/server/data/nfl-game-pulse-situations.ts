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
  | "trailedAtHalftime"
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

// The mirror of leadingAtHalftime: the side that was BEHIND at the half, so
// its win rate here is the come-from-behind-at-half rate. Same tied-at-half
// null case. Added because the investigation flagged that only the
// leading-at-half side had a tracked question - there was no explicit
// comeback version.
function trailedAtHalftime(facts: NflGameRawFacts): "home" | "away" | null {
  const q = facts.quarters;
  if (!q || q.length < 2) return null;
  const home = q[0].home + q[1].home;
  const away = q[0].away + q[1].away;
  if (home === away) return null;
  return home < away ? "home" : "away";
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
  { key: "trailedAtHalftime", label: "trail at halftime", evaluate: trailedAtHalftime },
  { key: "wonTurnoverBattle", label: "win the turnover battle", evaluate: wonTurnoverBattle },
  { key: "ledByDoubleDigits", label: "lead by double digits", evaluate: ledByDoubleDigits },
  { key: "trailingEntering4th", label: "trail entering the 4th", evaluate: trailingEntering4th },
];

export type NflSituationalRatesByQuestion = Record<NflSituationalQuestionKey, SituationalRate>;

// Exactly the GameResult columns the evaluators below read (plus gameDate /
// isPreseason, which computeAllTeamsNflSituationalRates filters on) - keeps
// a caller's `select` and this in lockstep.
export type NflSituationalGameRow = {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
  isPreseason: boolean;
  quartersJson: unknown;
  scoringPlaysJson: unknown;
  homeTurnovers: number | null;
  awayTurnovers: number | null;
};

const NFL_SITUATIONAL_SELECT = {
  homeTeam: true,
  awayTeam: true,
  homeScore: true,
  awayScore: true,
  gameDate: true,
  isPreseason: true,
  quartersJson: true,
  scoringPlaysJson: true,
  homeTurnovers: true,
  awayTurnovers: true,
} as const;

export function emptyNflSituationalRates(): NflSituationalRatesByQuestion {
  const rates = {} as NflSituationalRatesByQuestion;
  for (const q of NFL_SITUATIONAL_QUESTIONS) rates[q.key] = { wins: 0, total: 0, winPct: 0 };
  return rates;
}

// Pure: every team's per-question wins/total in one pass over `games`.
// Preseason games never count (PR #56's flag); an `asOf` cutoff (pass
// dayBefore(gameDate) for a point-in-time read) excludes the game's own day
// and anything after it. Each question's evaluate() independently decides
// whether its own field is present on a row, so a row with only turnovers
// still counts toward wonTurnoverBattle. This is the one evaluator both the
// on-page-load rate lookup and the daily snapshot capture share.
export function computeAllTeamsNflSituationalRates(
  games: NflSituationalGameRow[],
  asOf?: Date
): Map<string, NflSituationalRatesByQuestion> {
  type Tally = Record<NflSituationalQuestionKey, { wins: number; total: number }>;
  const emptyTally = (): Tally =>
    Object.fromEntries(NFL_SITUATIONAL_QUESTIONS.map((q) => [q.key, { wins: 0, total: 0 }])) as Tally;

  const acc = new Map<string, Tally>();
  for (const row of games) {
    if (row.isPreseason) continue;
    if (asOf && row.gameDate >= asOf) continue;
    const facts: NflGameRawFacts = {
      quarters: (row.quartersJson as { home: number; away: number }[] | null) ?? null,
      scoringPlays: (row.scoringPlaysJson as { home: number; away: number }[] | null) ?? null,
      homeTurnovers: row.homeTurnovers,
      awayTurnovers: row.awayTurnovers,
    };
    for (const question of NFL_SITUATIONAL_QUESTIONS) {
      const holder = question.evaluate(facts);
      if (holder === null) continue;
      const team = holder === "home" ? row.homeTeam : row.awayTeam;
      const teamScore = holder === "home" ? row.homeScore : row.awayScore;
      const oppScore = holder === "home" ? row.awayScore : row.homeScore;
      let tally = acc.get(team);
      if (!tally) {
        tally = emptyTally();
        acc.set(team, tally);
      }
      tally[question.key].total++;
      if (teamScore > oppScore) tally[question.key].wins++;
    }
  }

  const out = new Map<string, NflSituationalRatesByQuestion>();
  for (const [team, tally] of acc) {
    const rates = {} as NflSituationalRatesByQuestion;
    for (const q of NFL_SITUATIONAL_QUESTIONS) {
      const { wins, total } = tally[q.key];
      rates[q.key] = total === 0 ? { wins: 0, total: 0, winPct: 0 } : { wins, total, winPct: (wins / total) * 100 };
    }
    out.set(team, rates);
  }
  return out;
}

// Team's historical win rate in NFL games, per situational question - same
// shape and semantics as MLB's getTeamSituationalRates. `asOf` (optional)
// makes it point-in-time: pass a date and only games strictly before it
// count. Preseason games are always excluded (query + evaluator both). Rows
// predating NFL Game Pulse (no quartersJson/scoringPlaysJson/turnovers) and
// every non-NFL sport are excluded by the query.
export async function getNflTeamSituationalRates(
  team: string,
  asOf?: Date
): Promise<NflSituationalRatesByQuestion> {
  const rows = await prisma.gameResult.findMany({
    where: {
      sportKey: "americanfootball_nfl",
      isPreseason: false,
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
    select: NFL_SITUATIONAL_SELECT,
  });
  return computeAllTeamsNflSituationalRates(rows, asOf).get(team) ?? emptyNflSituationalRates();
}

// Every NFL team's situational rates in one query - for the daily snapshot
// capture (situational-snapshots.ts), which needs all teams, not one.
export async function getAllNflTeamSituationalRates(
  asOf?: Date
): Promise<Map<string, NflSituationalRatesByQuestion>> {
  const rows = await prisma.gameResult.findMany({
    where: {
      sportKey: "americanfootball_nfl",
      isPreseason: false,
      OR: [
        { quartersJson: { not: Prisma.DbNull } },
        { scoringPlaysJson: { not: Prisma.DbNull } },
        { homeTurnovers: { not: null } },
      ],
    },
    select: NFL_SITUATIONAL_SELECT,
  });
  return computeAllTeamsNflSituationalRates(rows, asOf);
}
