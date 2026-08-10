// Wraps team-tendencies.ts (our own derived favorite/underdog win% and
// over/under rate, computed from GameResult+OddsSnapshot). resolveHistorical
// joins a historical game's date against TeamTendencySnapshot the same way
// mlbStatsProvider joins team/pitcher stat snapshots - the previous version
// of this file used each team's CURRENT cumulative rate for every historical
// game, which wasn't a real point-in-time backtest; TeamTendencySnapshot
// (added alongside Charts) closed that gap.
import { computeTendencyRates, type TeamTendencyRates } from "@/server/data/team-tendencies";
import type { TeamTendencySnapshot } from "@prisma/client";
import type { VariableProvider } from "./types";
import { findLatestAtOrBefore } from "./snapshot-utils";

// Exported so historical-variables.ts (the Charts data adapter) can reuse
// this exact rate-selection logic for a standalone entity time series -
// same one-calculation-per-variable rule as mlbStatsProvider's exports.
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

export const tendencyProvider: VariableProvider = {
  sourceId: "internal_tendencies",
  supportsHistorical: () => true,

  resolveLive(ctx, variableId, side) {
    const tendency = side === "favorite" ? ctx.favoriteTendency : side === "underdog" ? ctx.underdogTendency : null;
    return readRate(tendency, variableId);
  },

  resolveHistorical(ref, variableId, side) {
    const teamName = side === "favorite" ? ref.favoriteTeam : side === "underdog" ? ref.underdogTeam : null;
    const snapshots: TeamTendencySnapshot[] | undefined = teamName ? ref.tendencySnapshotsByTeam.get(teamName) : undefined;
    if (!snapshots || snapshots.length === 0) return null;
    const snapshot = findLatestAtOrBefore(snapshots, ref.gameDate);
    return snapshot ? readRate(computeTendencyRates(snapshot), variableId) : null;
  },
};
