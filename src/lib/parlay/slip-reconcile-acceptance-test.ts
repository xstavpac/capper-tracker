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
const st = (
  status: SlipPickState["status"],
  over: boolean | null,
  odds = -120,
  kickoff: string | null = "2030-01-01T00:00:00.000Z",
  gameStatus: SlipPickState["gameStatus"] = null
): SlipPickState => ({
  status, odds, over, kickoff, gameStatus,
});

const legs = [leg("graded"), leg("over"), leg("future"), leg("gone")];
const states = { graded: st("WIN", true), over: st("PENDING", true), future: st("PENDING", false, +150) };
const { kept, pruned } = reconcileSlip(legs, states);
check("only the future leg remains", kept.length === 1 && kept[0].pickId === "future");
check("kept leg takes current odds and the looked-up kickoff, not the snapshot", kept[0].odds === 150 && kept[0].gameTime.startsWith("2030"));
check("graded leg reports Won", pruned.find((p) => p.pickId === "graded")?.result === "Won");
check("game-over ungraded leg reports Over", pruned.find((p) => p.pickId === "over")?.result === "Over");
check("deleted leg reports Removed", pruned.find((p) => p.pickId === "gone")?.result === "Removed");

for (const [s, r] of [["LOSS", "Lost"], ["PUSH", "Push"], ["CANCELLED", "Void"]] as const) {
  check(s + " -> " + r, reconcileSlip([leg("x")], { x: st(s, true) }).pruned[0].result === r);
}

const allDead = reconcileSlip([leg("a"), leg("b")], { a: st("PENDING", true), b: st("LOSS", true) });
check("slip with no future leg is fully pruned, with results", allDead.kept.length === 0 && allDead.pruned[0].result === "Over" && allDead.pruned[1].result === "Lost");

// The server could not find the game (kickoff and over both null): the leg
// keeps the kickoff it was added with, and that kickoff decides "over" (a game
// under way is live, not over, until the live window runs out).
const NOW = Date.parse("2026-10-12T16:00:00.000Z");
const withKickoff = (id: string, gameTime: string) => ({ ...leg(id), gameTime });
const unknown = reconcileSlip(
  [withKickoff("later", "2026-10-12T23:05:00.000Z"), withKickoff("earlier", "2026-10-12T09:00:00.000Z")],
  { later: st("PENDING", null, -120, null), earlier: st("PENDING", null, -120, null) },
  NOW
);
check("game not found: a leg whose own kickoff is ahead is kept", unknown.kept.length === 1 && unknown.kept[0].pickId === "later");
check("game not found: its gameTime is left as it was", unknown.kept[0]?.gameTime === "2026-10-12T23:05:00.000Z");
check("game not found: a leg whose own kickoff is long past is Over", unknown.pruned.length === 1 && unknown.pruned[0].pickId === "earlier" && unknown.pruned[0].result === "Over");
// LIVE: a game under way stays on the slip; final / postponed / cancelled does not.
const liveLeg = reconcileSlip([withKickoff("l", "2026-10-12T15:00:00.000Z")], { l: st("PENDING", null, -120, null) }, NOW);
check("game not found: a leg that kicked off an hour ago is live, kept", liveLeg.kept.length === 1 && liveLeg.pruned.length === 0);
const liveStatus = reconcileSlip([leg("l")], { l: st("PENDING", false, -125, "2026-10-12T15:00:00.000Z", "live") }, NOW);
check("server says live: kept, with the feed status and posted price", liveStatus.kept.length === 1 && liveStatus.kept[0].gameStatus === "live" && liveStatus.kept[0].odds === -125);
for (const s of ["final", "postponed", "cancelled"] as const) {
  const r = reconcileSlip([leg("o")], { o: st("PENDING", true, -120, "2026-10-12T15:00:00.000Z", s) }, NOW);
  check(s + ": pruned as Over", r.kept.length === 0 && r.pruned[0].result === "Over");
}
const staleOver = reconcileSlip([{ ...leg("s"), gameStatus: "final" as const, gameTime: "2026-10-12T15:00:00.000Z" }], { s: st("PENDING", null, -120, null) }, NOW);
check("game not found: a leg last seen final is Over", staleOver.kept.length === 0 && staleOver.pruned[0].result === "Over");
// The server's answer wins over the leg's own kickoff whenever it has one.
const serverSays = reconcileSlip([withKickoff("x", "2026-10-12T15:00:00.000Z")], { x: st("PENDING", false, -120, "2026-10-12T23:05:00.000Z") }, NOW);
check("server says not over: kept even though the stored kickoff has passed", serverSays.kept.length === 1 && serverSays.kept[0].gameTime === "2026-10-12T23:05:00.000Z");

if (failed > 0) process.exit(1);
