// The DATA layer's common resolver - resolveVariable(variableId, entity,
// asOf, context) -> ResolvedValue. Wraps the three existing, already-proven
// resolvers (readRate / resolveTeamStatFromSnapshot /
// resolvePitcherStatFromSnapshot) and findLatestAtOrBefore exactly as they
// already work - this file adds the query + dispatch-by-category glue
// around them, not a second implementation of what they already do.
import { prisma } from "@/lib/prisma";
import { getModelVariable, type VariableCategory } from "@/lib/model-builder";
import { startOfEasternDay } from "@/lib/dates";
import { findLatestAtOrBefore } from "@/server/data/providers/snapshot-utils";
import { readRate } from "@/server/data/providers/tendency-provider";
import { resolveTeamStatFromSnapshot, resolvePitcherStatFromSnapshot } from "@/server/data/providers/mlb-stats-provider";
import { computeTendencyRates } from "@/server/data/team-tendencies";
import type { EntityRef, EvaluationContext, ResolvedValue } from "./types";

const NOT_FOUND: ResolvedValue = { value: null, timestamp: null, found: false };

// snapshotDate is stored as a bare "YYYY-MM-DD" Eastern calendar-day string
// (see schema.prisma), not a DateTime - this reconstructs the UTC instant
// of that day's Eastern midnight via the existing startOfEasternDay
// helper (unmodified), which is always <= any instant later that same
// Eastern day. That's what makes `resolvedValue.timestamp <= asOf` hold
// whenever the source snapshotDate is at-or-before asOf's own Eastern day -
// startOfEasternDay(D1) <= startOfEasternDay(D2) <= asOf whenever D1 <= D2
// and asOf falls within Eastern day D2 (which is exactly what
// easternDateKey(asOf) === D2 means).
function snapshotDateToTimestamp(snapshotDate: string): Date {
  return startOfEasternDay(new Date(`${snapshotDate}T12:00:00.000Z`));
}

function requireTeam(entity: EntityRef, category: VariableCategory): string {
  if (entity.type !== "team") {
    throw new Error(`${category} variables require a team EntityRef, got entity.type "${entity.type}".`);
  }
  return entity.teamName;
}

function requirePitcher(entity: EntityRef, category: VariableCategory): number {
  if (entity.type !== "pitcher") {
    throw new Error(`${category} variables require a pitcher EntityRef, got entity.type "${entity.type}".`);
  }
  return entity.pitcherId;
}

// Deliberately no `snapshotDate: { lte: ... }` in any of these three
// queries below - fetching the full per-entity history and letting
// findLatestAtOrBefore be the ONLY place that decides what counts as "at
// or before asOf" is what "not duplicated, not bypassed" actually means
// here. A query-level date filter would technically still be correct, but
// it would make findLatestAtOrBefore redundant on this path instead of
// load-bearing - exactly the kind of second implementation this step was
// told not to introduce.
async function resolveTeamTendency(variableId: string, teamName: string, asOf: Date, sportKey: string): Promise<ResolvedValue> {
  const rows = await prisma.teamTendencySnapshot.findMany({
    where: { sportKey, teamName },
    orderBy: { snapshotDate: "asc" },
  });
  const row = findLatestAtOrBefore(rows, asOf);
  if (!row) return NOT_FOUND;
  return { value: readRate(computeTendencyRates(row), variableId), timestamp: snapshotDateToTimestamp(row.snapshotDate), found: true };
}

async function resolveTeamStat(variableId: string, teamName: string, asOf: Date, sportKey: string): Promise<ResolvedValue> {
  const rows = await prisma.teamStatSnapshot.findMany({
    where: { sportKey, teamName },
    orderBy: { snapshotDate: "asc" },
  });
  const row = findLatestAtOrBefore(rows, asOf);
  if (!row) return NOT_FOUND;
  return { value: resolveTeamStatFromSnapshot(row, variableId), timestamp: snapshotDateToTimestamp(row.snapshotDate), found: true };
}

async function resolvePitcherStat(variableId: string, pitcherId: number, asOf: Date, sportKey: string): Promise<ResolvedValue> {
  const rows = await prisma.pitcherStatSnapshot.findMany({
    where: { sportKey, pitcherId },
    orderBy: { snapshotDate: "asc" },
  });
  const row = findLatestAtOrBefore(rows, asOf);
  if (!row) return NOT_FOUND;
  return { value: resolvePitcherStatFromSnapshot(row, variableId), timestamp: snapshotDateToTimestamp(row.snapshotDate), found: true };
}

export async function resolveVariable(
  variableId: string,
  entity: EntityRef,
  asOf: Date,
  context: EvaluationContext
): Promise<ResolvedValue> {
  const variable = getModelVariable(variableId);
  if (!variable) throw new Error(`Unknown variableId "${variableId}" - not in MODEL_VARIABLES.`);

  switch (variable.category) {
    case "team_tendencies":
      return resolveTeamTendency(variableId, requireTeam(entity, variable.category), asOf, context.sportKey);
    case "team_stats":
      return resolveTeamStat(variableId, requireTeam(entity, variable.category), asOf, context.sportKey);
    case "pitcher_stats":
      return resolvePitcherStat(variableId, requirePitcher(entity, variable.category), asOf, context.sportKey);
    case "odds_market":
      // historical-variables.ts (Charts' own data adapter) flags this exact
      // gap already: odds_market variables live in OddsSnapshot's one-blob-
      // per-day-per-sport shape, a genuinely different query shape than the
      // per-entity snapshot tables the other three categories share. Not
      // implemented here either - a known, flagged gap, not a guess.
      throw new Error("odds_market variables are not resolvable yet (same known gap as Charts - see historical-variables.ts).");
    case "custom_metric":
      // Unreachable in practice: getModelVariable(variableId) above only
      // ever searches the fixed MODEL_VARIABLES catalog, which custom
      // metrics are never added to (they're merged in separately, at
      // request time, only for Charts - see getCustomMetricVariables in
      // server/data/custom-metrics.ts) - so a real custom metric id would
      // already have thrown "Unknown variableId" before reaching this
      // switch at all. Handled explicitly anyway so this stays an
      // exhaustive, compiler-checked switch over VariableCategory rather
      // than silently falling through the `default` case if that ever
      // changed.
      throw new Error("Custom metrics aren't resolvable as model conditions - they're a Charts-only variable source.");
    default: {
      const exhaustive: never = variable.category;
      throw new Error(`Unhandled variable category "${exhaustive}".`);
    }
  }
}
