// Per-league settings for roster-load.ts: which fetcher, which season window,
// and the guards. No prisma import (the tables are in roster-tables.ts).
//
// The minimums, against the live fetch of 2026-10-14 (NFL 770 players / 21-28
// per team, NHL 842 / 23-31, NBA 622 / 18-24 in preseason, MLB 1,359 / 40-57):
//
//   minTeams          every franchise - one missing team is a failed request,
//                     not a roster change, so the league writes nothing.
//   minPlayers        roughly 80% of a normal league total, so a league-wide
//                     degraded response aborts even with every team present.
//                     NBA allows for the cut-down to 15 + 3 two-way players.
//   minPlayersPerTeam well under any real roster: NFL counts QB/RB/WR/TE only
//                     (usually 21+), NHL C/LW/RW/D/G (23+), an NBA regular-season
//                     roster is 15-18, MLB's 40-man rarely sits below 38. Below
//                     it, that team's deactivations are skipped.
//
// WNBA has no roster table and no player-prop support, so it is not here.
// NCAAF / NCAAB are out of scope.
import { easternDateKey } from "@/lib/dates";
import { fetchNflLeagueRoster, NFL_ESPN_TEAM_IDS } from "@/server/data/nfl-roster";
import { fetchNhlLeagueRoster, NHL_ESPN_TEAM_IDS } from "@/server/data/nhl-roster";
import { fetchNbaLeagueRoster, NBA_ESPN_TEAM_IDS } from "@/server/data/nba-roster";
import { fetchMlbLeagueRoster, MLB_TEAM_IDS } from "@/server/data/mlb-roster";
import type { RosterLeague, RosterLeagueConfig } from "@/server/data/roster-load";

const names = (ids: [string, string][]) => ids.map(([, team]) => team);

// The MLB 40-man is fetched for the current season (Eastern calendar year);
// the refresh only runs inside MLB's window, which never crosses a year end.
export const mlbRosterSeason = (now: Date = new Date()) => parseInt(easternDateKey(now).slice(0, 4), 10);

export const ROSTER_LEAGUES: Record<RosterLeague, RosterLeagueConfig> = {
  NFL: {
    league: "NFL",
    sportKey: "americanfootball_nfl",
    teams: names(NFL_ESPN_TEAM_IDS),
    minTeams: NFL_ESPN_TEAM_IDS.length,
    minPlayers: 600,
    minPlayersPerTeam: 15,
    fetchRoster: fetchNflLeagueRoster,
  },
  NHL: {
    league: "NHL",
    sportKey: "icehockey_nhl",
    teams: names(NHL_ESPN_TEAM_IDS),
    minTeams: NHL_ESPN_TEAM_IDS.length,
    minPlayers: 650,
    minPlayersPerTeam: 18,
    fetchRoster: fetchNhlLeagueRoster,
  },
  NBA: {
    league: "NBA",
    sportKey: "basketball_nba",
    teams: names(NBA_ESPN_TEAM_IDS),
    minTeams: NBA_ESPN_TEAM_IDS.length,
    minPlayers: 450,
    minPlayersPerTeam: 12,
    fetchRoster: fetchNbaLeagueRoster,
  },
  MLB: {
    league: "MLB",
    sportKey: "baseball_mlb",
    teams: names(MLB_TEAM_IDS),
    minTeams: MLB_TEAM_IDS.length,
    minPlayers: 1000,
    minPlayersPerTeam: 30,
    fetchRoster: () => fetchMlbLeagueRoster(mlbRosterSeason()),
  },
};

export const ROSTER_LEAGUE_ORDER: RosterLeague[] = ["NFL", "NHL", "NBA", "MLB"];
