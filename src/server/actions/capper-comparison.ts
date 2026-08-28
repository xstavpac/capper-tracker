"use server";

import { requireUser } from "@/server/auth";
import { getCapperComparison, type ComparisonFilters, type CapperComparisonProfile } from "@/server/data/capper-comparison";

// Thin auth-gated wrapper, same pattern as getVariableSeriesAction
// (server/actions/charts.ts) - ownership scoping happens inside
// getCapperComparison itself (getCapperById/getPicksForCapper are both
// userId-scoped), this only adds the session check.
export async function getCapperComparisonAction(
  capperAId: string,
  capperBId: string,
  filters: ComparisonFilters
): Promise<{ a: CapperComparisonProfile; b: CapperComparisonProfile }> {
  const user = await requireUser();
  return getCapperComparison(user.id, capperAId, capperBId, filters);
}
