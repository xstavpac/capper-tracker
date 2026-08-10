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
import type { TeamStatSnapshot, PitcherStatSnapshot } from "@prisma/client";

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
// game during a backtest. tendencyByTeam, teamSnapshotsByTeam, and
// pitcherSnapshotsByPitcherId are all preloaded once per backtest run (not
// per game/condition) to avoid an N+1 query across every historical game
// being scored - the snapshot arrays are pre-sorted ascending by
// snapshotDate so a provider can do an in-memory "latest snapshot at or
// before gameDate" scan instead of a DB query per lookup. favoritePitcherId/
// underdogPitcherId come from a GameStarters row for this game, if one was
// captured (null otherwise - a game outside the window GameStarters has been
// running, or a day with no announced probable starter).
export type HistoricalGameRef = {
  oddsGame: OddsGame;
  favoriteTeam: string;
  underdogTeam: string;
  favoriteMoneyline: number;
  underdogMoneyline: number;
  favoritePitcherId: number | null;
  underdogPitcherId: number | null;
  gameDate: Date;
  tendencyByTeam: Map<string, TeamTendencyRates>;
  teamSnapshotsByTeam: Map<string, TeamStatSnapshot[]>;
  pitcherSnapshotsByPitcherId: Map<number, PitcherStatSnapshot[]>;
};

export interface VariableProvider {
  sourceId: string;
  // Declares whether resolveHistorical can ever return real data for a
  // specific variable from this source - a static capability, not something
  // callers infer from a null result (null legitimately also means "no data
  // for THIS one game/date/pitcher"). Per-variable rather than a flat
  // per-provider boolean since different variable categories from the same
  // source can have different data-readiness stories over time.
  // backtestModel uses this to report an honest "unsupported" reason instead
  // of silently comparing today's numbers against past games.
  supportsHistorical(variableId: string): boolean;
  resolveLive(ctx: GameContext, variableId: string, side?: VariableSide): number | null;
  resolveHistorical(ref: HistoricalGameRef, variableId: string, side?: VariableSide): number | null;
}
