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
const st = (status: SlipPickState["status"], started: boolean | null, odds = -120, kickoff: string | null = "2030-01-01T00:00:00.000Z"): SlipPickState => ({
  status, odds, started, kickoff,
});

const legs = [leg("graded"), leg("started"), leg("future"), leg("gone")];
const states = { graded: st("WIN", true), started: st("PENDING", true), future: st("PENDING", false, +150) };
const { kept, pruned } = reconcileSlip(legs, states);
check("only the future leg remains", kept.length === 1 && kept[0].pickId === "future");
check("kept leg takes current odds and the looked-up kickoff, not the snapshot", kept[0].odds === 150 && kept[0].gameTime.startsWith("2030"));
check("graded leg reports Won", pruned.find((p) => p.pickId === "graded")?.result === "Won");
check("started-ungraded leg reports Started", pruned.find((p) => p.pickId === "started")?.result === "Started");
check("deleted leg reports Removed", pruned.find((p) => p.pickId === "gone")?.result === "Removed");

for (const [s, r] of [["LOSS", "Lost"], ["PUSH", "Push"], ["CANCELLED", "Void"]] as const) {
  check(s + " -> " + r, reconcileSlip([leg("x")], { x: st(s, true) }).pruned[0].result === r);
}

const allDead = reconcileSlip([leg("a"), leg("b")], { a: st("PENDING", true), b: st("LOSS", true) });
check("slip with no future leg is fully pruned, with results", allDead.kept.length === 0 && allDead.pruned[0].result === "Started" && allDead.pruned[1].result === "Lost");

// The server could not find the game (kickoff and started both null): the leg
// keeps the kickoff it was added with, and that kickoff decides "started".
const NOW = Date.parse("2026-10-12T16:00:00.000Z");
const withKickoff = (id: string, gameTime: string) => ({ ...leg(id), gameTime });
const unknown = reconcileSlip(
  [withKickoff("later", "2026-10-12T23:05:00.000Z"), withKickoff("earlier", "2026-10-12T15:00:00.000Z")],
  { later: st("PENDING", null, -120, null), earlier: st("PENDING", null, -120, null) },
  NOW
);
check("game not found: a leg whose own kickoff is ahead is kept", unknown.kept.length === 1 && unknown.kept[0].pickId === "later");
check("game not found: its gameTime is left as it was", unknown.kept[0]?.gameTime === "2026-10-12T23:05:00.000Z");
check("game not found: a leg whose own kickoff has passed is Started", unknown.pruned.length === 1 && unknown.pruned[0].pickId === "earlier" && unknown.pruned[0].result === "Started");
// The server's answer wins over the leg's own kickoff whenever it has one.
const serverSays = reconcileSlip([withKickoff("x", "2026-10-12T15:00:00.000Z")], { x: st("PENDING", false, -120, "2026-10-12T23:05:00.000Z") }, NOW);
check("server says not started: kept even though the stored kickoff has passed", serverSays.kept.length === 1 && serverSays.kept[0].gameTime === "2026-10-12T23:05:00.000Z");

if (failed > 0) process.exit(1);
