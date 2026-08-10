// Wraps team-tendencies.ts (our own derived favorite/underdog win% and
// over/under rate, computed from GameResult+OddsSnapshot). resolveHistorical
// uses each team's CURRENT cumulative tendency rates - there's no per-game-
// date snapshot of tendencies yet, so this is a known simplification (not a
// true point-in-time backtest), unlike odds-market-provider's resolveHistorical
// which reads that game's own real OddsSnapshot.
import type { TeamTendencyRates } from "@/server/data/team-tendencies";
import type { VariableProvider } from "./types";

function readRate(tendency: TeamTendencyRates | null | undefined, variableId: string): number | null {
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

export const tendencyProvider: VariableProvider = {
  sourceId: "internal_tendencies",
  supportsHistorical: () => true,

  resolveLive(ctx, variableId, side) {
    const tendency = side === "favorite" ? ctx.favoriteTendency : side === "underdog" ? ctx.underdogTendency : null;
    return readRate(tendency, variableId);
  },

  resolveHistorical(ref, variableId, side) {
    const teamName = side === "favorite" ? ref.favoriteTeam : side === "underdog" ? ref.underdogTeam : null;
    const tendency = teamName ? ref.tendencyByTeam.get(teamName) : undefined;
    return readRate(tendency, variableId);
  },
};
