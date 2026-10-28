// Consensus Hybrid's position builder (consensus.ts): one strong capper is enough;
// the direction is the one whose single strongest capper is strongest (Wilson score,
// then sample size, then capper id), the other yields no position; agreeing cappers
// only break ranking ties; opposers never move the score; distinct-capper supporters,
// ML + spread merged into one team side, the easiest endorsed line as the anchor,
// gated opposers only, hedged cappers on neither side, the markets left out,
// and the record hierarchy / win-% lever / soft sample-size adjustment it reuses
// from the generator. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/consensus-acceptance-test.ts
import { buildConsensusPositions, HYBRID_MIN_SUPPORTERS, type ConsensusPosition } from "@/lib/parlay/consensus";
import { GENERATOR_Z, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-09-01T12:00:00.000Z");
const START = "2099-09-01T23:00:00.000Z";
const HOME = "Chicago Bears";
const AWAY = "Green Bay Packers";
const LEAGUE = "NFL";
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });

type Bet =
  | { kind: "ML"; team: "HOME" | "AWAY" }
  | { kind: "SPREAD"; team: "HOME" | "AWAY"; line: number }
  | { kind: "TOTAL"; side: "Over" | "Under"; line: number }
  | { kind: "TEAM_TOTAL"; side: "Over" | "Under"; line: number }
  | { kind: "PROP" }
  | { kind: "NRFI" }
  | { kind: "H1_SPREAD"; team: "HOME" | "AWAY"; line: number }
  | { kind: "REG_ML"; team: "HOME" | "AWAY" };

// lg: the capper's record in this bet in the game's league; all: every league.
type Spec = { id: string; capper: string; bet: Bet; lg?: [number, number]; all?: [number, number]; gameNumber?: number | null };

const nick = (team: "HOME" | "AWAY") => (team === "HOME" ? "Bears" : "Packers");
const teamName = (team: "HOME" | "AWAY") => (team === "HOME" ? HOME : AWAY);
const fmt = (n: number) => (n > 0 ? "+" + n : String(n));

function describe(b: Bet): { betType: string; period: string; detail: string; line: number | null; category: PickCategoryKey } {
  switch (b.kind) {
    case "ML":
      return { betType: "MONEYLINE", period: "FULL_GAME", detail: nick(b.team) + " ML", line: null, category: b.team === "HOME" ? "FAV_ML" : "DOG_ML" };
    case "SPREAD":
      return { betType: "SPREAD", period: "FULL_GAME", detail: nick(b.team) + " " + fmt(b.line), line: b.line, category: b.line < 0 ? "SPREAD_MINUS" : "SPREAD_PLUS" };
    case "TOTAL":
      return { betType: "TOTAL", period: "FULL_GAME", detail: b.side + " " + b.line, line: b.line, category: b.side === "Over" ? "OVER" : "UNDER" };
    case "TEAM_TOTAL":
      return { betType: "TEAM_TOTAL", period: "FULL_GAME", detail: nick("HOME") + " " + b.side + " " + b.line, line: b.line, category: b.side === "Over" ? "OVER" : "UNDER" };
    case "PROP":
      return { betType: "PLAYER_PROP", period: "FULL_GAME", detail: "Caleb Williams over 215.5 passing yards", line: 215.5, category: "OVER" };
    case "NRFI":
      return { betType: "NRFI", period: "FULL_GAME", detail: "NRFI", line: null, category: "OVER" };
    case "H1_SPREAD":
      return { betType: "SPREAD", period: "FIRST_HALF", detail: "1H " + nick(b.team) + " " + fmt(b.line), line: b.line, category: "FIRST_HALF_SPREAD" };
    case "REG_ML":
      return { betType: "MONEYLINE", period: "REGULATION", detail: nick(b.team) + " ML (regulation)", line: null, category: "FIRST_HALF_ML" };
  }
}

function makePick(s: Spec, overrides: Partial<GeneratorPick> = {}): GeneratorPick {
  const d = describe(s.bet);
  return {
    pickId: s.id,
    capperId: s.capper,
    capperName: "Capper " + s.capper,
    capperColorTag: null,
    capperIsFavorite: false,
    category: d.category,
    leagueName: LEAGUE,
    gameId: "G1",
    gameLabel: AWAY + " @ " + HOME,
    betDetail: d.detail,
    odds: -110,
    units: 1,
    status: "PENDING",
    betType: d.betType,
    period: d.period,
    rawBetDetail: d.detail,
    propMarket: null,
    line: d.line,
    homeTeam: HOME,
    awayTeam: AWAY,
    gameTime: START,
    teamGroup: "HOME",
    teamLabel: "",
    teamColor: null,
    datePosted: "2099-08-31T00:00:00.000Z",
    gameNumber: s.gameNumber ?? null,
    ...overrides,
  } as GeneratorPick;
}

function snapshotOf(specs: Spec[], game: Partial<GeneratorGame> = {}): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const picks = specs.map((s) => {
    const pick = makePick(s);
    const all = col(...(s.all ?? s.lg ?? [8, 2]));
    categoryRecords[s.capper + "|" + pick.category] = { key: pick.category!, label: pick.category!, ...all };
    if (s.lg) leagueRecords.records[s.capper + "|" + LEAGUE + "|" + pick.category] = { category: pick.category!, label: pick.category!, overall: all, league: col(...s.lg) };
    return pick;
  });
  const g: GeneratorGame = { gameId: "G1", gameLabel: AWAY + " @ " + HOME, gameTime: START, leagueName: LEAGUE, picks, ...game };
  return { builtAt: NOW.toISOString(), games: [g], slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const build = (specs: Spec[], opts: { minWinPct?: number; minSupporters?: number } = {}, game: Partial<GeneratorGame> = {}): ConsensusPosition[] =>
  buildConsensusPositions(snapshotOf(specs, game), { now: NOW, ...opts });
const find = (ps: ConsensusPosition[], direction: string) => ps.find((p) => p.direction === direction);
const lb = (w: number, l: number) => wilsonLowerBound(w, l, GENERATOR_Z);
const GOOD: [number, number] = [8, 2];

check("the supporter threshold is a named constant at 1: one strong capper is enough", HYBRID_MIN_SUPPORTERS, 1);

// ============================================================================
// Distinct cappers; a capper's posts resolve to their hardest line
// ============================================================================
{
  const ps = build([
    { id: "a1", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
    { id: "a2", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -6.5 }, lg: GOOD },
    { id: "a3", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -6.5 }, lg: GOOD },
    { id: "b1", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -1 }, lg: GOOD },
  ]);
  const p = find(ps, HOME)!;
  check("three posts by one capper are one supporter", p.supporters.map((s) => [s.capperId, s.posts]), [["A", 3], ["B", 1]].sort());
  check("the capper's endorsed line is their hardest post (-6.5, not -3)", p.supporters.find((s) => s.capperId === "A")!.endorsedLine, -6.5);
  check("the anchor is the easiest endorsed line (-1, not -6.5)", p.anchorLine, -1);
  check("posted-line spread is recorded", [p.postedLines, p.lineSpread], [{ hardest: -6.5, easiest: -1 }, 5.5]);
  check("the score is the strongest supporter's, counted once", p.score, lb(8, 2));
  const alone = build([{ id: "a1", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD }, { id: "a2", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -6.5 }, lg: GOOD }]);
  check("one capper alone is a position (their hardest post is the anchor)", alone.map((x) => [x.direction, x.supporters.length, x.anchorLine]), [[HOME, 1, -6.5]]);
}

// ============================================================================
// ML + spread merge into one team side; the ML-backed side anchors at pick'em
// ============================================================================
{
  const ps = build([
    { id: "a", capper: "A", bet: { kind: "ML", team: "HOME" }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
  ]);
  check("ML and spread supporters of one team are ONE position", ps.map((p) => [p.family, p.direction]), [["SIDE", HOME]]);
  const p = ps[0];
  check("an ML-backed side anchors at pick'em", [p.anchorLine, p.anchorIsMoneyline], [0, true]);
  check("the ladder-start flag is the ML, the spread supporter's line stays as posted", p.supporters.map((s) => [s.capperId, s.postedMarket, s.postedLine, s.endorsedLine]), [["A", "MONEYLINE", null, 0], ["B", "SPREAD", -3, -3]].sort());
  check("posted lines run -3 (hardest) to pick'em", p.postedLines, { hardest: -3, easiest: 0 });
}
{
  // A capper on the ML and +3 is hardest at the ML (0), not at +3.
  const ps = build([
    { id: "a1", capper: "A", bet: { kind: "ML", team: "AWAY" }, lg: GOOD },
    { id: "a2", capper: "A", bet: { kind: "SPREAD", team: "AWAY", line: 3 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "AWAY", line: 3 }, lg: GOOD },
  ]);
  const p = find(ps, AWAY)!;
  check("ML + a +3 post: the capper's hardest is the ML", p.supporters.find((s) => s.capperId === "A")!.postedMarket, "MONEYLINE");
  check("anchor is +3 (easiest of the cappers' hardest lines), not the ML", [p.anchorLine, p.anchorIsMoneyline], [3, false]);
}
{
  // Other team's ML is the opposite side, a different position.
  const ps = build([
    { id: "a", capper: "A", bet: { kind: "ML", team: "HOME" }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
    { id: "c", capper: "C", bet: { kind: "ML", team: "AWAY" }, lg: GOOD },
    { id: "d", capper: "D", bet: { kind: "SPREAD", team: "AWAY", line: 3 }, lg: GOOD },
  ]);
  check("both teams backed at equal records: ONE side position (the tie goes to capper id A)", ps.map((p) => p.direction), [HOME]);
  check("the other team's backers are the opposers", find(ps, HOME)!.opposers.map((o) => o.capperId).sort(), ["C", "D"]);
}

// ============================================================================
// The anchor is the EASIEST endorsed line
// ============================================================================
{
  const side = find(build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "AWAY", line: -3 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "AWAY", line: 2.5 }, lg: GOOD },
    { id: "c", capper: "C", bet: { kind: "SPREAD", team: "AWAY", line: 7 }, lg: GOOD },
  ]), AWAY)!;
  check("team side: -3, +2.5, +7 anchors at +7", side.anchorLine, 7);
  const over = find(build([
    { id: "a", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 44.5 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 42.5 }, lg: GOOD },
    { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Over", line: 47 }, lg: GOOD },
  ]), "OVER")!;
  check("Over 42.5 / 44.5 / 47 anchors at 42.5 (lowest line is easiest)", [over.anchorLine, over.postedLines], [42.5, { hardest: 47, easiest: 42.5 }]);
  const under = find(build([
    { id: "a", capper: "A", bet: { kind: "TOTAL", side: "Under", line: 44.5 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Under", line: 42.5 }, lg: GOOD },
    { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 40 }, lg: GOOD },
  ]), "UNDER")!;
  check("Under 40 / 42.5 / 44.5 anchors at 44.5 (highest line is easiest)", [under.anchorLine, under.postedLines], [44.5, { hardest: 40, easiest: 44.5 }]);
  const overMulti = find(build([
    { id: "a1", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 41.5 }, lg: GOOD },
    { id: "a2", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 45 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 43 }, lg: GOOD },
  ]), "OVER")!;
  check("an Over capper's hardest post is the highest line (45), the anchor is 43", [overMulti.supporters.find((s) => s.capperId === "A")!.endorsedLine, overMulti.anchorLine], [45, 43]);
  check("a total is no team side", [over.family, over.anchorIsMoneyline], ["TOTAL", false]);
}

// ============================================================================
// Opposers: shown, never subtracted; ungated ones are ignored
// ============================================================================
{
  const base: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [6, 4] },
  ];
  const noOpp = find(build(base), "OVER")!;
  check("score is the strongest supporter's (8-2), not a sum", noOpp.score, lb(8, 2));
  const gated = find(build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }]), "OVER")!;
  check("a gated opposer is listed but never subtracted", [gated.opposers.map((o) => o.capperId), gated.score], [["C"], lb(8, 2)]);
  const ungated = find(build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [3, 7] }]), "OVER")!;
  check("an ungated opposer (30%) is ignored", [ungated.opposers.length, ungated.score], [0, noOpp.score]);
  const opposerOnly = build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }]);
  check("one opposer alone does not make a position of the other side", opposerOnly.map((p) => p.direction), ["OVER"]);
  // Opposers count by capper: two posts, one opposer.
  const twoPosts = find(build([...base, { id: "c1", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }, { id: "c2", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 46 }, lg: [7, 3] }]), "OVER")!;
  check("an opposer with two posts is listed once, the score untouched", [twoPosts.opposers.map((o) => o.capperId), twoPosts.score], [["C"], lb(8, 2)]);
  // A capper who backed both directions has hedged: on neither side.
  const hedged = build([...base, { id: "h1", capper: "H", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: GOOD }, { id: "h2", capper: "H", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: GOOD }]);
  check("a capper on both directions is neither supporter nor opposer", [find(hedged, "OVER")!.supporters.map((s) => s.capperId).sort(), find(hedged, "OVER")!.opposers.length], [["A", "B"], 0]);
}

// ============================================================================
// The threshold (one is enough), and the markets left out
// ============================================================================
{
  const two: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
  ];
  check("two supporters qualify", build(two).length, 1);
  check("one supporter qualifies", build(two.slice(0, 1)).length, 1);
  check("minSupporters is still adjustable", [build(two.slice(0, 1), { minSupporters: 2 }).length, build(two, { minSupporters: 3 }).length], [0, 0]);

  const other = (id: string, capper: string, bet: Bet): Spec => ({ id, capper, bet, lg: GOOD });
  for (const [name, bet] of [
    ["player props", { kind: "PROP" }],
    ["team totals", { kind: "TEAM_TOTAL", side: "Over", line: 24.5 }],
    ["NRFI", { kind: "NRFI" }],
    ["period spreads (1H)", { kind: "H1_SPREAD", team: "HOME", line: -1.5 }],
    ["regulation (3-way) moneylines", { kind: "REG_ML", team: "HOME" }],
  ] as [string, Bet][]) {
    check(`${name} never make a position`, build([other("x", "A", bet), other("y", "B", bet), other("z", "C", bet)]).length, 0);
    check(`${name} do not count as a supporter beside a real post`, build([...two.slice(0, 1), other("x", "B", bet)]).map((p) => p.supporters.map((s) => s.capperId)), [["A"]]);
  }
}
{
  // Doubleheader: a pick with no game number could be on either game.
  const specs: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -1.5 }, lg: GOOD, gameNumber: 1 },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -1.5 }, lg: GOOD, gameNumber: null },
  ];
  check("doubleheader: a pick with no game number is not used", build(specs, {}, { doubleheader: true }).map((p) => p.supporters.map((s) => s.capperId)), [["A"]]);
  check("not a doubleheader: the same picks make a position", build(specs).length, 1);
  check("doubleheader: both picks with a game number do", build(specs.map((s) => ({ ...s, gameNumber: 1 })), {}, { doubleheader: true }).length, 1);
}
{
  const two: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
  ];
  const snap = snapshotOf(two);
  check("a game that has kicked off has no positions", buildConsensusPositions(snap, { now: new Date("2099-09-01T23:30:00.000Z") }).length, 0);
  check("an off-board slip game has no positions", build(two, {}, { gameId: "pick:abc" }).length, 0);
}

// ============================================================================
// One strong capper per leg: the direction is the strongest single capper's
// ============================================================================
{
  // A side by one capper and a total by a different capper: both positions (a box).
  const ps = build([
    { id: "s", capper: "S", bet: { kind: "SPREAD", team: "HOME", line: -4 }, lg: [12, 5] },
    { id: "t", capper: "T", bet: { kind: "TOTAL", side: "Under", line: 234.5 }, lg: [9, 4] },
  ]);
  check("one capper on the side + a different capper on the total = a side and a total position", ps.map((p) => [p.family, p.direction, p.supporters.map((s) => s.capperId)]).sort(), [["SIDE", HOME, ["S"]], ["TOTAL", "UNDER", ["T"]]]);

  // Over vs Under: the stronger single record wins, not the bigger crowd.
  const crowd = build([
    { id: "o1", capper: "O1", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [6, 4] },
    { id: "o2", capper: "O2", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [6, 4] },
    { id: "o3", capper: "O3", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [6, 4] },
    { id: "u1", capper: "U1", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [30, 10] },
  ]);
  check("Over vs Under: one 30-10 Under beats three 6-4 Overs; the Over yields no position", crowd.map((p) => [p.direction, p.supporters.map((s) => s.capperId), p.opposers.map((o) => o.capperId)]), [["UNDER", ["U1"], ["O1", "O2", "O3"]]]);
  // Equal score: the larger sample wins. 6-4 and 12-8 are both 60%, and 12-8 scores higher anyway - so use
  // equal records and decide on capper id.
  const tie = build([
    { id: "o", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [8, 2] },
    { id: "u", capper: "A", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [8, 2] },
  ]);
  check("Over vs Under with identical records: capper id decides (A's Under)", tie.map((p) => p.direction), ["UNDER"]);
  const sample = build([
    { id: "o", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [8, 2] },
    { id: "u", capper: "B", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [80, 20] },
  ]);
  check("Over vs Under at the same 80%: the larger sample (80-20) wins", sample.map((p) => p.direction), ["UNDER"]);

  // Opposing sides resolve the same way.
  const sides = build([
    { id: "h1", capper: "H1", bet: { kind: "ML", team: "HOME" }, lg: [11, 9] },
    { id: "h2", capper: "H2", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [11, 9] },
    { id: "a1", capper: "A1", bet: { kind: "SPREAD", team: "AWAY", line: 3 }, lg: [40, 15] },
  ]);
  check("opposing sides: one 40-15 road backer beats two 11-9 home backers", sides.map((p) => [p.direction, p.supporters.map((s) => s.capperId)]), [[AWAY, ["A1"]]]);
  check("...the losing side's cappers are its opposers", sides[0].opposers.map((o) => o.capperId).sort(), ["H1", "H2"]);

  // Agreeing cappers are confidence: they never decide a direction, but they order equal positions.
  const agreeing = build([
    { id: "s1", capper: "S1", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [8, 2] },
    { id: "s2", capper: "S2", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [8, 2] },
    { id: "t1", capper: "T1", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [8, 2] },
  ]);
  check("equal strongest records: the position with more agreeing cappers ranks first", agreeing.map((p) => [p.family, p.supporters.length, p.score === lb(8, 2)]), [["SIDE", 2, true], ["TOTAL", 1, true]]);
  check("agreeing cappers stay on the position, strongest first", agreeing[0].supporters.map((s) => s.capperId), ["S1", "S2"]);

  // The anchor is the easiest line among the WINNING direction's cappers only.
  const anchor = build([
    { id: "u1", capper: "U1", bet: { kind: "TOTAL", side: "Under", line: 44.5 }, lg: [20, 5] },
    { id: "u2", capper: "U2", bet: { kind: "TOTAL", side: "Under", line: 46.5 }, lg: [7, 3] },
    { id: "o1", capper: "O1", bet: { kind: "TOTAL", side: "Over", line: 41.5 }, lg: [7, 3] },
  ]);
  check("anchor: the easiest Under among the Under cappers (46.5); the Over's 41.5 plays no part", [anchor[0].direction, anchor[0].anchorLine, anchor[0].postedLines], ["UNDER", 46.5, { hardest: 44.5, easiest: 46.5 }]);

  // A hedged capper is still on neither side, even when they would be the strongest.
  const hedged = build([
    { id: "h1", capper: "H", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [90, 10] },
    { id: "h2", capper: "H", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [90, 10] },
    { id: "u", capper: "U", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] },
  ]);
  check("a hedged capper is dropped: the next strongest decides", hedged.map((p) => [p.direction, p.supporters.map((s) => s.capperId), p.opposers.length]), [["UNDER", ["U"], 0]]);
}

// ============================================================================
// The record hierarchy, the win-% lever and the soft sample-size adjustment
// ============================================================================
{
  // Best-of-two (pick-record.ts recordForGate): the higher Wilson lower bound at GENERATOR_Z wins.
  const allTimeWins = find(build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [90, 10] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [90, 10] },
  ]), HOME)!;
  check("a stronger all-time record beats the league one", allTimeWins.supporters.map((s) => [s.record.source, s.record.wins, s.record.losses]), [["OVERALL", 90, 10], ["OVERALL", 90, 10]]);
  check("the score is the chosen record's", allTimeWins.score, lb(90, 10));
  const leagueWins = find(build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [8, 0], all: [60, 40] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [1, 2], all: [60, 40] },
  ]), HOME)!;
  check(
    "in-league 8-0 beats all-time 60-40; a tiny in-league 1-2 loses to all-time 60-40",
    leagueWins.supporters.map((s) => [s.capperId, s.record.source, s.record.wins, s.record.losses]),
    [["A", "LEAGUE", 8, 0], ["B", "OVERALL", 60, 40]]
  );
  const tie = find(build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [6, 4] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [6, 4] },
  ]), HOME)!;
  check("a tie goes to the league record", tie.supporters.map((s) => s.record.source), ["LEAGUE", "LEAGUE"]);
  // 50-40 in-league (55.6%) scores above 2-0 all time, so it is the record; at gate 60 it fails, and 2-0 is never tried.
  const gateSpecs: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [50, 40], all: [2, 0] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [7, 3] },
  ];
  check("gated on the chosen record: 50-40 passes 55", find(build(gateSpecs), HOME)?.supporters.map((s) => [s.capperId, s.record.source, s.record.wins]), [["A", "LEAGUE", 50], ["B", "LEAGUE", 7]]);
  check("gated on the chosen record only: 50-40 fails 60, no fallback to 2-0", build(gateSpecs, { minWinPct: 60 }).map((p) => p.supporters.map((s) => s.capperId)), [["B"]]);
  // The record's own market travels with it: A's best record is the moneyline (9-1), though the
  // hardest post (the endorsed line) is the spread, so recordMarket and postedMarket differ.
  const mixed = find(build([
    { id: "a1", capper: "A", bet: { kind: "ML", team: "HOME" }, lg: [9, 1] },
    { id: "a2", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [7, 3] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [7, 3] },
  ]), HOME)!;
  check("recordMarket is the market of the record used, apart from the posted market", mixed.supporters.map((s) => [s.capperId, s.recordMarket, s.postedMarket, s.record.wins]), [["A", "MONEYLINE", "SPREAD", 9], ["B", "SPREAD", "SPREAD", 7]]);
  const totalPos = buildConsensusPositions(snapshotOf([
    { id: "t1", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 44.5 }, lg: [8, 2] },
    { id: "t2", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 44.5 }, lg: [8, 2] },
  ]), { now: NOW }).find((p) => p.family === "TOTAL")!;
  check("a total's record market is TOTAL", totalPos.supporters.map((s) => s.recordMarket), ["TOTAL", "TOTAL"]);
  // No league wins or losses: the all-time category record.
  const specs: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, all: [9, 3] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, all: [9, 3] },
  ];
  const snap = snapshotOf(specs);
  // A league card with only pushes counts as no league record.
  snap.leagueRecords.records["A|" + LEAGUE + "|SPREAD_MINUS"] = { category: "SPREAD_MINUS", label: "x", overall: col(9, 3), league: { wins: 0, losses: 0, pushes: 2, winPct: 0, count: 2 } } as never;
  const overall = buildConsensusPositions(snap, { now: NOW })[0];
  check("no league win or loss falls back to the all-time record", overall.supporters.map((s) => [s.capperId, s.record.source]), [["A", "OVERALL"], ["B", "OVERALL"]]);
}
{
  // A 6-4 (60%) and a 7-3 (70%) pair: the lever moves who qualifies.
  const specs: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [7, 3] },
  ];
  check("default gate 55: both qualify", build(specs).length, 1);
  check("gate 60 keeps a 60% record (>=)", build(specs, { minWinPct: 60 }).length, 1);
  check("gate 65 drops the 60% capper: the 70% one alone carries it", build(specs, { minWinPct: 65 }).map((p) => p.supporters.map((s) => s.capperId)), [["B"]]);
  check("gate 75 drops both: no position", build(specs, { minWinPct: 75 }).length, 0);
  check("gate 70 drops the 60%", build([specs[1], { ...specs[1], id: "c", capper: "C" }], { minWinPct: 70 }).length, 1);
  check("an invalid lever is the 55 default", build(specs, { minWinPct: 63 }).length, 1);
  check("gate 55 with a 52% record: not a supporter", build([specs[1], { id: "c", capper: "C", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [13, 12] }]).map((p) => p.supporters.map((s) => s.capperId)), [["B"]]);
  check("a below-gate capper alone never makes a position", build([{ id: "c", capper: "C", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [13, 12] }]).length, 0);
  check("gate 50 lets the 52% record in", build([specs[1], { id: "c", capper: "C", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [13, 12] }], { minWinPct: 50 }).length, 1);
}
{
  // Soft sample-size adjustment (#324): 18-4 sits near 100-30; 3-0 stays well below 18-4.
  const score = (record: [number, number]) =>
    find(build([
      { id: "a", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 8.5 }, lg: record },
      { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 8.5 }, lg: record },
    ]), "OVER")!.supporters[0].score;
  check("a supporter's score is the Wilson lower bound at the generator's z", score([18, 4]), lb(18, 4));
  check("18-4 is closer to 100-30 than 3-0 is to 18-4", Math.abs(score([100, 30]) - score([18, 4])) < Math.abs(score([18, 4]) - score([3, 0])), true);
  check("z is the generator's 1.5, not the shared 1.96", score([18, 4]) > wilsonLowerBound(18, 4), true);
}

// ============================================================================
// Ranking
// ============================================================================
{
  const ps = build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4] },
    { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 40 }, lg: [30, 5] },
    { id: "d", capper: "D", bet: { kind: "TOTAL", side: "Under", line: 40 }, lg: [30, 5] },
  ]);
  check("positions are ranked by score, best first", ps.map((p) => p.direction), ["UNDER", HOME]);
  check("a position carries its game", [ps[0].eventId, ps[0].homeTeam, ps[0].awayTeam, ps[0].commenceTime, ps[0].sport], ["G1", HOME, AWAY, START, LEAGUE]);
}

// ============================================================================
// A 0% gate: weak cappers get in, but a capper who took both sides never cancels anyone
// (consensus.ts: a capper with gated posts on two directions of a family is on neither side)
// ============================================================================
{
  const WEAK: [number, number] = [0, 5];
  const over = (id: string, capper: string, lg: [number, number]): Spec => ({ id, capper, bet: { kind: "TOTAL", side: "Over", line: 44 }, lg });
  const under = (id: string, capper: string, lg: [number, number]): Spec => ({ id, capper, bet: { kind: "TOTAL", side: "Under", line: 44 }, lg });
  const at0 = (specs: Spec[]) => build(specs, { minWinPct: 0 });
  const shape = (ps: ConsensusPosition[]) => ps.map((p) => [p.direction, p.supporters.map((c) => c.capperId), p.opposers.map((c) => c.capperId)]);

  // A weak capper on both sides is set aside; the one-sided strong capper keeps the position.
  check("0%: a 0-5 capper on both sides does not cancel the Over a strong capper took", shape(at0([over("a", "A", GOOD), over("h1", "H", WEAK), under("h2", "H", WEAK)])), [["OVER", ["A"], []]]);
  // Hedging with a strong record is no different: still on neither side.
  check("0%: a 30-5 capper on both sides is on neither side either, so the weaker one-sided capper decides", shape(at0([over("a", "A", [3, 4]), over("h1", "H", [30, 5]), under("h2", "H", [30, 5])])), [["OVER", ["A"], []]]);
  // Only hedgers: nothing is left, so there is no position.
  check("0%: when every capper on the family hedged, no position", at0([over("h1", "H", WEAK), under("h2", "H", WEAK)]).length, 0);
  // One-sided cappers on both directions: the strongest decides, the hedger is nowhere.
  check("0%: with one-sided cappers on both directions the strongest decides, the hedger is on neither list", shape(at0([over("a", "A", GOOD), under("b", "B", [3, 4]), over("h1", "H", WEAK), under("h2", "H", WEAK)])), [["OVER", ["A"], ["B"]]]);

  // Ordering at 0%: strength, not arrival order. The 0-5 capper sorts last among supporters.
  const order = find(at0([over("w", "W", WEAK), over("m", "M", [5, 5]), over("g", "G", GOOD)]), "OVER")!;
  check("0%: supporters are ordered by strength, the 0-5 capper last", order.supporters.map((c) => c.capperId), ["G", "M", "W"]);
  check("0%: the position scores its strongest supporter, not the weak one", order.score, lb(8, 2));
  const onlyWeak = find(at0([over("w", "W", WEAK)]), "OVER")!;
  check("0%: a 0-5 capper alone is a position (any graded record), scoring about 0", [onlyWeak.supporters.map((c) => c.capperId), onlyWeak.score < 1e-9], [["W"], true]);

  // No graded record, no post: a 0-0 capper stays out at 0%.
  check("0%: a 0-0 capper (also a pushes-only one: no decided picks) is excluded", at0([over("z", "Z", [0, 0])]).length, 0);
  check("55%: the same 0-5 capper is out", build([over("w", "W", WEAK)]).length, 0);
}

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll consensus position checks passed");
