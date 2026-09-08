// Wraps team-tendencies.ts (our own derived favorite/underdog win% and
// over/under rate, computed from GameResult+OddsSnapshot) for the Charts
// workspace's historical variable series.
import { computeTendencyRates, type TeamTendencyRates } from "@/server/data/team-tendencies";

// Exported so historical-variables.ts (the Charts data adapter) can reuse
// this exact rate-selection logic for a standalone entity time series.
export function readRate(tendency: TeamTendencyRates | null | undefined, variableId: string): number | null {
  if (!tendency) return null;
  // NFL tendency variables carry distinct ids ("nfl_tendency_*") but read
  // the exact same computed rates - computeTendencyRates and the snapshot
  // table are sport-agnostic, only the variable id differs. model-engine
  // (the other caller) only ever passes the MLB ids, so these aliases are
  // inert there.
  switch (variableId) {
    case "tendency_fav_win_pct":
    case "nfl_tendency_fav_win_pct":
      return tendency.favWinPct;
    case "tendency_dog_win_pct":
    case "nfl_tendency_dog_win_pct":
      return tendency.dogWinPct;
    case "tendency_over_rate":
    case "nfl_tendency_over_rate":
      return tendency.overRate;
    case "tendency_under_rate":
    case "nfl_tendency_under_rate":
      return tendency.underRate;
    default:
      return null;
  }
}

// The raw counts making up one tendency split, so a Charts note can show the
// rate next to its real record - "50% (6-6) as underdog · 12 games" - instead
// of a sample-size-gated "not enough data yet" message. Nothing about the
// numbers is gated: `games` is the true count and `pct` is null only when
// `games` is 0. `wins`/`losses` are the two decided outcomes of THIS split
// (for over/under, over vs under); `phrase` is the role clause the note
// appends after the record.
export type TendencySplitCounts = {
  favWins: number;
  favLosses: number;
  favPushes: number;
  dogWins: number;
  dogLosses: number;
  dogPushes: number;
  overCount: number;
  underCount: number;
  totalPushCount: number;
};

export type TendencySample = {
  phrase: string;
  wins: number;
  losses: number;
  pushes: number;
  games: number;
  pct: number | null;
};

export function readTendencySample(row: TendencySplitCounts, variableId: string): TendencySample | null {
  const rates = computeTendencyRates(row);
  switch (variableId) {
    case "tendency_fav_win_pct":
    case "nfl_tendency_fav_win_pct":
      return { phrase: "as favorite", wins: row.favWins, losses: row.favLosses, pushes: row.favPushes, games: rates.favSampleSize, pct: rates.favWinPct };
    case "tendency_dog_win_pct":
    case "nfl_tendency_dog_win_pct":
      return { phrase: "as underdog", wins: row.dogWins, losses: row.dogLosses, pushes: row.dogPushes, games: rates.dogSampleSize, pct: rates.dogWinPct };
    case "tendency_over_rate":
    case "nfl_tendency_over_rate":
      return { phrase: "over", wins: row.overCount, losses: row.underCount, pushes: row.totalPushCount, games: rates.totalSampleSize, pct: rates.overRate };
    case "tendency_under_rate":
    case "nfl_tendency_under_rate":
      return { phrase: "under", wins: row.underCount, losses: row.overCount, pushes: row.totalPushCount, games: rates.totalSampleSize, pct: rates.underRate };
    default:
      return null;
  }
}
