// Pure reconciliation of a persisted Parlay slip against current DB state (see
// parlay-pool-context.tsx). The stored slip is only a list of pick ids to look
// up - every displayed value (status, odds, game time) is overwritten from
// `states`, and any leg that is no longer a live, pre-game, pending pick is
// pruned with a human-readable result for the one-time notice.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { SlipPickState } from "@/server/actions/parlay-slip";

export type PrunedLegResult = "Won" | "Lost" | "Push" | "Void" | "Started" | "Removed";

export type PrunedLeg = {
  pickId: string;
  label: string; // "Capper - Away @ Home - bet detail"
  result: PrunedLegResult;
};

function gradedResult(status: SlipPickState["status"]): PrunedLegResult | null {
  switch (status) {
    case "WIN":
      return "Won";
    case "LOSS":
      return "Lost";
    case "PUSH":
      return "Push";
    case "CANCELLED":
      return "Void";
    default:
      return null;
  }
}

export function reconcileSlip(
  legs: ExpanderPick[],
  states: Record<string, SlipPickState>
): { kept: ExpanderPick[]; pruned: PrunedLeg[] } {
  const kept: ExpanderPick[] = [];
  const pruned: PrunedLeg[] = [];
  for (const leg of legs) {
    const s = states[leg.pickId];
    const label = leg.capperName + " - " + leg.gameLabel + " - " + leg.betDetail;
    // Precedence: gone > graded > started.
    const result: PrunedLegResult | null = !s ? "Removed" : (gradedResult(s.status) ?? (s.started ? "Started" : null));
    if (result) {
      pruned.push({ pickId: leg.pickId, label, result });
    } else {
      kept.push({ ...leg, status: s.status, odds: s.odds, gameTime: s.gameTime });
    }
  }
  return { kept, pruned };
}
