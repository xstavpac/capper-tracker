// The Parlay slip's picks as "Send to FanDuel" (components/parlay/send-to-fanduel.tsx)
// takes them: the pick id it sends, plus the bet text and game it shows each
// leg under. Every pick goes, in slip order - the server reads each one by id
// and does all the FanDuel matching (nearest line, legs it can't send), the
// same as for a built parlay. Nothing is filtered or decided here.
import type { SendLeg } from "@/components/parlay/send-to-fanduel";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

export type SlipLeg = Pick<ExpanderPick, "pickId" | "betDetail" | "gameId" | "gameLabel">;

export function slipSendLegs(slip: readonly SlipLeg[]): SendLeg[] {
  return slip.map((p) => ({ pickId: p.pickId, betDetail: p.betDetail, gameId: p.gameId, gameLabel: p.gameLabel }));
}
