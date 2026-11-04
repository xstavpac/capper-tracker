// Consensus Hybrid's one-strong-capper rule on a slate shaped like 2026-10-27's:
// 15 games with picks, the cappers' real records as the Live board showed them that
// night (all-time and in-league, by bet category; hybrid-scoring-frozen-cases.ts SLATE_10_27).
// Under the old two-cappers-agree rule only Brewers @ Rays formed a box.
//   - WILSON (the rollback): five games form a box, each leg driven by one capper.
//   - SCORING (the default, PR 8): four. Devils @ Stars loses its total: Porter PICKS' Under is
//     4-2 in the NHL but 12-19 across leagues, so it fails the scored gate (and the long-shot
//     rule: 39% raw vs the -110 break-even), and the 5-4 Over shrinks to 53%.
// The others are skipped for the reason "Why only N games?" gives. Pure - no DB, no fetch.
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts            check
//   npx tsx src/lib/parlay/hybrid-tonight-slate-acceptance-test.ts --digest   print the selection digest (SCORING)
import { buildConsensusPositions, type HybridScorer } from "@/lib/parlay/consensus";
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

function run(scorer: HybridScorer) {
  const positions = buildConsensusPositions(snapshot, { now: NOW, minWinPct: 55, scorer });
  const boxes = boxEligibleGames(positions);
  const { result, report } = optimizeHybridReport({ positions, ladders, swings: {}, settings: { maxLegs: 15, boxLegs: "auto" } });
  const d = explainSkips({ games, pickCounts: Object.fromEntries(games.map((g) => [g.gameId, g.picks.length])), snapshotSkipped: [], records: snapshot, minWinPct: 55, filtered: false, positions, candidateEvents: boxes.map((b) => b.eventId), notes: [], report, result, scorer });
  const legOf = (label: string) => {
    const b = boxes.find((x) => labelOf(x.eventId) === label)!;
    return { side: [b.side.supporters[0].capperName, b.side.direction], total: [b.total.supporters[0].capperName, b.total.direction] };
  };
  const onGame = (id: string) => positions.filter((p) => p.eventId === id).map((p) => p.family + ":" + p.direction).sort();
  const why = Object.fromEntries(d.skipped.map((r) => [labelOf(r.eventId), r.text]));
  return { positions, boxes, result, report, d, legOf, onGame, why };
}

if (process.argv.includes("--digest")) {
  const { boxes, result, d } = run("SCORING");
  console.log(JSON.stringify({ leftOut: d.skipped.map((r) => [labelOf(r.eventId), r.text]), boxGames: boxes.map((b) => [labelOf(b.eventId), driver(b.side), driver(b.total)]), parlay: result.primary ? { structure: result.primary.structure, games: Array.from(new Set(result.primary.legs.map((l) => labelOf(l.eventId)))), legs: result.primary.legs.length, delivery: result.delivery } : null }, null, 2));
  process.exit(0);
}

const FIVE = ["Brewers @ Rays", "Devils @ Stars", "Kings @ Blackhawks", "Senators @ Golden Knights", "Trail Blazers @ Lakers"];

// ============================================================================
// WILSON (the rollback): the rule as it shipped in #365 / #367
// ============================================================================
{
  const w = run("WILSON");
  check("WILSON: five games form a box (the old rule found one)", w.boxes.map((b) => labelOf(b.eventId)).sort(), FIVE);
  check("WILSON: Brewers @ Rays: Sharp Sheet on the Rays ML (13-6 in MLB) beats BEEZOWINS on the Brewers; BEEZOWINS' Over (11-3) drives the total", w.legOf("Brewers @ Rays"), { side: ["Sharp Sheet", EVENTS.MLB.home_team], total: ["BEEZOWINS", "OVER"] });
  check("WILSON: Kings @ Blackhawks: SHARP 5-0 on the home ML; BEEZOWINS alone on the Over", w.legOf("Kings @ Blackhawks"), { side: ["SHARP", EVENTS.NHL.home_team], total: ["BEEZOWINS", "OVER"] });
  check("WILSON: Trail Blazers @ Lakers: Porter PICKS 47-23 on the road spread; BET LABS 7-3 alone on the Under", w.legOf("Trail Blazers @ Lakers"), { side: ["Porter PICKS", EVENTS.NBA.away_team], total: ["BET LABS", "UNDER"] });
  check("WILSON: Devils @ Stars: YDC 7-1 on the road ML; the Under (Porter 4-2 in NHL) beats a 5-4 Over", w.legOf("Devils @ Stars"), { side: ["YDC", EVENTS.NHL.away_team], total: ["Porter PICKS", "UNDER"] });
  check("WILSON: Senators @ Golden Knights: Duck alone on the home ML, Pardon My Pick alone on the Over", w.legOf("Senators @ Golden Knights"), { side: ["Duck", EVENTS.NHL.home_team], total: ["Pardon My Pick", "OVER"] });
  check("WILSON: cap 15: a multi-box parlay of the five games, 10 of 15 legs", [w.result.primary?.structure, Array.from(new Set(w.result.primary?.legs.map((l) => labelOf(l.eventId)))).sort(), w.result.delivery.deliveredLegs, w.result.delivery.boxes], ["multi-box", FIVE, 10, 5]);
  check("WILSON: ten games left out", w.d.skipped.length, 10);
}

// ============================================================================
// SCORING (the default): scoring.ts's best of two at the posted price
// ============================================================================
const s = run("SCORING");
check("four games form a box: Devils @ Stars loses its total", s.boxes.map((b) => labelOf(b.eventId)).sort(), FIVE.filter((g) => g !== "Devils @ Stars"));
check("Brewers @ Rays: Sharp Sheet on the Rays ML still beats BEEZOWINS on the Brewers; BEEZOWINS' Over drives the total", s.legOf("Brewers @ Rays"), { side: ["Sharp Sheet", EVENTS.MLB.home_team], total: ["BEEZOWINS", "OVER"] });
check("Kings @ Blackhawks: KIMSPICKS 7-1 (19-9 all) now outranks SHARP 5-0 (15-8 all) - shrunk, a 5-0 is no longer the stronger record", s.legOf("Kings @ Blackhawks"), { side: ["KIMSPICKS", EVENTS.NHL.home_team], total: ["BEEZOWINS", "OVER"] });
check("Trail Blazers @ Lakers: Porter PICKS 47-23 on the road spread; BET LABS 7-3 alone on the Under", s.legOf("Trail Blazers @ Lakers"), { side: ["Porter PICKS", EVENTS.NBA.away_team], total: ["BET LABS", "UNDER"] });
check("Senators @ Golden Knights: Duck 26-20 (55.2% shrunk) alone on the home ML, Pardon My Pick alone on the Over", s.legOf("Senators @ Golden Knights"), { side: ["Duck", EVENTS.NHL.home_team], total: ["Pardon My Pick", "OVER"] });
check("Devils @ Stars: the side stays (YDC 7-1), no total qualifies", s.onGame("NHL2"), ["SIDE:" + EVENTS.NHL.away_team]);
check("Brewers @ Rays: no Brewers position and no Under position", s.onGame("MLB1"), ["SIDE:" + EVENTS.MLB.home_team, "TOTAL:OVER"]);
const rays = s.positions.find((p) => p.eventId === "MLB1" && p.family === "SIDE")!;
check("the losing direction's gated cappers ride along as opposers (Proven winner 9-7 shrinks below 55), without moving the score", [rays.opposers.map((c) => c.capperName), rays.score === rays.supporters[0].score], [["BEEZOWINS"], true]);
check("agreeing cappers are kept (confidence), the strongest first", rays.supporters.map((c) => c.capperName).slice(0, 2), ["Sharp Sheet", "R3"]);
check("every supporter's score is an edge from scoring.ts, with the record that won the best of two", rays.supporters.every((c) => c.scoring !== undefined && c.score > 0 && c.score < 0.5), true);
check("cap 15: a multi-box parlay of the four games, 8 of 15 legs, short of games", [s.result.primary?.structure, s.result.delivery.requestedLegs, s.result.delivery.deliveredLegs, s.result.delivery.boxes, s.result.delivery.qualifyingGames, s.result.delivery.shortOfGames], ["multi-box", 15, 8, 4, 4, true]);
check("cap 15: no box was lost to a missing line", s.report.noLine, []);

check("eleven games left out", s.d.skipped.length, 11);
check("why: Devils @ Stars - its best total capper's raw record clears 55% but the scored record does not", s.why["Devils @ Stars"], "Best Under capper 67% (4-2) doesn't clear 55% once sample size, other leagues and price count");
check("why: the side's best capper is below 55%", [s.why["Bruins @ Hurricanes"], s.why["Sabres @ Sharks"]], [`Best ${EVENTS.NHL.away_team} capper 47% (47-52), needs 55%`, `Best ${EVENTS.NHL.away_team} capper 52% (22-20), needs 55%`]);
check("why: the total's best capper is below 55%", [s.why["Pistons @ Knicks"], s.why["Kings @ Spurs"], s.why["Wild @ Mammoth"]], ["Best Over capper 50% (27-27), needs 55%", "Best Over capper 42% (8-11), needs 55%", "Best Over capper 50% (8-8), needs 55%"]);
check("why: no total picks", [s.why["Panthers @ Jets"], s.why["Canadiens @ Blues"], s.why["Sam Houston State @ Missouri State"]], ["No full-game total picks", "No full-game total picks", "No full-game total picks"]);
check("why: no side picks", [s.why["Islanders @ Predators"], s.why["Canucks @ Ducks"]], ["No full-game side picks (spread or moneyline)", "No full-game side picks (spread or moneyline)"]);
check("no game is held back for too few cappers agreeing", s.d.skipped.some((r) => r.reason === "not-enough-supporters" || r.text.includes("needs 2")), false);

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll tonight-slate checks passed.");
process.exit(failures > 0 ? 1 : 0);
