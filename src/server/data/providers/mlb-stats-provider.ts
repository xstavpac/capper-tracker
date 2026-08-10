// Wraps mlb-stats.ts (live team/pitcher season aggregates from the MLB
// Stats API) for resolveLive, and stat-snapshots.ts's daily-captured history
// for resolveHistorical. Asymmetric on purpose: team_stats variables can be
// backtested once enough TeamStatSnapshot rows have accumulated (join on
// team name + date), but pitcher_stats variables can't yet - there's no
// record anywhere of which pitcher started which historical GameResult, so
// there's nothing to join a PitcherStatSnapshot against for a past game.
// Pitcher snapshots are still captured daily (stat-snapshots.ts) so that gap
// doesn't also cost a data-collection lag once the starter-linkage exists.
import { getModelVariable } from "@/lib/model-builder";
import { easternDateKey } from "@/lib/dates";
import type { TeamStatSnapshot } from "@prisma/client";
import type { VariableProvider, GameContext, HistoricalGameRef } from "./types";

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

// Same variables as resolveTeamStat, read off a dated snapshot row's flat
// fields instead of GameContext's nested live-fetch shape.
function resolveTeamStatFromSnapshot(snapshot: TeamStatSnapshot, variableId: string): number | null {
  switch (variableId) {
    case "team_win_pct":
      return snapshot.winPct;
    case "team_run_differential":
      return snapshot.runDifferential;
    case "team_batting_avg":
      return snapshot.battingAvg;
    case "team_obp":
      return snapshot.obp;
    case "team_slg":
      return snapshot.slg;
    case "team_ops":
      return snapshot.ops;
    case "team_era":
      return snapshot.era;
    case "team_whip":
      return snapshot.whip;
    case "team_home_win_pct":
      return winPctOf({ wins: snapshot.homeWins, losses: snapshot.homeLosses });
    case "team_away_win_pct":
      return winPctOf({ wins: snapshot.awayWins, losses: snapshot.awayLosses });
    case "team_last10_win_pct":
      return winPctOf({ wins: snapshot.last10Wins, losses: snapshot.last10Losses });
    case "team_streak":
      return snapshot.streakType === "L" ? -snapshot.streakCount : snapshot.streakType === "W" ? snapshot.streakCount : 0;
    default:
      return null;
  }
}

// The most recent snapshot at or before gameDate - `snapshots` must already
// be sorted ascending by snapshotDate (backtestModel preloads them that
// way). A game predating this app's first captured snapshot correctly finds
// nothing, same as any other "not enough history yet" case.
function findLatestSnapshotAtOrBefore(snapshots: TeamStatSnapshot[], gameDate: Date): TeamStatSnapshot | undefined {
  const key = easternDateKey(gameDate);
  let result: TeamStatSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.snapshotDate > key) break;
    result = snapshot;
  }
  return result;
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
    case "pitcher_home_era":
      return pitcher.homeEra;
    case "pitcher_road_era":
      return pitcher.roadEra;
    default:
      return null;
  }
}

export const mlbStatsProvider: VariableProvider = {
  sourceId: "mlb_stats_api",

  supportsHistorical(variableId) {
    return getModelVariable(variableId)?.category === "team_stats";
  },

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

  resolveHistorical(ref: HistoricalGameRef, variableId, side) {
    if (getModelVariable(variableId)?.category !== "team_stats") return null; // pitcher_stats - see file header
    const teamName = side === "favorite" ? ref.favoriteTeam : side === "underdog" ? ref.underdogTeam : null;
    const snapshots = teamName ? ref.teamSnapshotsByTeam.get(teamName) : undefined;
    if (!snapshots || snapshots.length === 0) return null;
    const snapshot = findLatestSnapshotAtOrBefore(snapshots, ref.gameDate);
    return snapshot ? resolveTeamStatFromSnapshot(snapshot, variableId) : null;
  },
};
