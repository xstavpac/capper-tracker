// Cross-source team-identifier resolution for Charts' Custom Metrics.
//
// The Charts team selector offers each sport's canonical full names
// (getAllMlbTeamNames / getAllNflTeamNames). A user-uploaded metric CSV,
// though, routinely keys teams by a stat-feed abbreviation ("AZ", "ATH",
// "KC") - so a snapshot imported from Baseball Savant stored teamName "AZ"
// while the chart later queries teamName "Arizona Diamondbacks", and the
// exact-match lookup found nothing (the per-team values silently never
// displayed). This module is the single place that bridges the two: it
// reuses the existing per-sport abbreviation maps (normalizeMlbTeamName,
// normalizeNflTeamName) rather than adding a new matching scheme.
//
// Used on BOTH sides so old and new data agree: importCustomMetrics
// canonicalizes team names before writing, and customMetricProvider
// resolves whatever is already stored when matching the selected team.
import { normalizeMlbTeamName, getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { normalizeNflTeamName, getAllNflTeamNames } from "@/server/data/nfl-team-stats";

export const MLB_SPORT_KEY = "baseball_mlb";
export const NFL_SPORT_KEY = "americanfootball_nfl";

// Human sport label for user-facing import errors.
export function sportLabel(sportKey: string): string {
  if (sportKey === MLB_SPORT_KEY) return "MLB";
  if (sportKey === NFL_SPORT_KEY) return "NFL";
  return sportKey;
}

// A raw team identifier (full name, or a stat-feed abbreviation) -> the
// sport's canonical full name, or null when it can't be resolved
// unambiguously. null is a real signal at import time: the importer surfaces
// the unresolved values to the user instead of storing a row no chart query
// will ever match.
export function resolveChartTeamName(sportKey: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (sportKey === MLB_SPORT_KEY) {
    return normalizeMlbTeamName(trimmed);
  }
  if (sportKey === NFL_SPORT_KEY) {
    // normalizeNflTeamName only maps abbreviations; a full name passes
    // straight through.
    if (getAllNflTeamNames().includes(trimmed)) return trimmed;
    return normalizeNflTeamName(trimmed);
  }
  return null;
}

// Whether two team identifiers refer to the same team for this sport,
// tolerating a stat-feed abbreviation on either side. Falls back to exact
// string equality for sports without an abbreviation map.
export function chartTeamsMatch(sportKey: string, a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolveChartTeamName(sportKey, a);
  const rb = resolveChartTeamName(sportKey, b);
  if (ra !== null && rb !== null) return ra === rb;
  if (ra !== null && ra === b) return true;
  if (rb !== null && rb === a) return true;
  return false;
}

// The canonical team list for a sport, or [] for one with no fixed catalog.
export function chartTeamCatalog(sportKey: string): string[] {
  if (sportKey === MLB_SPORT_KEY) return getAllMlbTeamNames();
  if (sportKey === NFL_SPORT_KEY) return getAllNflTeamNames();
  return [];
}
