import { prisma } from "@/lib/prisma";
import type { OddsGame } from "@/server/data/odds";
import { findOddsGameForResult, moneylinePrice, totalLine, totalOutcomePrice, spreadPoint, computeTendencyRates } from "@/server/data/team-tendencies";
import { getTeamSeasonStats, getPitcherSeasonStats, getProbablePitcher } from "@/server/data/mlb-stats";
import { getModelVariable, evaluateComparison, evaluateConditionTree, allLeaves, type ConditionTree, type ConditionLeaf, type VariableSide } from "@/lib/model-builder";
import { getVariableProvider, type GameContext, type HistoricalGameRef } from "@/server/data/providers";

export type ModelTarget = "FAVORITE_ML" | "UNDERDOG_ML" | "OVER" | "UNDER";

// Below this many matching historical games, a model's backtested win rate
// isn't a reliable enough sample to show - confirmed with the user alongside
// MIN_TENDENCY_SAMPLE (20 games/team) during the initial design pass.
export const MIN_BACKTEST_SAMPLE = 10;

export function americanOddsToImpliedProbability(price: number): number {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

export type { GameContext } from "@/server/data/providers";

function favoriteUnderdogFromMoneyline(
  oddsGame: OddsGame
): { favoriteTeam: string; underdogTeam: string; favoriteMoneyline: number; underdogMoneyline: number } | null {
  const homePrice = moneylinePrice(oddsGame, oddsGame.homeTeam);
  const awayPrice = moneylinePrice(oddsGame, oddsGame.awayTeam);
  // A true pick'em (equal prices) has no well-defined favorite - same
  // exclusion recomputeTeamTendencies uses.
  if (homePrice === null || awayPrice === null || homePrice === awayPrice) return null;

  const favoriteTeam = homePrice < awayPrice ? oddsGame.homeTeam : oddsGame.awayTeam;
  const underdogTeam = favoriteTeam === oddsGame.homeTeam ? oddsGame.awayTeam : oddsGame.homeTeam;
  return {
    favoriteTeam,
    underdogTeam,
    favoriteMoneyline: Math.min(homePrice, awayPrice),
    underdogMoneyline: Math.max(homePrice, awayPrice),
  };
}

async function getTeamTendencyRates(sportKey: string, teamName: string) {
  const tendency = await prisma.teamTendency.findUnique({ where: { sportKey_teamName: { sportKey, teamName } } });
  return tendency ? computeTendencyRates(tendency) : null;
}

// Builds the full live context for an upcoming/current game - fetches
// current-season team/pitcher stats and tendencies for whichever teams are
// resolved as favorite/underdog. gamePk (MLB's numeric game id, distinct
// from the odds API's own game id) is needed to look up the probable
// starters; omit it (or pass null) when unknown and pitcher fields resolve
// to null rather than failing the whole context. This batch-fetch stays a
// direct orchestration (not routed through the provider interface) - see
// providers/types.ts's GameContext comment for why.
export async function buildGameContext(sportKey: string, oddsGame: OddsGame, gamePk: string | null): Promise<GameContext> {
  const favDog = favoriteUnderdogFromMoneyline(oddsGame);
  const line = totalLine(oddsGame);
  const spread = favDog ? spreadPoint(oddsGame, favDog.favoriteTeam) : null;

  const [favoriteStats, underdogStats, favoriteTendency, underdogTendency] = await Promise.all([
    favDog ? getTeamSeasonStats(favDog.favoriteTeam) : Promise.resolve(null),
    favDog ? getTeamSeasonStats(favDog.underdogTeam) : Promise.resolve(null),
    favDog ? getTeamTendencyRates(sportKey, favDog.favoriteTeam) : Promise.resolve(null),
    favDog ? getTeamTendencyRates(sportKey, favDog.underdogTeam) : Promise.resolve(null),
  ]);

  let favoritePitcher = null;
  let underdogPitcher = null;
  if (gamePk && favDog) {
    const favoriteSide = favDog.favoriteTeam === oddsGame.homeTeam ? "home" : "away";
    const underdogSide = favoriteSide === "home" ? "away" : "home";
    const [favoriteProbable, underdogProbable] = await Promise.all([
      getProbablePitcher(gamePk, favoriteSide),
      getProbablePitcher(gamePk, underdogSide),
    ]);
    [favoritePitcher, underdogPitcher] = await Promise.all([
      favoriteProbable ? getPitcherSeasonStats(favoriteProbable.id) : Promise.resolve(null),
      underdogProbable ? getPitcherSeasonStats(underdogProbable.id) : Promise.resolve(null),
    ]);
  }

  return {
    homeTeam: oddsGame.homeTeam,
    awayTeam: oddsGame.awayTeam,
    favoriteTeam: favDog?.favoriteTeam ?? null,
    underdogTeam: favDog?.underdogTeam ?? null,
    favoriteMoneyline: favDog?.favoriteMoneyline ?? null,
    underdogMoneyline: favDog?.underdogMoneyline ?? null,
    totalLine: line,
    totalOverPrice: line !== null ? totalOutcomePrice(oddsGame, "Over") : null,
    totalUnderPrice: line !== null ? totalOutcomePrice(oddsGame, "Under") : null,
    spread,
    favoriteStats,
    underdogStats,
    favoriteTendency,
    underdogTendency,
    favoritePitcher,
    underdogPitcher,
  };
}

// Reads one variable's live value by dispatching to its registered provider
// (see server/data/providers) - never touches mlb-stats.ts/team-tendencies.ts
// directly. Returns null whenever the underlying data isn't available (no
// resolved favorite/underdog, stats fetch failed, tendency below
// MIN_TENDENCY_SAMPLE, unknown variable/provider, etc.) rather than a
// fabricated number.
export function resolveVariable(ctx: GameContext, variableId: string, side?: VariableSide): number | null {
  const variable = getModelVariable(variableId);
  if (!variable) return null;
  const provider = getVariableProvider(variable.sourceId);
  if (!provider) return null;
  return provider.resolveLive(ctx, variableId, side);
}

export type ConditionResult = {
  conditionId: string;
  variableId: string;
  variableLabel: string;
  actual: number | null;
  passed: boolean;
};

// Flat, per-leaf results for display (the right-panel condition list) -
// regardless of how the leaves are nested/combined in the tree.
export function evaluateConditionResults(ctx: GameContext, tree: ConditionTree): ConditionResult[] {
  return allLeaves(tree).map((leaf) => {
    const variable = getModelVariable(leaf.variableId);
    const actual = resolveVariable(ctx, leaf.variableId, leaf.side);
    const passed = actual !== null && evaluateComparison(leaf.operator, actual, leaf.threshold);
    return { conditionId: leaf.id, variableId: leaf.variableId, variableLabel: variable?.label ?? leaf.variableId, actual, passed };
  });
}

// The tree's actual pass/fail for this game, honoring each group's AND/OR
// combinator - NOT simply "every leaf passed" (that's only equivalent for a
// Simple-mode model, whose root is always a flat AND-group; a future
// Advanced-mode OR group would make them diverge).
export function allConditionsSatisfied(ctx: GameContext, tree: ConditionTree): boolean {
  if (tree.children.length === 0) return false; // an empty model matches nothing, not everything
  return evaluateConditionTree(tree, (leaf) => {
    const actual = resolveVariable(ctx, leaf.variableId, leaf.side);
    return actual !== null && evaluateComparison(leaf.operator, actual, leaf.threshold);
  });
}

export type ModelHealth =
  | { status: "ready"; sampleSize: number; historicalWinRate: number }
  | { status: "insufficient_sample"; sampleSize: number }
  | { status: "unsupported"; reason: string };

// Only variables whose provider declares supportsHistorical(variableId) can
// be honestly backtested today - practically, only an unknown/misregistered
// sourceId hits this now that team_stats and pitcher_stats are both backed
// by daily snapshots. Both unlock progressively as those snapshots (and, for
// pitchers, GameStarters linkage) accumulate day by day - a historical game
// predating the relevant capture still won't match, same as any other "not
// enough history yet" case, surfaced via a real 0-or-low sampleSize rather
// than this "unsupported" path.
function unsupportedBacktestReason(leaves: ConditionLeaf[]): string | null {
  const blocker = leaves.find((leaf) => {
    const variable = getModelVariable(leaf.variableId);
    const provider = variable ? getVariableProvider(variable.sourceId) : undefined;
    return !provider || !provider.supportsHistorical(leaf.variableId);
  });
  if (!blocker) return null;
  const variable = getModelVariable(blocker.variableId);
  return `Backtesting isn't available yet for "${variable?.label ?? blocker.variableId}".`;
}

// Backtests a model's conditions against every finished game this app has
// both a result and an odds snapshot for. A game only counts toward the
// sample if the tree resolves true (via each provider's resolveHistorical)
// AND the target outcome itself is well-defined (excludes pushes/pick'ems
// from the denominator, same convention gradePick uses for grading real picks).
export async function backtestModel(sportKey: string, target: ModelTarget, tree: ConditionTree): Promise<ModelHealth> {
  const leaves = allLeaves(tree);
  if (leaves.length === 0) return { status: "insufficient_sample", sampleSize: 0 };

  const unsupportedReason = unsupportedBacktestReason(leaves);
  if (unsupportedReason) return { status: "unsupported", reason: unsupportedReason };

  const [gameResults, snapshots, tendencySnapshotRows, teamStatSnapshotRows, pitcherStatSnapshotRows, gameStarterRows] = await Promise.all([
    prisma.gameResult.findMany({ where: { sportKey } }),
    prisma.oddsSnapshot.findMany({ where: { sportKey } }),
    prisma.teamTendencySnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }),
    prisma.teamStatSnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }),
    prisma.pitcherStatSnapshot.findMany({ where: { sportKey }, orderBy: { snapshotDate: "asc" } }),
    prisma.gameStarters.findMany({ where: { sportKey } }),
  ]);
  const oddsGames = snapshots.flatMap((s) => s.data as unknown as OddsGame[]);

  // Grouped once up front (not queried per game) - findLatestAtOrBefore
  // (providers/snapshot-utils.ts) does an in-memory scan per lookup instead
  // of a DB query, since a backtest can touch this per condition per
  // historical game.
  const tendencySnapshotsByTeam = new Map<string, typeof tendencySnapshotRows>();
  for (const row of tendencySnapshotRows) {
    const list = tendencySnapshotsByTeam.get(row.teamName);
    if (list) list.push(row);
    else tendencySnapshotsByTeam.set(row.teamName, [row]);
  }
  const teamSnapshotsByTeam = new Map<string, typeof teamStatSnapshotRows>();
  for (const row of teamStatSnapshotRows) {
    const list = teamSnapshotsByTeam.get(row.teamName);
    if (list) list.push(row);
    else teamSnapshotsByTeam.set(row.teamName, [row]);
  }
  const pitcherSnapshotsByPitcherId = new Map<number, typeof pitcherStatSnapshotRows>();
  for (const row of pitcherStatSnapshotRows) {
    const list = pitcherSnapshotsByPitcherId.get(row.pitcherId);
    if (list) list.push(row);
    else pitcherSnapshotsByPitcherId.set(row.pitcherId, [row]);
  }
  // Keyed like GameResult (sportKey scoped here, externalId is the map key) -
  // GameStarters is written independently of GameResult (see stat-snapshots.ts),
  // so a game with no captured starters (predates GameStarters, or no
  // probable pitcher was ever announced) simply has no entry here.
  const gameStartersByExternalId = new Map(gameStarterRows.map((g) => [g.externalId, g]));

  let matches = 0;
  let targetHits = 0;

  for (const game of gameResults) {
    const oddsGame = findOddsGameForResult(oddsGames, game);
    if (!oddsGame) continue;

    const favDog = favoriteUnderdogFromMoneyline(oddsGame);
    if (!favDog) continue;
    const line = totalLine(oddsGame);

    const starters = gameStartersByExternalId.get(game.externalId);
    const favoriteIsHome = favDog.favoriteTeam === game.homeTeam;
    const favoritePitcherId = starters ? (favoriteIsHome ? starters.homePitcherId : starters.awayPitcherId) : null;
    const underdogPitcherId = starters ? (favoriteIsHome ? starters.awayPitcherId : starters.homePitcherId) : null;

    const historicalRef: HistoricalGameRef = {
      oddsGame,
      favoriteTeam: favDog.favoriteTeam,
      underdogTeam: favDog.underdogTeam,
      favoriteMoneyline: favDog.favoriteMoneyline,
      underdogMoneyline: favDog.underdogMoneyline,
      favoritePitcherId,
      underdogPitcherId,
      gameDate: game.gameDate,
      tendencySnapshotsByTeam,
      teamSnapshotsByTeam,
      pitcherSnapshotsByPitcherId,
    };

    const conditionsPass = evaluateConditionTree(tree, (leaf) => {
      const variable = getModelVariable(leaf.variableId);
      const provider = variable ? getVariableProvider(variable.sourceId) : undefined;
      if (!provider) return false;
      const actual = provider.resolveHistorical(historicalRef, leaf.variableId, leaf.side);
      return actual !== null && evaluateComparison(leaf.operator, actual, leaf.threshold);
    });
    if (!conditionsPass) continue;

    const homeWon = game.homeScore > game.awayScore;
    const isTie = game.homeScore === game.awayScore;
    const actualTotal = game.homeScore + game.awayScore;

    let outcome: boolean | null = null;
    if (target === "FAVORITE_ML") {
      outcome = isTie ? null : (favDog.favoriteTeam === game.homeTeam) === homeWon;
    } else if (target === "UNDERDOG_ML") {
      outcome = isTie ? null : (favDog.underdogTeam === game.homeTeam) === homeWon;
    } else if (target === "OVER") {
      outcome = line === null || actualTotal === line ? null : actualTotal > line;
    } else if (target === "UNDER") {
      outcome = line === null || actualTotal === line ? null : actualTotal < line;
    }
    if (outcome === null) continue;

    matches++;
    if (outcome) targetHits++;
  }

  if (matches < MIN_BACKTEST_SAMPLE) return { status: "insufficient_sample", sampleSize: matches };
  return { status: "ready", sampleSize: matches, historicalWinRate: targetHits / matches };
}

export type ModelEdge = {
  modelWinRate: number;
  marketImpliedProbability: number;
  edge: number;
};

export type ModelPreview = {
  conditionResults: ConditionResult[];
  allConditionsMet: boolean;
  health: ModelHealth;
  edge: ModelEdge | null;
};

// The right-panel "Live preview": evaluates conditions against one real
// game's current context, backtests the model, and - only when the game
// actually satisfies every condition AND a real market price exists for the
// model's target - computes the edge vs. that game's own market price.
export async function previewModel(sportKey: string, target: ModelTarget, tree: ConditionTree, ctx: GameContext): Promise<ModelPreview> {
  const conditionResults = evaluateConditionResults(ctx, tree);
  const allConditionsMet = allConditionsSatisfied(ctx, tree);

  const health = await backtestModel(sportKey, target, tree);

  let edge: ModelEdge | null = null;
  if (health.status === "ready" && allConditionsMet) {
    const marketPrice =
      target === "FAVORITE_ML"
        ? ctx.favoriteMoneyline
        : target === "UNDERDOG_ML"
          ? ctx.underdogMoneyline
          : target === "OVER"
            ? ctx.totalOverPrice
            : ctx.totalUnderPrice;

    if (marketPrice !== null) {
      const marketImpliedProbability = americanOddsToImpliedProbability(marketPrice);
      edge = {
        modelWinRate: health.historicalWinRate,
        marketImpliedProbability,
        edge: health.historicalWinRate - marketImpliedProbability,
      };
    }
  }

  return { conditionResults, allConditionsMet, health, edge };
}
