// Reads stat-snapshots.ts's daily-captured history (TeamStatSnapshot/
// PitcherStatSnapshot) for the Charts workspace's historical variable series.
import type { TeamStatSnapshot, PitcherStatSnapshot } from "@prisma/client";

function winPctOf(record: { wins: number; losses: number }): number | null {
  const total = record.wins + record.losses;
  return total > 0 ? record.wins / total : null;
}

// Read off a dated snapshot row's flat fields. Exported so historical-
// variables.ts (the Charts data adapter) can reuse this exact calculation
// for a standalone entity time series instead of re-deriving it.
export function resolveTeamStatFromSnapshot(snapshot: TeamStatSnapshot, variableId: string): number | null {
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

// Same variables as resolveTeamStatFromSnapshot, for a pitcher snapshot row -
// pitcher_kbb isn't stored directly (the snapshot keeps raw strikeouts/
// walks, matching what stat-snapshots.ts actually captures), so it's derived
// here.
export function resolvePitcherStatFromSnapshot(snapshot: PitcherStatSnapshot, variableId: string): number | null {
  switch (variableId) {
    case "pitcher_era":
      return snapshot.era;
    case "pitcher_whip":
      return snapshot.whip;
    case "pitcher_kbb":
      return snapshot.walks > 0 ? Math.round((snapshot.strikeouts / snapshot.walks) * 100) / 100 : null;
    case "pitcher_innings_pitched":
      return snapshot.inningsPitched;
    case "pitcher_days_rest":
      return snapshot.daysRest;
    case "pitcher_home_era":
      return snapshot.homeEra;
    case "pitcher_road_era":
      return snapshot.roadEra;
    default:
      return null;
  }
}
