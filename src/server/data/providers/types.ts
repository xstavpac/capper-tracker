// The variable-provider interface: every data source the model builder can
// read from (MLB Stats API, our own derived tendencies, the odds market)
// implements this, and the condition engine/backtester (model-evaluation.ts)
// only ever calls through it via a variable's sourceId - never a specific
// API function directly. Adding a new data source later means writing one
// new provider file and registering it in index.ts, not touching
// resolveVariable/backtestModel or the UI.
//
// GameContext lives here (not model-evaluation.ts) specifically to avoid a
// circular import: providers need the type to implement resolveLive, and
// model-evaluation.ts needs it to build the object - this file is the
// natural shared home since it's what defines the provider contract both
// sides agree to.

import type { OddsGame } from "@/server/data/odds";
import type { VariableSide } from "@/lib/model-builder";
import type { TeamSeasonStats, PitcherSeasonStats } from "@/server/data/mlb-stats";
import type { TeamTendencyRates } from "@/server/data/team-tendencies";
import type { TeamStatSnapshot } from "@prisma/client";

// One resolved game's live data, built once (see model-evaluation.ts's
// buildGameContext) and read by every provider - kept as a single eagerly-
// fetched object rather than each provider lazily fetching its own slice, so
// N conditions referencing the same team's stats cost one fetch, not N. This
// batch-fetch orchestration is deliberately NOT abstracted behind the
// provider interface (see model-evaluation.ts's buildGameContext comment) -
// the registry/provider boundary here covers resolution, not fetching.
export type GameContext = {
  homeTeam: string;
  awayTeam: string;
  favoriteTeam: string | null;
  underdogTeam: string | null;
  favoriteMoneyline: number | null;
  underdogMoneyline: number | null;
  totalLine: number | null;
  totalOverPrice: number | null;
  totalUnderPrice: number | null;
  spread: number | null;
  favoriteStats: TeamSeasonStats | null;
  underdogStats: TeamSeasonStats | null;
  favoriteTendency: TeamTendencyRates | null;
  underdogTendency: TeamTendencyRates | null;
  favoritePitcher: PitcherSeasonStats | null;
  underdogPitcher: PitcherSeasonStats | null;
};

// Everything a provider needs to resolve one variable for one HISTORICAL
// game during a backtest. tendencyByTeam and teamSnapshotsByTeam are both
// preloaded once per backtest run (not per game/condition) to avoid an N+1
// query across every historical game being scored - teamSnapshotsByTeam's
// arrays are pre-sorted ascending by snapshotDate so a provider can do an
// in-memory "latest snapshot at or before gameDate" scan instead of a DB
// query per lookup.
export type HistoricalGameRef = {
  oddsGame: OddsGame;
  favoriteTeam: string;
  underdogTeam: string;
  favoriteMoneyline: number;
  underdogMoneyline: number;
  gameDate: Date;
  tendencyByTeam: Map<string, TeamTendencyRates>;
  teamSnapshotsByTeam: Map<string, TeamStatSnapshot[]>;
};

export interface VariableProvider {
  sourceId: string;
  // Declares whether resolveHistorical can ever return real data for a
  // specific variable from this source - a static capability, not something
  // callers infer from a null result (null legitimately also means "no data
  // for THIS one game/date"). Per-variable rather than a flat per-provider
  // boolean because mlbStatsProvider is asymmetric: team_stats variables can
  // be backtested once enough daily snapshots accumulate, but pitcher_stats
  // variables can't yet (no record of which pitcher started which historical
  // game to join a pitcher snapshot against) - see mlbStatsProvider's own
  // comment. backtestModel uses this to report an honest "unsupported"
  // reason instead of silently comparing today's numbers against past games.
  supportsHistorical(variableId: string): boolean;
  resolveLive(ctx: GameContext, variableId: string, side?: VariableSide): number | null;
  resolveHistorical(ref: HistoricalGameRef, variableId: string, side?: VariableSide): number | null;
}
