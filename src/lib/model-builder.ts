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

// custom_metric entries are never part of MODEL_VARIABLES itself (that
// array is the fixed, built-in catalog) - they're built at request time
// from the requesting user's own CustomMetric rows (see
// server/data/custom-metrics.ts's getCustomMetricVariables) and merged in
// alongside MODEL_VARIABLES by the page/workspace that needs them.
//
// Categories are sport-neutral: NFL team_stats/team_tendencies entries reuse
// the same category values as MLB's, told apart by the `sport` field below.
// (Kept sport-neutral deliberately - model-engine/resolver.ts has an
// exhaustive compiler-checked switch over VariableCategory, and adding
// NFL-specific category members would force a change there for no gain,
// since model-engine only ever resolves the hardcoded MLB variable ids.)
export type VariableCategory = "team_tendencies" | "team_stats" | "pitcher_stats" | "odds_market" | "custom_metric";

// Which sport a built-in catalog entry belongs to. Charts filters the
// variable library by the sport toggle so MLB and NFL variables never mix
// in the picker. Custom metrics carry their own sportKey (CustomMetric.
// sportKey) and are filtered separately - this field is for MODEL_VARIABLES.
export type VariableSport = "baseball_mlb" | "americanfootball_nfl";

export const VARIABLE_CATEGORY_LABELS: Record<VariableCategory, string> = {
  team_tendencies: "Team tendencies",
  team_stats: "Team stats",
  pitcher_stats: "Pitcher stats",
  odds_market: "Odds/market",
  custom_metric: "Custom metrics",
};

// "yards" / "points" / "count" back NFL box-score variables - integer
// display, no decimal places (see formatValueForUnit in
// components/charts/historical-variable-chart.tsx). "count" also covers
// signed integers like turnover margin.
export type VariableUnit = "percent" | "decimal" | "runs" | "innings" | "odds" | "games" | "yards" | "points" | "count";

// Whether a variable's data is shared globally (every source in this app
// today) or scoped to one user (no such source exists yet - a future
// user-uploaded or user-licensed feed would be PER_USER). Mirrors the
// DataScope enum on the snapshot tables (prisma/schema.prisma).
export type DataScope = "global" | "per_user";

export type ModelVariableDef = {
  id: string;
  label: string;
  category: VariableCategory;
  // Which sport this built-in variable belongs to - Charts filters the
  // picker by the sport toggle. Custom metrics (built at request time, never
  // in MODEL_VARIABLES) don't carry this; they're filtered by their own
  // CustomMetric.sportKey instead.
  sport: VariableSport;
  scope: VariableScope;
  unit: VariableUnit;
  description: string;
  // Which provider (server/data/providers/) resolves this variable's actual
  // value. sourceId is a free-form string rather than an enum since adding a
  // data source means registering a new provider, not editing this file's type.
  sourceId: string;
  dataScope: DataScope;
};

// Split into two distinct sourceIds (was one shared "mlb_stats_api" for
// both) so sourceId is a true 1:1 key into the provider registry
// (server/data/historical-variables.ts) - team_stats and pitcher_stats need
// different providers (different snapshot tables/entity shapes), so a
// shared id would have meant the registry still had to branch internally on
// category, defeating the point of keying providers by source at all.
// Exported (not just used internally by MODEL_VARIABLES below) so the
// provider registry in server/data/historical-variables.ts can key its
// dispatch map by the exact same symbols the catalog entries carry, instead
// of duplicating these strings as separate literals that could drift.
export const MLB_TEAM_STATS_API = "mlb_team_stats_api";
export const MLB_PITCHER_STATS_API = "mlb_pitcher_stats_api";
export const INTERNAL_TENDENCIES = "internal_tendencies";
const ODDS_API = "odds_api";
// NFL per-game team box-score stats, from nflverse (NflTeamStatSnapshot).
// Resolved by nflTeamStatsProvider in historical-variables.ts. NFL team
// tendencies reuse INTERNAL_TENDENCIES above - that provider already keys
// its snapshot query on sportKey, so it serves NFL rows unchanged.
export const NFL_TEAM_STATS_API = "nfl_team_stats_api";
// Custom Metrics (Charts) - one provider handles every user-uploaded
// metric, dispatched the same way as every built-in source; see
// getCustomMetricSeries in historical-variables.ts.
export const USER_UPLOAD = "user_upload";

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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
    scope: "team",
    unit: "percent",
    description: "Season win percentage.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_run_differential",
    label: "Run differential",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "runs",
    description: "Season runs scored minus runs allowed.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_batting_avg",
    label: "Batting average",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season batting average.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_obp",
    label: "On-base percentage",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season on-base percentage.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_slg",
    label: "Slugging percentage",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season slugging percentage.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_ops",
    label: "OPS",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season on-base plus slugging.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_era",
    label: "ERA",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season earned run average.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_whip",
    label: "WHIP",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "decimal",
    description: "Team season walks + hits per inning pitched.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_home_win_pct",
    label: "Home win%",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "percent",
    description: "Win percentage in home games this season.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_away_win_pct",
    label: "Away win%",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "percent",
    description: "Win percentage in away games this season.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_last10_win_pct",
    label: "Last-10 win%",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "percent",
    description: "Win percentage over the team's last 10 games.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "team_streak",
    label: "Current streak",
    category: "team_stats",
    sport: "baseball_mlb",
    scope: "team",
    unit: "games",
    description: "Current win/loss streak - positive for a winning streak, negative for a losing streak.",
    sourceId: MLB_TEAM_STATS_API,
    dataScope: "global",
  },

  // ---- MLB pitcher stats (probable starter, season aggregates) ----
  {
    id: "pitcher_era",
    label: "ERA",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season earned run average.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_whip",
    label: "WHIP",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season walks + hits per inning pitched.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_kbb",
    label: "K/BB ratio",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season strikeout-to-walk ratio.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_innings_pitched",
    label: "Innings pitched (season)",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "innings",
    description: "Probable starter's total innings pitched this season.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_days_rest",
    label: "Days rest",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "games",
    description: "Days since the probable starter's last appearance.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_home_era",
    label: "Home ERA",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season ERA in home games.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },
  {
    id: "pitcher_road_era",
    label: "Road ERA",
    category: "pitcher_stats",
    sport: "baseball_mlb",
    scope: "pitcher",
    unit: "decimal",
    description: "Probable starter's season ERA in road games.",
    sourceId: MLB_PITCHER_STATS_API,
    dataScope: "global",
  },

  // ---- Odds/market (already unambiguous - no side needed) ----
  {
    id: "market_favorite_moneyline",
    label: "Favorite's moneyline",
    category: "odds_market",
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
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
    sport: "baseball_mlb",
    scope: "market",
    unit: "runs",
    description: "The game's over/under total line.",
    sourceId: ODDS_API,
    dataScope: "global",
  },

  // ---- NFL team tendencies (same derivation as MLB - INTERNAL_TENDENCIES
  //      provider keys on sportKey - gated on MIN_TENDENCY_SAMPLE, so these
  //      stay empty until the regular season builds enough decided games) ----
  {
    id: "nfl_tendency_fav_win_pct",
    label: "Win% as favorite",
    category: "team_tendencies",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "percent",
    description: "This team's historical win rate in games where they were the moneyline favorite.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "nfl_tendency_dog_win_pct",
    label: "Win% as underdog",
    category: "team_tendencies",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "percent",
    description: "This team's historical win rate in games where they were the moneyline underdog.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "nfl_tendency_over_rate",
    label: "Over rate",
    category: "team_tendencies",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "percent",
    description: "Share of this team's games that have gone over the total line.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },
  {
    id: "nfl_tendency_under_rate",
    label: "Under rate",
    category: "team_tendencies",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "percent",
    description: "Share of this team's games that have gone under the total line.",
    sourceId: INTERNAL_TENDENCIES,
    dataScope: "global",
  },

  // ---- NFL team stats (per game, nflverse - NflTeamStatSnapshot). Only
  //      metrics actually populated in that table: no third-down % or time
  //      of possession (absent from the nflverse stats_team_week feed). ----
  {
    id: "nfl_points",
    label: "Points scored",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "points",
    description: "Points this team scored in the game.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_points_allowed",
    label: "Points allowed",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "points",
    description: "Points this team's opponent scored in the game.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_total_yards",
    label: "Total yards",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Net total yards (passing + rushing - sack yards lost).",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_total_yards_allowed",
    label: "Total yards allowed",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Net total yards allowed to the opponent.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_passing_yards",
    label: "Passing yards",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Gross passing yards.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_passing_yards_allowed",
    label: "Passing yards allowed",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Gross passing yards allowed to the opponent.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_rushing_yards",
    label: "Rushing yards",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Rushing yards.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_rushing_yards_allowed",
    label: "Rushing yards allowed",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Rushing yards allowed to the opponent.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_yards_per_play",
    label: "Yards per play",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "decimal",
    description: "Net total yards divided by offensive plays (pass attempts + carries + sacks taken).",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_first_downs",
    label: "First downs",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Passing + rushing first downs (penalty first downs not included - absent from the feed).",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_turnovers",
    label: "Turnovers (giveaways)",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Interceptions thrown + fumbles lost.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_takeaways",
    label: "Takeaways",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Defensive interceptions + opponent fumbles recovered.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_turnover_margin",
    label: "Turnover margin",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Takeaways minus turnovers (can be negative).",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_sacks",
    label: "Sacks (by defense)",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Sacks recorded by this team's defense.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_sacks_allowed",
    label: "Sacks allowed",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Sacks this team's offense suffered.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_penalties",
    label: "Penalties",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "count",
    description: "Total penalties committed.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_penalty_yards",
    label: "Penalty yards",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "yards",
    description: "Total penalty yards.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_passing_epa",
    label: "Passing EPA",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "decimal",
    description: "Total expected points added on pass plays (from nflverse's pre-summed feed).",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_rushing_epa",
    label: "Rushing EPA",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "decimal",
    description: "Total expected points added on rush plays.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_receiving_epa",
    label: "Receiving EPA",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "decimal",
    description: "Total expected points added credited to receivers.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
  {
    id: "nfl_offensive_epa",
    label: "Offensive EPA",
    category: "team_stats",
    sport: "americanfootball_nfl",
    scope: "team",
    unit: "decimal",
    description: "Passing EPA + rushing EPA.",
    sourceId: NFL_TEAM_STATS_API,
    dataScope: "global",
  },
];

export function getModelVariable(id: string): ModelVariableDef | undefined {
  return MODEL_VARIABLES.find((v) => v.id === id);
}
