import { easternDateKey } from "@/lib/dates";

// NFL team identity + season helpers - the nflverse analog of mlb-stats.ts.
//
// nflverse's CSV feeds (stats_team_week, games.csv) key every team by a short
// abbreviation ("KC", "WAS", "LV"). The rest of this app - GameResult,
// OddsSnapshot, TeamTendency - stores the full "City Nickname" string that
// The Odds API / ESPN return ("Kansas City Chiefs"). This module is the one
// canonical abbreviation -> full-name map, so NflTeamStatSnapshot rows are
// written in the exact spelling GameResult.homeTeam/awayTeam join on.
//
// The map was transcribed from nflverse's own teams_colors_logos.csv
// (github.com/nflverse/nflverse-data releases/tag/teams) and is CURRENT-ERA
// ABBREVIATIONS ONLY - all 32 active franchises.
//
// KNOWN GAP - historical franchise aliases are deliberately NOT handled.
// nflverse uses era-appropriate abbreviations in older data: "OAK" for the
// Raiders before 2020, "SD" for the Chargers before 2017, "STL"/"LA" for the
// Rams. Those are absent from this map on purpose - our NFL data only goes
// back to ~2025, so every abbreviation the ingestion job actually sees is
// current-era, and an unknown abbreviation is logged loudly rather than
// silently mismapped. Any future pre-2020 backfill from nflverse MUST add
// alias resolution (OAK -> "Las Vegas Raiders", SD -> "Los Angeles Chargers",
// STL -> "Los Angeles Rams") before those seasons will join correctly.
const NFL_TEAM_NAMES_BY_ABBR: Record<string, string> = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams", // nflverse uses "LA" (not "LAR") for the Rams in current data
  LAC: "Los Angeles Chargers",
  LV: "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders", // nflverse uses "WAS" (not ESPN's "WSH")
};

// The canonical full "City Nickname" name for an nflverse team abbreviation,
// or null for anything not in the current-era map (see the KNOWN GAP note
// above - a null here is what the ingestion job logs loudly and skips).
export function normalizeNflTeamName(abbr: string): string | null {
  return NFL_TEAM_NAMES_BY_ABBR[abbr.trim().toUpperCase()] ?? null;
}

// All 32 NFL teams' canonical full names, alphabetical - the NFL equivalent
// of getAllMlbTeamNames(), backing the Charts team selector when the sport
// toggle is on NFL. Same list NflTeamStatSnapshot.team is written with, so
// a name from here queries that table directly.
export function getAllNflTeamNames(): string[] {
  return Object.values(NFL_TEAM_NAMES_BY_ABBR).sort();
}

// The NFL "season year" for `reference`. The NFL labels a whole season by
// the calendar year it STARTS in (September), so a January/February playoff
// game belongs to the previous calendar year's season. The league year
// rolls over in March, so: Jan/Feb -> previous year, March onward -> current
// year. Dates are read in US Eastern to match the rest of the app (see
// lib/dates.ts) rather than the server process's own zone.
export function currentNflSeason(reference: Date = new Date()): number {
  const [year, month] = easternDateKey(reference).split("-").map(Number);
  return month <= 2 ? year - 1 : year;
}
