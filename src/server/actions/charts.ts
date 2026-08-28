"use server";

import { requireUser } from "@/server/auth";
import { getHistoricalVariableSeries, type VariableTimeSeriesResult, type DateRange } from "@/server/data/historical-variables";
import type { VariableSide } from "@/lib/model-builder";

// Thin auth-gated wrapper around the adapter - the Charts workspace (a
// Client Component) can't call a prisma-touching function directly, same
// reason every other server/data/* read in this app goes through an action
// or a Server Component prop. No new calculation here, just the auth check.
export async function getVariableSeriesAction(
  sportKey: string,
  variableId: string,
  entityId: string,
  side: VariableSide | undefined,
  range: DateRange
): Promise<VariableTimeSeriesResult> {
  const user = await requireUser();
  return getHistoricalVariableSeries(sportKey, variableId, entityId, side, range, user.id);
}
