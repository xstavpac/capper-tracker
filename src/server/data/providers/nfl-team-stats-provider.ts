// Reads NflTeamStatSnapshot (one row per team per game, from nflverse - see
// server/data/nfl-team-stat-snapshots.ts) for the Charts workspace's
// historical variable series. The NFL counterpart to mlb-stats-provider.ts.
import type { NflTeamStatSnapshot } from "@prisma/client";

// Read a stored NFL snapshot row's flat column for one variable id. Exported
// so historical-variables.ts (the Charts data adapter) can reuse this exact
// mapping. Returns null for a metric that isn't resolvable on a given row
// (points/pointsAllowed before a game is final; yardsPerPlay with zero
// plays) - the chart renders that as a gap, same as MLB's MIN_SAMPLE nulls.
export function resolveNflTeamStatFromSnapshot(snapshot: NflTeamStatSnapshot, variableId: string): number | null {
  switch (variableId) {
    case "nfl_points":
      return snapshot.points;
    case "nfl_points_allowed":
      return snapshot.pointsAllowed;
    case "nfl_total_yards":
      return snapshot.totalYards;
    case "nfl_total_yards_allowed":
      return snapshot.totalYardsAllowed;
    case "nfl_passing_yards":
      return snapshot.passingYards;
    case "nfl_passing_yards_allowed":
      return snapshot.passingYardsAllowed;
    case "nfl_rushing_yards":
      return snapshot.rushingYards;
    case "nfl_rushing_yards_allowed":
      return snapshot.rushingYardsAllowed;
    case "nfl_yards_per_play":
      return snapshot.yardsPerPlay;
    case "nfl_first_downs":
      return snapshot.firstDowns;
    case "nfl_turnovers":
      return snapshot.turnovers;
    case "nfl_takeaways":
      return snapshot.takeaways;
    case "nfl_turnover_margin":
      return snapshot.turnoverMargin;
    case "nfl_sacks":
      return snapshot.sacks;
    case "nfl_sacks_allowed":
      return snapshot.sacksAllowed;
    case "nfl_penalties":
      return snapshot.penalties;
    case "nfl_penalty_yards":
      return snapshot.penaltyYards;
    case "nfl_passing_epa":
      return snapshot.passingEpa;
    case "nfl_rushing_epa":
      return snapshot.rushingEpa;
    case "nfl_receiving_epa":
      return snapshot.receivingEpa;
    case "nfl_offensive_epa":
      return snapshot.offensiveEpa;
    default:
      return null;
  }
}
