// Wraps mlb-stats.ts (team/pitcher season aggregates from the MLB Stats
// API). No point-in-time history is stored for these - only each team/
// pitcher's current season-to-date totals - so resolveHistorical always
// returns null and supportsHistorical is false; backtestModel reports that
// honestly rather than comparing today's stats against games from weeks ago.
import { getModelVariable } from "@/lib/model-builder";
import type { VariableProvider, GameContext } from "./types";

function winPctOf(record: { wins: number; losses: number }): number | null {
  const total = record.wins + record.losses;
  return total > 0 ? record.wins / total : null;
}

function resolveTeamStat(stats: GameContext["favoriteStats"], variableId: string): number | null {
  if (!stats) return null;
  switch (variableId) {
    case "team_win_pct":
      return stats.winPct;
    case "team_run_differential":
      return stats.runDifferential;
    case "team_batting_avg":
      return stats.battingAvg;
    case "team_obp":
      return stats.obp;
    case "team_slg":
      return stats.slg;
    case "team_ops":
      return stats.ops;
    case "team_era":
      return stats.era;
    case "team_whip":
      return stats.whip;
    case "team_home_win_pct":
      return winPctOf(stats.homeRecord);
    case "team_away_win_pct":
      return winPctOf(stats.awayRecord);
    case "team_last10_win_pct":
      return winPctOf(stats.last10);
    case "team_streak":
      return stats.streak.type === "L" ? -stats.streak.count : stats.streak.type === "W" ? stats.streak.count : 0;
    default:
      return null;
  }
}

function resolvePitcherStat(pitcher: GameContext["favoritePitcher"], variableId: string): number | null {
  if (!pitcher) return null;
  switch (variableId) {
    case "pitcher_era":
      return pitcher.era;
    case "pitcher_whip":
      return pitcher.whip;
    case "pitcher_kbb":
      return pitcher.kbb;
    case "pitcher_innings_pitched":
      return pitcher.inningsPitched;
    case "pitcher_days_rest":
      return pitcher.daysRest;
    default:
      return null;
  }
}

export const mlbStatsProvider: VariableProvider = {
  sourceId: "mlb_stats_api",
  supportsHistorical: false,

  resolveLive(ctx, variableId, side) {
    const variable = getModelVariable(variableId);
    if (variable?.category === "pitcher_stats") {
      const pitcher = side === "favorite" ? ctx.favoritePitcher : side === "underdog" ? ctx.underdogPitcher : null;
      return resolvePitcherStat(pitcher, variableId);
    }
    if (variable?.category === "team_stats") {
      const stats = side === "favorite" ? ctx.favoriteStats : side === "underdog" ? ctx.underdogStats : null;
      return resolveTeamStat(stats, variableId);
    }
    return null;
  },

  resolveHistorical() {
    return null;
  },
};
