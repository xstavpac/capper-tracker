// The Charts feature's data adapter: (sportKey, variable, entity, side?,
// date range) -> a plain time series. This is deliberately NOT a new
// calculation path - every built-in value returned here comes from the
// exact same snapshot-row-to-value functions the model builder's backtester
// already uses (resolveTeamStatFromSnapshot / resolvePitcherStatFromSnapshot
// / readRate+computeTendencyRates), imported directly rather than
// reimplemented, so a value a user sees on a chart is provably the same
// value that variable would resolve to as a model condition.
//
// Query shape: exactly one ranged query per call (`WHERE sportKey = ? AND
// <entity column> = ? AND snapshotDate BETWEEN ? AND ?`), reading rows that
// already sit in Postgres from the daily snapshot cron (or, for a custom
// metric, from the user's own CSV import) - no external API calls at any
// point, regardless of how wide the range or how many variables a caller
// requests. This is the "one ranged query per variable-entity pair" pattern
// flagged as a hard requirement during the Phase 1 audit; do not replace it
// with a per-day or per-condition query loop.
//
// Dispatch is a registry keyed by ModelVariableDef.sourceId (see
// PROVIDERS below), not a branch on `category` - adding a new data source
// (built-in or, as of Custom Metrics, user-uploaded) means registering one
// more provider function here, never adding another `if` to this file's own
// logic. getHistoricalVariableSeries itself doesn't know or care whether a
// variable is built-in or custom; neither does any caller.
import { prisma } from "@/lib/prisma";
import {
  getModelVariable,
  MLB_TEAM_STATS_API,
  MLB_PITCHER_STATS_API,
  INTERNAL_TENDENCIES,
  NFL_TEAM_STATS_API,
  USER_UPLOAD,
  type ModelVariableDef,
  type VariableSide,
  type VariableUnit,
} from "@/lib/model-builder";
import { computeTendencyRates } from "@/server/data/team-tendencies";
import { resolveTeamStatFromSnapshot, resolvePitcherStatFromSnapshot } from "@/server/data/providers/mlb-stats-provider";
import { resolveNflTeamStatFromSnapshot } from "@/server/data/providers/nfl-team-stats-provider";
import { readRate } from "@/server/data/providers/tendency-provider";
import { resolveCustomMetricVariable } from "@/server/data/custom-metrics";

export type VariableTimeSeriesPoint = { date: string; value: number | null };

export type VariableTimeSeriesResult = {
  variableId: string;
  variableLabel: string;
  unit: VariableUnit;
  entityId: string;
  side?: VariableSide;
  // False when this variable's category has no charting-capable time series
  // yet (currently: odds_market - see the reason below). The adapter never
  // fabricates a series for an unsupported variable; callers should check
  // this before rendering rather than assume an empty `points` array always
  // means "no data yet."
  supported: boolean;
  unsupportedReason?: string;
  points: VariableTimeSeriesPoint[];
  // Count of points with a real (non-null) value - what "Historical data: N
  // days available" should display. Grows automatically as the daily
  // snapshot cron (or a fresh CSV import) adds rows; never a fixed/
  // precomputed number.
  daysAvailable: number;
  // Count of snapshot rows found in range, regardless of whether their
  // computed value came out null (e.g. MIN_TENDENCY_SAMPLE not met yet).
  // Lets a caller tell "we have no snapshots at all in this range yet" apart
  // from "we have snapshots, but not enough decided games to compute this
  // specific rate" - two different honest messages, not the same gap.
  totalSnapshotDays: number;
};

export type DateRange = { start: string; end: string }; // "YYYY-MM-DD", Eastern, inclusive

function unsupportedResult(
  variableId: string,
  entityId: string,
  side: VariableSide | undefined,
  reason: string
): VariableTimeSeriesResult {
  const variable = getModelVariable(variableId);
  return {
    variableId,
    variableLabel: variable?.label ?? variableId,
    unit: variable?.unit ?? "decimal",
    entityId,
    side,
    supported: false,
    unsupportedReason: reason,
    points: [],
    daysAvailable: 0,
    totalSnapshotDays: 0,
  };
}

// One provider per sourceId - given the already-resolved catalog entry (so
// it never needs to re-look-up variableId) plus the same
// (sportKey, entityId, side, range, userId) every caller already passes.
// Built-ins and Custom Metrics implement this exact same shape; nothing
// about the type favors one over the other. userId is only actually read by
// customMetricProvider (ownership re-check - see there), but every provider
// accepts it for a consistent call signature, same convention `side`
// already follows for the providers that don't need it.
type SeriesProvider = (
  variable: ModelVariableDef,
  sportKey: string,
  entityId: string,
  side: VariableSide | undefined,
  range: DateRange,
  userId: string
) => Promise<VariableTimeSeriesResult>;

// Role-independent when charting a standalone team - ERA is just ERA,
// there's no "as favorite" version of it the way tendency rates have.
// `side` is accepted for a consistent provider signature but not used here.
async function teamStatsProvider(variable: ModelVariableDef, sportKey: string, entityId: string, side: VariableSide | undefined, range: DateRange): Promise<VariableTimeSeriesResult> {
  const rows = await prisma.teamStatSnapshot.findMany({
    where: { sportKey, teamName: entityId, snapshotDate: { gte: range.start, lte: range.end } },
    orderBy: { snapshotDate: "asc" },
  });
  const points = rows.map((row) => ({ date: row.snapshotDate, value: resolveTeamStatFromSnapshot(row, variable.id) }));
  return {
    variableId: variable.id,
    variableLabel: variable.label,
    unit: variable.unit,
    entityId,
    side,
    supported: true,
    points,
    daysAvailable: points.filter((p) => p.value !== null).length,
    totalSnapshotDays: rows.length,
  };
}

// NflTeamStatSnapshot is one row per team per GAME (not per calendar day
// like MLB's cumulative snapshots) - so `date` here is the game date and
// daysAvailable/totalSnapshotDays read as game counts, not day counts. Its
// own dedicated table has no sportKey column (NFL-only by construction), so
// `sportKey` is accepted for the shared provider signature but not used, the
// same way `side` is. entityId is the full "City Nickname" team name, which
// is exactly what NflTeamStatSnapshot.team stores.
async function nflTeamStatsProvider(variable: ModelVariableDef, sportKey: string, entityId: string, side: VariableSide | undefined, range: DateRange): Promise<VariableTimeSeriesResult> {
  const rows = await prisma.nflTeamStatSnapshot.findMany({
    where: { team: entityId, gameDate: { gte: range.start, lte: range.end } },
    orderBy: { gameDate: "asc" },
  });
  const points = rows.map((row) => ({ date: row.gameDate, value: resolveNflTeamStatFromSnapshot(row, variable.id) }));
  return {
    variableId: variable.id,
    variableLabel: variable.label,
    unit: variable.unit,
    entityId,
    side,
    supported: true,
    points,
    daysAvailable: points.filter((p) => p.value !== null).length,
    totalSnapshotDays: rows.length,
  };
}

async function pitcherStatsProvider(variable: ModelVariableDef, sportKey: string, entityId: string, side: VariableSide | undefined, range: DateRange): Promise<VariableTimeSeriesResult> {
  const pitcherId = Number(entityId);
  if (!Number.isFinite(pitcherId)) return unsupportedResult(variable.id, entityId, side, "Invalid pitcher id.");
  const rows = await prisma.pitcherStatSnapshot.findMany({
    where: { sportKey, pitcherId, snapshotDate: { gte: range.start, lte: range.end } },
    orderBy: { snapshotDate: "asc" },
  });
  const points = rows.map((row) => ({ date: row.snapshotDate, value: resolvePitcherStatFromSnapshot(row, variable.id) }));
  return {
    variableId: variable.id,
    variableLabel: variable.label,
    unit: variable.unit,
    entityId,
    side,
    supported: true,
    points,
    daysAvailable: points.filter((p) => p.value !== null).length,
    totalSnapshotDays: rows.length,
  };
}

// No side requirement here, unlike the model builder's game-relative
// condition rows: readRate switches on variableId alone
// ("tendency_fav_win_pct" vs "tendency_dog_win_pct" are already two
// distinct catalog entries/two distinct stored rates of the SAME team), and
// over/under rate are role-independent entirely (accumulated across every
// game regardless of favorite/dog role - see computeTendencyRates). `side`
// is still accepted/carried through for callers that want it in the result
// (e.g. building a model-builder deep link), just never required to
// compute a value.
async function tendencyProvider(variable: ModelVariableDef, sportKey: string, entityId: string, side: VariableSide | undefined, range: DateRange): Promise<VariableTimeSeriesResult> {
  const rows = await prisma.teamTendencySnapshot.findMany({
    where: { sportKey, teamName: entityId, snapshotDate: { gte: range.start, lte: range.end } },
    orderBy: { snapshotDate: "asc" },
  });
  const points = rows.map((row) => ({ date: row.snapshotDate, value: readRate(computeTendencyRates(row), variable.id) }));
  return {
    variableId: variable.id,
    variableLabel: variable.label,
    unit: variable.unit,
    entityId,
    side,
    supported: true,
    points,
    daysAvailable: points.filter((p) => p.value !== null).length,
    totalSnapshotDays: rows.length,
  };
}

// A user-uploaded metric (see server/data/custom-metrics.ts for the import
// side). entityId is a team name for a team-scoped metric, or ignored
// entirely for a global one (variable.id is the CustomMetric's own id,
// looked up directly - custom metric ids are real cuids, never collide with
// a built-in variable's short hand-picked id string). teamName is null in
// the query for a global metric (hasTeamColumn: false at import time
// guarantees every CustomMetricPoint row for it also has a null teamName),
// matching the "ignore the selected team" rule from the import spec.
//
// userId is checked again here even though getHistoricalVariableSeries
// below already only reaches this provider via a variable resolved through
// resolveCustomMetricVariable's own ownership-scoped query - defense in
// depth against this provider ever being reached some other way in the
// future, same "re-check ownership at the point of use, don't rely solely
// on an earlier check" pattern used throughout this app's server/data/*
// mutations (e.g. deleteCapper).
async function customMetricProvider(variable: ModelVariableDef, sportKey: string, entityId: string, side: VariableSide | undefined, range: DateRange, userId: string): Promise<VariableTimeSeriesResult> {
  const metric = await prisma.customMetric.findFirst({ where: { id: variable.id, userId, sportKey } });
  if (!metric) return unsupportedResult(variable.id, entityId, side, "This custom metric no longer exists.");

  const rows = await prisma.customMetricPoint.findMany({
    where: {
      customMetricId: metric.id,
      teamName: metric.hasTeamColumn ? entityId : null,
      snapshotDate: { gte: range.start, lte: range.end },
    },
    orderBy: { snapshotDate: "asc" },
  });
  const points = rows.map((row) => ({ date: row.snapshotDate, value: row.value }));
  return {
    variableId: variable.id,
    variableLabel: variable.label,
    unit: variable.unit,
    entityId,
    side,
    supported: true,
    points,
    daysAvailable: points.length, // every stored point is a real value - no MIN_SAMPLE-style nulling for a custom metric
    totalSnapshotDays: rows.length,
  };
}

const PROVIDERS: Record<string, SeriesProvider> = {
  [MLB_TEAM_STATS_API]: teamStatsProvider,
  [MLB_PITCHER_STATS_API]: pitcherStatsProvider,
  [NFL_TEAM_STATS_API]: nflTeamStatsProvider,
  [INTERNAL_TENDENCIES]: tendencyProvider,
  [USER_UPLOAD]: customMetricProvider,
  // odds_market variables (sourceId "odds_api") deliberately have no
  // registered provider - charting them per standalone team would mean
  // scanning every day's OddsSnapshot blob for a game involving that team
  // and applying favorite/underdog role-matching per game, a genuinely
  // different query shape than the per-entity snapshot tables every
  // registered provider shares. Falls through to the "no provider
  // registered" branch below, same observable behavior as before this file
  // had a registry at all.
};

export async function getHistoricalVariableSeries(
  sportKey: string,
  variableId: string,
  entityId: string,
  side: VariableSide | undefined,
  range: DateRange,
  userId: string
): Promise<VariableTimeSeriesResult> {
  // getModelVariable only ever knows about the fixed built-in catalog
  // (it's a synchronous, prisma-free lookup by design - see
  // lib/model-builder.ts). A variableId it doesn't recognize might still be
  // one of THIS user's own Custom Metrics, so that's checked next -
  // ownership-scoped by resolveCustomMetricVariable itself, so a variableId
  // belonging to a different user's metric resolves to null here exactly
  // like a nonexistent one would, not "found but not yours".
  const variable = getModelVariable(variableId) ?? (await resolveCustomMetricVariable(userId, variableId));
  if (!variable) return unsupportedResult(variableId, entityId, side, "Unknown variable.");

  const provider = PROVIDERS[variable.sourceId];
  if (!provider) return unsupportedResult(variableId, entityId, side, "Charting isn't available yet for this variable.");

  return provider(variable, sportKey, entityId, side, range, userId);
}
