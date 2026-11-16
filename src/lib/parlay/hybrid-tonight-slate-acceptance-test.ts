// Consensus Hybrid's one-strong-capper rule on a slate shaped like 2026-10-27's:
// 15 games with picks, the cappers' real records as the Live board showed them that
// night (all-time and in-league, by bet category; hybrid-scoring-frozen-cases.ts SLATE_10_27).
// Under the old two-cappers-agree rule only Brewers @ Rays formed a box.
//   - Four games form a box (hyb-maingate-v3). The gate is Standard's (scorePick: the in-league record
//     shrunk toward the other leagues, the edge at the posted price, the long-shot rule). Devils @ Stars,
//     a box under v2's raw either-record gate, loses its total: Porter PICKS' 4-2 NHL Under (12-19 overall)
//     and O2's 5-4 Over both fall short of 55 once sample size counts.
// The others are skipped for the reason "Why only N games?" gives. Pure - no DB, no fetch.
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts            check
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts --digest   print the selection digest (SCORING)
import { buildConsensusPositions } from "@/lib/parlay/consensus";
import { boxEligibleGames, optimizeHybridReport, type HybridLadders } from "@/lib/parlay/hybrid";
import { explainSkips } from "@/lib/parlay/hybrid-diagnostics";
import { EVENTS, laddersOf, SLATE_10_27 as SLATE, SLATE_NOW as NOW, snapshotOfGames } from "@/lib/parlay/hybrid-scoring-frozen-cases";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const snapshot = snapshotOfGames(SLATE);
const { games } = snapshot;
const ladders: HybridLadders = Object.fromEntries(SLATE.map((g) => [g.id, laddersOf(EVENTS[g.league])]));
const labelOf = (id: string) => SLATE.find((g) => g.id === id)!.label;
const driver = (p: { supporters: { capperName: string }[]; direction: string }) => `${p.supporters[0].capperName}: ${p.direction}`;

function run() {
  const positions = buildConsensusPositions(snapshot, { now: NOW, minWinPct: 55 });
  const boxes = boxEligibleGames(positions);
  const { result, report } = optimizeHybridReport({ positions, ladders, swings: {}, settings: { maxLegs: 15, boxLegs: "auto" } });
  const d = explainSkips({ games, pickCounts: Object.fromEntries(games.map((g) => [g.gameId, g.picks.length])), snapshotSkipped: [], records: snapshot, minWinPct: 55, filtered: false, positions, candidateEvents: boxes.map((b) => b.eventId), notes: [], report, result });
  const legOf = (label: string) => {
    const b = boxes.find((x) => labelOf(x.eventId) === label)!;
    return { side: [b.side.supporters[0].capperName, b.side.direction], total: [b.total.supporters[0].capperName, b.total.direction] };
  };
  const onGame = (id: string) => positions.filter((p) => p.eventId === id).map((p) => p.family + ":" + p.direction).sort();
  const why = Object.fromEntries(d.skipped.map((r) => [labelOf(r.eventId), r.text]));
  return { positions, boxes, result, report, d, legOf, onGame, why };
}

if (process.argv.includes("--digest")) {
  const { boxes, result, d } = run();
  console.log(JSON.stringify({ leftOut: d.skipped.map((r) => [labelOf(r.eventId), r.text]), boxGames: boxes.map((b) => [labelOf(b.eventId), driver(b.side), driver(b.total)]), parlay: result.primary ? { structure: result.primary.structure, games: Array.from(new Set(result.primary.legs.map((l) => labelOf(l.eventId)))), legs: result.primary.legs.length, delivery: result.delivery } : null }, null, 2));
  process.exit(0);
}

const FOUR = ["Brewers @ Rays", "Kings @ Blackhawks", "Senators @ Golden Knights", "Trail Blazers @ Lakers"];

// ============================================================================
// SCORING (the default): Standard's gate (scorePick), and its rankScore at the posted price orders
// ============================================================================
const s = run();
check("four games form a box; Devils @ Stars no longer does (no total clears the shrunk gate)", s.boxes.map((b) => labelOf(b.eventId)).sort(), FOUR);
check("Brewers @ Rays: Sharp Sheet on the Rays ML still beats BEEZOWINS on the Brewers; BEEZOWINS' Over drives the total", s.legOf("Brewers @ Rays"), { side: ["Sharp Sheet", EVENTS.MLB.home_team], total: ["BEEZOWINS", "OVER"] });
check("Kings @ Blackhawks: KIMSPICKS 7-1 (19-9 all) now outranks SHARP 5-0 (15-8 all) - ordered by the shrunk score, so a 5-0 is no longer the stronger record; both still pass the gate", s.legOf("Kings @ Blackhawks"), { side: ["KIMSPICKS", EVENTS.NHL.home_team], total: ["BEEZOWINS", "OVER"] });
check("Trail Blazers @ Lakers: Porter PICKS 47-23 on the road spread; BET LABS 7-3 alone on the Under", s.legOf("Trail Blazers @ Lakers"), { side: ["Porter PICKS", EVENTS.NBA.away_team], total: ["BET LABS", "UNDER"] });
check("Senators @ Golden Knights: Duck 26-20 alone on the home ML, Pardon My Pick alone on the Over", s.legOf("Senators @ Golden Knights"), { side: ["Duck", EVENTS.NHL.home_team], total: ["Pardon My Pick", "OVER"] });
check("Devils @ Stars: only YDC's 7-1 road ML stands; no total position", s.onGame("NHL2"), ["SIDE:" + EVENTS.NHL.away_team]);
check("Brewers @ Rays: no Brewers position and no Under position", s.onGame("MLB1"), ["SIDE:" + EVENTS.MLB.home_team, "TOTAL:OVER"]);
const rays = s.positions.find((p) => p.eventId === "MLB1" && p.family === "SIDE")!;
check("the losing direction's gated cappers ride along as opposers (BEEZOWINS 28-18 shrinks to 57.5% and clears; Proven winner 9-7 shrinks to 52.5% and does not), without moving the score", [rays.opposers.map((c) => c.capperName), rays.score === rays.supporters[0].score], [["BEEZOWINS"], true]);
check("agreeing cappers are kept (confidence), the strongest first", rays.supporters.map((c) => c.capperName).slice(0, 2), ["Sharp Sheet", "R3"]);
check("every supporter's score is scorePick's edge, with the model that scored it", rays.supporters.every((c) => c.scoring !== undefined && c.score > 0 && c.score < 0.5), true);
check("cap 15: a multi-box parlay of the four games, 8 of 15 legs", [s.result.primary?.structure, s.result.delivery.requestedLegs, s.result.delivery.deliveredLegs, s.result.delivery.boxes, s.result.delivery.qualifyingGames, s.result.delivery.shortOfGames], ["multi-box", 15, 8, 4, 4, true]);
check("cap 15: no box was lost to a missing line", s.report.noLine, []);

check("eleven games left out", s.d.skipped.length, 11);
// The text names what the gate read: the rating once sample size and the posted price count, or the long-shot rule's raw record.
check("why: Devils @ Stars' best total capper rates under 55% once sample size counts", s.why["Devils @ Stars"], "Best Over capper 56% (5-4) rates 53.1% once sample size and price count, needs 55%");
// Bruins @ Hurricanes: the best is now the post the gate scores highest (10-12, rated 48.6%), not the highest raw % (47-52).
check("why: the side's best capper is below 55%", [s.why["Bruins @ Hurricanes"], s.why["Sabres @ Sharks"]], [`Best ${EVENTS.NHL.home_team} capper 45% (10-12) rates 48.6% once sample size and price count, needs 55%`, `Best ${EVENTS.NHL.away_team} capper 52% (22-20) rates 52.3% once sample size and price count, needs 55%`]);
check("why: the total's best capper fails the long-shot rule at its price", [s.why["Pistons @ Knicks"], s.why["Kings @ Spurs"], s.why["Wild @ Mammoth"]], ["Best Over capper 50% (27-27): 27-27 across leagues is under the 52.4% its price needs", "Best Over capper 42% (8-11): 8-11 across leagues is under the 52.4% its price needs", "Best Over capper 50% (8-8): 8-8 across leagues is under the 52.4% its price needs"]);
check("why: no total picks", [s.why["Panthers @ Jets"], s.why["Canadiens @ Blues"], s.why["Sam Houston State @ Missouri State"]], ["No full-game total picks", "No full-game total picks", "No full-game total picks"]);
check("why: no side picks", [s.why["Islanders @ Predators"], s.why["Canucks @ Ducks"]], ["No full-game side picks (spread or moneyline)", "No full-game side picks (spread or moneyline)"]);
check("no game is held back for too few cappers agreeing", s.d.skipped.some((r) => r.reason === "not-enough-supporters" || r.text.includes("needs 2")), false);
check("every below-gate reason says what the gate read (sample size and price, or the long-shot record)", s.d.skipped.filter((r) => r.reason === "below-gate").every((r) => r.text.includes("once sample size and price count") || r.text.includes("its price needs")), true);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll tonight-slate checks passed.");
process.exit(failures > 0 ? 1 : 0);
