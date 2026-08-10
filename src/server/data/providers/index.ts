import { mlbStatsProvider } from "./mlb-stats-provider";
import { tendencyProvider } from "./tendency-provider";
import { oddsMarketProvider } from "./odds-market-provider";
import type { VariableProvider } from "./types";

// The full registry - the ONLY place model-evaluation.ts (and anything else)
// should look up how to resolve a variable. Adding a data source later means
// writing a new provider file and adding one line here, not touching
// resolveVariable/backtestModel.
const VARIABLE_PROVIDERS: Record<string, VariableProvider> = {
  [mlbStatsProvider.sourceId]: mlbStatsProvider,
  [tendencyProvider.sourceId]: tendencyProvider,
  [oddsMarketProvider.sourceId]: oddsMarketProvider,
};

export function getVariableProvider(sourceId: string): VariableProvider | undefined {
  return VARIABLE_PROVIDERS[sourceId];
}

export type { VariableProvider, GameContext, HistoricalGameRef } from "./types";
