// Pure reconciliation of a persisted Parlay slip against current DB state (see
// parlay-pool-context.tsx). The stored slip is only a list of pick ids to look
// up - status and odds are overwritten from `states`, and any leg that is no
// longer a pending pick on a game that is not over (live is fine, game-over.ts) is pruned with a human-readable result
// for the one-time notice.
//
// A leg's gameTime is its game's kickoff, captured from the board when the
// pick was added. It is replaced only by a kickoff the server looked up
// (`kickoff`) - never by the pick row's own stored time, which for a pick
// imported without a matched game is the import time, not the game's.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { SlipPickState } from "@/server/actions/parlay-slip";
import { isGameOver } from "@/lib/parlay/game-over";

export type PrunedLegResult = "Won" | "Lost" | "Push" | "Void" | "Over" | "Removed";

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
  states: Record<string, SlipPickState>,
  now: number = Date.now()
): { kept: ExpanderPick[]; pruned: PrunedLeg[] } {
  const kept: ExpanderPick[] = [];
  const pruned: PrunedLeg[] = [];
  for (const leg of legs) {
    const s = states[leg.pickId];
    const label = leg.capperName + " - " + leg.gameLabel + " - " + leg.betDetail;
    // Precedence: gone > graded > over. When the server couldn't find the
    // game (over === null) the leg's own kickoff and last status decide.
    const over = s ? (s.over ?? isGameOver(leg, new Date(now))) : false;
    const result: PrunedLegResult | null = !s ? "Removed" : (gradedResult(s.status) ?? (over ? "Over" : null));
    if (result) {
      pruned.push({ pickId: leg.pickId, label, result });
    } else {
      kept.push({ ...leg, status: s.status, odds: s.odds, gameTime: s.kickoff ?? leg.gameTime, gameStatus: s.gameStatus });
    }
  }
  return { kept, pruned };
}
