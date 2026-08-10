// The Charts feature's data adapter: (sportKey, variable, entity, side?,
// date range) -> a plain time series. This is deliberately NOT a new
// calculation path - every value returned here comes from the exact same
// snapshot-row-to-value functions the model builder's backtester already
// uses (resolveTeamStatFromSnapshot / resolvePitcherStatFromSnapshot /
// readRate+computeTendencyRates), imported directly rather than
// reimplemented, so a value a user sees on a chart is provably the same
// value that variable would resolve to as a model condition.
//
// Query shape: exactly one ranged query per call (`WHERE sportKey = ? AND
// <entity column> = ? AND snapshotDate BETWEEN ? AND ?`), reading rows that
// already sit in Postgres from the daily snapshot cron - no external API
// calls at any point, regardless of how wide the range or how many
// variables a caller requests. This is the "one ranged query per variable-
// entity pair" pattern flagged as a hard requirement during the Phase 1
// audit; do not replace it with a per-day or per-condition query loop.
import { prisma } from "@/lib/prisma";
import { getModelVariable, type VariableSide, type VariableUnit } from "@/lib/model-builder";
import { computeTendencyRates } from "@/server/data/team-tendencies";
import { resolveTeamStatFromSnapshot, resolvePitcherStatFromSnapshot } from "@/server/data/providers/mlb-stats-provider";
import { readRate } from "@/server/data/providers/tendency-provider";

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
  // snapshot cron adds rows; never a fixed/precomputed number.
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

export async function getHistoricalVariableSeries(
  sportKey: string,
  variableId: string,
  entityId: string,
  side: VariableSide | undefined,
  range: DateRange
): Promise<VariableTimeSeriesResult> {
  const variable = getModelVariable(variableId);
  if (!variable) return unsupportedResult(variableId, entityId, side, "Unknown variable.");

  if (variable.category === "team_stats") {
    // Role-independent when charting a standalone team - ERA is just ERA,
    // there's no "as favorite" version of it the way tendency rates have.
    // `side` is accepted for a consistent call signature but not used here.
    const rows = await prisma.teamStatSnapshot.findMany({
      where: { sportKey, teamName: entityId, snapshotDate: { gte: range.start, lte: range.end } },
      orderBy: { snapshotDate: "asc" },
    });
    const points = rows.map((row) => ({ date: row.snapshotDate, value: resolveTeamStatFromSnapshot(row, variableId) }));
    return {
      variableId,
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

  if (variable.category === "pitcher_stats") {
    const pitcherId = Number(entityId);
    if (!Number.isFinite(pitcherId)) return unsupportedResult(variableId, entityId, side, "Invalid pitcher id.");
    const rows = await prisma.pitcherStatSnapshot.findMany({
      where: { sportKey, pitcherId, snapshotDate: { gte: range.start, lte: range.end } },
      orderBy: { snapshotDate: "asc" },
    });
    const points = rows.map((row) => ({ date: row.snapshotDate, value: resolvePitcherStatFromSnapshot(row, variableId) }));
    return {
      variableId,
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

  if (variable.category === "team_tendencies") {
    // No side requirement here, unlike the model builder's game-relative
    // condition rows: readRate switches on variableId alone
    // ("tendency_fav_win_pct" vs "tendency_dog_win_pct" are already two
    // distinct catalog entries/two distinct stored rates of the SAME team),
    // and over/under rate are role-independent entirely (accumulated across
    // every game regardless of favorite/dog role - see computeTendencyRates).
    // `side` is still accepted/carried through for callers that want it in
    // the result (e.g. building a model-builder deep link), just never
    // required to compute a value.
    const rows = await prisma.teamTendencySnapshot.findMany({
      where: { sportKey, teamName: entityId, snapshotDate: { gte: range.start, lte: range.end } },
      orderBy: { snapshotDate: "asc" },
    });
    const points = rows.map((row) => ({ date: row.snapshotDate, value: readRate(computeTendencyRates(row), variableId) }));
    return {
      variableId,
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

  // odds_market: deliberately out of scope for this pass. These variables
  // are properties of a specific matchup ("the favorite's moneyline"), read
  // from OddsSnapshot's one-JSON-blob-per-day-per-sport shape - charting them
  // per standalone team would mean scanning every day's blob for a game
  // involving that team and applying favorite/underdog role-matching per
  // game, a genuinely different query shape than the per-entity snapshot
  // tables the other three categories share. Flagged as a known gap rather
  // than guessed at.
  return unsupportedResult(variableId, entityId, side, "Charting isn't available yet for odds/market variables.");
}
