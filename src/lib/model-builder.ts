// Build Your Own Model - shared types and the variable catalog. Deliberately
// free of any prisma-touching import (matches the client/server boundary
// established for live-scoreboard.tsx: anything under server/data/*.ts pulls
// in `prisma` at module scope and can't be imported into a "use client"
// component) - the left-panel variable library renders straight from
// MODEL_VARIABLES in the browser. Actual data resolution/evaluation against
// real games lives in server/data/model-evaluation.ts and
// server/data/providers/ (one adapter per data source, keyed by sourceId
// below - see server/data/providers/types.ts for why).

export type ComparisonOperator = "LT" | "LTE" | "GT" | "GTE" | "EQ";

export const COMPARISON_OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  LT: "Less than",
  LTE: "Less than or equal to",
  GT: "Greater than",
  GTE: "Greater than or equal to",
  EQ: "Is",
};

// Every game has a favorite and an underdog by moneyline price, regardless of
// what the model's target market is - so "side" is how a condition picks
// which team in the matchup a team/pitcher-scoped variable reads from, and it
// works identically whether the model predicts FAVORITE_ML, UNDERDOG_ML,
// OVER, or UNDER.
export type VariableSide = "favorite" | "underdog";

// "team"/"pitcher" variables need a side chosen in the condition (which team's
// number is this?). "market" variables are already unambiguous (there's only
// one total line, one favorite moneyline, etc.) and never take a side. Not to
// be confused with DataScope below (whose data this is), which is a
// different axis entirely.
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
// DataScope enum on TeamTendency (prisma/schema.prisma) - added on both now,
// before any PER_USER source exists, so introducing one later is a matter of
// using the value rather than migrating tables that may by then hold real data.
export type DataScope = "global" | "per_user";

export type ModelVariableDef = {
  id: string;
  label: string;
  category: VariableCategory;
  scope: VariableScope;
  unit: VariableUnit;
  description: string;
  // Which provider (server/data/providers/) resolves this variable's actual
  // value - the condition engine and backtester look this up and dispatch to
  // that provider, never calling a specific API themselves. Every variable
  // here is "global" today (see DataScope above); sourceId is a free-form
  // string rather than an enum since adding a data source means registering
  // a new provider, not editing this file's type.
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

// A single variable/operator/threshold/weight rule - the atomic unit both
// Simple and (eventually) Advanced mode build with.
export type ConditionLeaf = {
  type: "condition";
  id: string;
  variableId: string;
  // Required when the variable's scope is "team" or "pitcher"; omitted for
  // "market" variables, which are already unambiguous.
  side?: VariableSide;
  operator: ComparisonOperator;
  threshold: number;
  weight: number; // percent, 0-100; a saved model's leaves should sum to 100
};

export type ConditionCombinator = "AND" | "OR";

// A group of leaves and/or nested groups, combined with AND or OR. Simple
// mode's UI only ever builds a single root AND-group of leaves (no nesting,
// no OR) - the recursive shape exists so a future Advanced mode can produce
// real nested AND/OR trees against the exact same stored column and
// evaluation engine (evaluateConditionTree, below) without a migration or a
// parallel data model.
export type ConditionGroup = {
  type: "group";
  id: string;
  combinator: ConditionCombinator;
  children: ConditionNode[];
};

export type ConditionNode = ConditionLeaf | ConditionGroup;

// What UserModel.conditions actually stores: always a single root group.
export type ConditionTree = ConditionGroup;

export function wrapFlatConditions(leaves: ConditionLeaf[]): ConditionTree {
  return { type: "group", id: "root", combinator: "AND", children: leaves };
}

// Simple mode's UI only ever edits a flat list of leaves directly under the
// root AND-group - if a tree has real nesting or an OR group (only possible
// from a future Advanced mode), this drops anything below the top level
// rather than guessing how to flatten it, since Simple mode has no UI for OR
// or nested groups at all. Advanced mode gets its own tree-aware editor later.
export function flattenToLeaves(tree: ConditionTree): ConditionLeaf[] {
  return tree.children.filter((c): c is ConditionLeaf => c.type === "condition");
}

// Every leaf anywhere in the tree, regardless of nesting - for summaries
// ("N conditions") that should count the whole model, not just the top level.
export function allLeaves(node: ConditionNode): ConditionLeaf[] {
  return node.type === "condition" ? [node] : node.children.flatMap(allLeaves);
}

export function totalConditionWeight(leaves: ConditionLeaf[]): number {
  return leaves.reduce((sum, c) => sum + c.weight, 0);
}

export function evaluateComparison(operator: ComparisonOperator, actual: number, threshold: number): boolean {
  switch (operator) {
    case "LT":
      return actual < threshold;
    case "LTE":
      return actual <= threshold;
    case "GT":
      return actual > threshold;
    case "GTE":
      return actual >= threshold;
    case "EQ":
      return actual === threshold;
  }
}

// Recursively evaluates a condition tree, combining each group's children by
// its own AND/OR combinator. `resolve` is supplied by the caller (it needs a
// GameContext or historical game data the engine has, not this file, which
// stays free of any data-fetching). An empty group is vacuously true - it
// imposes no constraint, matching how "no conditions yet" is treated
// elsewhere (nothing to fail on).
export function evaluateConditionTree(node: ConditionNode, resolve: (leaf: ConditionLeaf) => boolean): boolean {
  if (node.type === "condition") return resolve(node);
  if (node.children.length === 0) return true;
  return node.combinator === "AND"
    ? node.children.every((child) => evaluateConditionTree(child, resolve))
    : node.children.some((child) => evaluateConditionTree(child, resolve));
}
