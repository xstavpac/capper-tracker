// Wraps team-tendencies.ts (our own derived favorite/underdog win% and
// over/under rate, computed from GameResult+OddsSnapshot) for the Charts
// workspace's historical variable series.
import type { TeamTendencyRates } from "@/server/data/team-tendencies";

// Exported so historical-variables.ts (the Charts data adapter) can reuse
// this exact rate-selection logic for a standalone entity time series.
export function readRate(tendency: TeamTendencyRates | null | undefined, variableId: string): number | null {
  if (!tendency) return null;
  switch (variableId) {
    case "tendency_fav_win_pct":
      return tendency.favWinPct;
    case "tendency_dog_win_pct":
      return tendency.dogWinPct;
    case "tendency_over_rate":
      return tendency.overRate;
    case "tendency_under_rate":
      return tendency.underRate;
    default:
      return null;
  }
}
