// Variable catalog - shared by Charts (charting a historical variable per
// team/pitcher entity) as well as, formerly, the now-removed Build Your Own
// Model condition-tree engine. Deliberately free of any prisma-touching
// import (matches the client/server boundary established for
// live-scoreboard.tsx: anything under server/data/*.ts pulls in `prisma` at
// module scope and can't be imported into a "use client" component) - the
// Charts variable library renders straight from MODEL_VARIABLES in the
// browser.

// Every game has a favorite and an underdog by moneyline price - "side" is
// how a caller picks which team in the matchup a team/pitcher-scoped
// variable reads from.
export type VariableSide = "favorite" | "underdog";

// "team"/"pitcher" variables need a side chosen (which team's number is
// this?). "market" variables are already unambiguous (there's only one total
// line, one favorite moneyline, etc.) and never take a side. Not to be
// confused with DataScope below (whose data this is), which is a different
// axis entirely.
export type VariableScope = "team" | "pitcher" | "market";

export type VariableCategory = "team_tendencies" | "team_stats" | "pitcher_stats" | "odds_market";

export const VARIABLE_CATEGORY_LABELS: Record<VariableCategory, string> = {
  team_tendencies: "MLB team tendencies",
  team_stats: "MLB team stats",
  pitcher_stats: "MLB pitcher stats",
  odds_market: "Odds/market",
};

export type VariableUnit = "percent" | "decimal" | "runs" | "innings" | "odds" | "games";

// Whether a variable's data is shared globally (every source in this app
// today) or scoped to one user (no such source exists yet - a future
// user-uploaded or user-licensed feed would be PER_USER). Mirrors the
// DataScope enum on the snapshot tables (prisma/schema.prisma).
export type DataScope = "global" | "per_user";

export type ModelVariableDef = {
  id: string;
  label: string;
  category: VariableCategory;
  scope: VariableScope;
  unit: VariableUnit;
  description: string;
  // Which provider (server/data/providers/) resolves this variable's actual
  // value. sourceId is a free-form string rather than an enum since adding a
  // data source means registering a new provider, not editing this file's type.
  sourceId: string;
  dataScope: DataScope;
};

const MLB_STATS_API = "mlb_stats_api";
const INTERNAL_TENDENCIES = "internal_tendencies";
const ODDS_API = "odds_api";

// MLB batter stats were dropped from v1: individual batters can't be
// reliably auto-resolved per game (no confirmed lineup until close to game
// time, no single canonical "the batter" for a team). Team-level batting
// aggregates (avg/OBP/SLG/OPS, below) cover the batting angle for now.
export const MODEL_VARIABLES: ModelVariableDef[] = [
  // ---- MLB team tendencies (derived, gated on MIN_TENDENCY_SAMPLE) ----
  {
    id: "tendency_fav_win_pct",
    label: "Win% as favorite",
    category: "team_tendencies",
    scope: "team",
    unit: "percent",
    description: "This team's historical win rate in games where they were the moneyline favorite.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "tendency_dog_win_pct",
    label: "Win% as underdog",
    category: "team_tendencies",
    scope: "team",
    unit: "percent",
    description: "This team's historical win rate in games where they were the moneyline underdog.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "tendency_over_rate",
    label: "Over rate",
    category: "team_tendencies",
    scope: "team",
    unit: "percent",
    description: "Share of this team's games that have gone over the total line.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "tendency_under_rate",
    label: "Under rate",
    category: "team_tendencies",
    scope: "team",
    unit: "percent",
    description: "Share of this team's games that have gone under the total line.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },

  // ---- MLB team stats (season aggregates, MLB Stats API) ----
  {
    id: "team_win_pct",
    label: "Win%",
    category: "team_stats",
    scope: "team",
    unit: "percent",
    description: "Season win percentage.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_run_differential",
    label: "Run differential",
    category: "team_stats",
    scope: "team",
    unit: "runs",
    description: "Season runs scored minus runs allowed.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_batting_avg",
    label: "Batting average",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season batting average.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_obp",
    label: "On-base percentage",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season on-base percentage.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_slg",
    label: "Slugging percentage",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season slugging percentage.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_ops",
    label: "OPS",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season on-base plus slugging.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_era",
    label: "ERA",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season earned run average.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_whip",
    label: "WHIP",
    category: "team_stats",
    scope: "team",
    unit: "decimal",
    description: "Team season walks + hits per inning pitched.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_home_win_pct",
    label: "Home win%",
    category: "team_stats",
    scope: "team",
    unit: "percent",
    description: "Win percentage in home games this season.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_away_win_pct",
    label: "Away win%",
    category: "team_stats",
    scope: "team",
    unit: "percent",
    description: "Win percentage in away games this season.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_last10_win_pct",
    label: "Last-10 win%",
    category: "team_stats",
    scope: "team",
    unit: "percent",
    description: "Win percentage over the team's last 10 games.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_streak",
    label: "Current streak",
    category: "team_stats",
    scope: "team",
    unit: "games",
    description: "Current win/loss streak - positive for a winning streak, negative for a losing streak.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },

  // ---- MLB pitcher stats (probable starter, season aggregates) ----
  {
    id: "pitcher_era",
    label: "ERA",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season earned run average.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_whip",
    label: "WHIP",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season walks + hits per inning pitched.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_kbb",
    label: "K/BB ratio",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season strikeout-to-walk ratio.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_innings_pitched",
    label: "Innings pitched (season)",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "innings",
    description: "Probable starter's total innings pitched this season.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_days_rest",
    label: "Days rest",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "games",
    description: "Days since the probable starter's last appearance.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_home_era",
    label: "Home ERA",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season ERA in home games.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_road_era",
    label: "Road ERA",
    category: "pitcher_stats",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season ERA in road games.",
    sourceId: MLB_STATS_API,
    dataScope: "global",
  },

  // ---- Odds/market (already unambiguous - no side needed) ----
  {
    id: "market_favorite_moneyline",
    label: "Favorite's moneyline",
    category: "odds_market",
    scope: "market",
    unit: "odds",
    description: "The favorite's American moneyline price.",
    sourceId: ODDS_API,
    dataScope: "global",
  },
  {
    id: "market_underdog_moneyline",
    label: "Underdog's moneyline",
    category: "odds_market",
    scope: "market",
    unit: "odds",
    description: "The underdog's American moneyline price.",
    sourceId: ODDS_API,
    dataScope: "global",
  },
  {
    id: "market_spread",
    label: "Run line (spread)",
    category: "odds_market",
    scope: "market",
    unit: "runs",
    description: "The favorite's run line point (typically -1.5 in MLB).",
    sourceId: ODDS_API,
    dataScope: "global",
  },
  {
    id: "market_total_line",
    label: "Total line",
    category: "odds_market",
    scope: "market",
    unit: "runs",
    description: "The game's over/under total line.",
    sourceId: ODDS_API,
    dataScope: "global",
  },
];

export function getModelVariable(id: string): ModelVariableDef | undefined {
  return MODEL_VARIABLES.find((v) => v.id === id);
}
