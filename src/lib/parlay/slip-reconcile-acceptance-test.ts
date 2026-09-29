// Acceptance test for reconcileSlip (slip-reconcile.ts).
import { reconcileSlip } from "./slip-reconcile";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import type { SlipPickState } from "@/server/actions/parlay-slip";

let failed = 0;
function check(name: string, ok: boolean) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) failed++;
}

function leg(id: string): ExpanderPick {
  return {
    pickId: id, capperId: "c", capperName: "Cap", capperColorTag: null, capperIsFavorite: false, category: null,
    leagueName: "MLB", gameId: "g" + id, gameLabel: "A @ B", betDetail: "B -1.5", odds: -110, units: 1,
    status: "PENDING", betType: "SPREAD", period: "FULL_GAME", rawBetDetail: null, line: -1.5,
    homeTeam: "B", awayTeam: "A", gameTime: "2020-01-01T00:00:00.000Z", teamGroup: "HOME", teamLabel: "B", teamColor: null,
  };
}
const st = (status: SlipPickState["status"], started: boolean, odds = -120): SlipPickState => ({
  status, odds, started, gameTime: "2030-01-01T00:00:00.000Z",
});

const legs = [leg("graded"), leg("started"), leg("future"), leg("gone")];
const states = { graded: st("WIN", true), started: st("PENDING", true), future: st("PENDING", false, +150) };
const { kept, pruned } = reconcileSlip(legs, states);
check("only the future leg remains", kept.length === 1 && kept[0].pickId === "future");
check("kept leg takes current odds/gameTime, not the snapshot", kept[0].odds === 150 && kept[0].gameTime.startsWith("2030"));
check("graded leg reports Won", pruned.find((p) => p.pickId === "graded")?.result === "Won");
check("started-ungraded leg reports Started", pruned.find((p) => p.pickId === "started")?.result === "Started");
check("deleted leg reports Removed", pruned.find((p) => p.pickId === "gone")?.result === "Removed");

for (const [s, r] of [["LOSS", "Lost"], ["PUSH", "Push"], ["CANCELLED", "Void"]] as const) {
  check(s + " -> " + r, reconcileSlip([leg("x")], { x: st(s, true) }).pruned[0].result === r);
}

const allDead = reconcileSlip([leg("a"), leg("b")], { a: st("PENDING", true), b: st("LOSS", true) });
check("slip with no future leg is fully pruned, with results", allDead.kept.length === 0 && allDead.pruned[0].result === "Started" && allDead.pruned[1].result === "Lost");

if (failed > 0) process.exit(1);
