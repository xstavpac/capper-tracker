// Turns a live ScoreGame into a 0-100% "how far along is this game" bar plus
// a short text label, for the Live page's per-game progress indicator (Grid
// Live's game-card list and its game-detail panel). Pure and client-safe -
// no fetch/DB - so it can run in both the server-rendered initial pass and
// the client poll-tick recompute, same split as board-pulse.ts.
//
// MLB reuses completedInnings/REGULATION_INNINGS from board-pulse.ts (the
// same fractional-innings calc Board Pulse's pace projection already uses)
// rather than re-deriving top/bottom-of-inning math a second time. Every
// other live sport here is ESPN-backed (NBA/WNBA/NFL/NCAAF/NHL) and reads
// ScoreGame's period/clock fields, which getEspnScores populates from the
// scoreboard's own status.period/status.displayClock while a game is live
// (see odds.ts's ScoreGame type). CFL has no live period/clock data from its
// source and simply returns null below, same as any sport not in
// QUARTER_SPORT_CONFIG.
import { completedInnings, REGULATION_INNINGS } from "@/lib/board-pulse";
import type { ScoreGame } from "@/server/data/odds";

export type LiveGameProgress = {
  // 0-100, clamped. Overtime/extra innings clamp to 100 rather than growing
  // past it - past regulation there's no fixed denominator left to measure
  // against, and "full bar" reads correctly for "we're past the scheduled
  // length" either way.
  pct: number;
  // Short display label, e.g. "Top 9th" (MLB), "Q3 8:45" (NFL/NBA/NCAAF/
  // WNBA), "P2 12:05" (NHL), "OT 4:12". Never empty for a non-null result.
  label: string;
};

const QUARTER_SPORT_CONFIG: Record<string, { periods: number; periodMinutes: number; abbrev: string }> = {
  americanfootball_nfl: { periods: 4, periodMinutes: 15, abbrev: "Q" },
  americanfootball_ncaaf: { periods: 4, periodMinutes: 15, abbrev: "Q" },
  basketball_nba: { periods: 4, periodMinutes: 12, abbrev: "Q" },
  basketball_wnba: { periods: 4, periodMinutes: 10, abbrev: "Q" },
  icehockey_nhl: { periods: 3, periodMinutes: 20, abbrev: "P" },
};

// ESPN's displayClock is "mm:ss" counting down within the current period
// while live (e.g. "8:45"); anything else (a stray "0.0"/decimal-seconds
// form ESPN sometimes sends right at a period boundary, or a missing clock)
// falls back to null, and the caller below still gets a period-only pct.
function parseClockSecondsRemaining(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const match = clock.match(/^(\d+):(\d{2})$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

export function getLiveGameProgress(sportKey: string, score: ScoreGame | null | undefined): LiveGameProgress | null {
  if (!score || score.status !== "live") return null;

  if (sportKey === "baseball_mlb") {
    const completed = completedInnings(score.inningHalf, score.inningOrdinal);
    if (completed === null || !score.inningHalf || !score.inningOrdinal) return null;
    return {
      pct: clamp((completed / REGULATION_INNINGS) * 100),
      label: `${score.inningHalf} ${score.inningOrdinal}`,
    };
  }

  const config = QUARTER_SPORT_CONFIG[sportKey];
  if (!config || score.period === null || score.period === undefined || score.period < 1) return null;

  const periodSeconds = config.periodMinutes * 60;
  const isOvertime = score.period > config.periods;
  const remainingSeconds = parseClockSecondsRemaining(score.clock);

  const pct = isOvertime
    ? 100
    : remainingSeconds === null
      ? clamp(((score.period - 1) / config.periods) * 100)
      : clamp((((score.period - 1) * periodSeconds + (periodSeconds - remainingSeconds)) / (config.periods * periodSeconds)) * 100);

  const overtimeNumber = score.period - config.periods;
  const periodLabel = isOvertime ? (overtimeNumber > 1 ? `OT${overtimeNumber}` : "OT") : `${config.abbrev}${score.period}`;

  return {
    pct,
    label: score.clock ? `${periodLabel} ${score.clock}` : periodLabel,
  };
}
