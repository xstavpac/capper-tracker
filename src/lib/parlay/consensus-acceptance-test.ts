// Consensus Hybrid's position builder (consensus.ts): distinct-capper supporters,
// ML + spread merged into one team side, the easiest endorsed line as the
// anchor, gated opposers only, the supporter threshold, the markets left out,
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

check("the supporter threshold is a named constant at 2", HYBRID_MIN_SUPPORTERS, 2);

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
  check("the score counts the capper once", p.score, 2 * lb(8, 2));
  check("one capper alone is not a position", build([{ id: "a1", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD }, { id: "a2", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -6.5 }, lg: GOOD }]).length, 0);
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
  check("each team's merged side is its own position", ps.map((p) => p.direction).sort(), [AWAY, HOME].sort());
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
// Opposers: gated ones are subtracted, ungated ones are ignored
// ============================================================================
{
  const base: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: [6, 4] },
  ];
  const noOpp = find(build(base), "OVER")!;
  check("score without opposers", noOpp.score, lb(8, 2) + lb(6, 4));
  const gated = find(build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }]), "OVER")!;
  check("a gated opposer is subtracted", [gated.opposers.map((o) => o.capperId), gated.score], [["C"], lb(8, 2) + lb(6, 4) - lb(7, 3)]);
  const ungated = find(build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [3, 7] }]), "OVER")!;
  check("an ungated opposer (30%) is ignored", [ungated.opposers.length, ungated.score], [0, noOpp.score]);
  const opposerOnly = build([...base, { id: "c", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }]);
  check("one opposer alone does not make a position of the other side", opposerOnly.map((p) => p.direction), ["OVER"]);
  // Opposers count by capper: two posts, one opposer.
  const twoPosts = find(build([...base, { id: "c1", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: [7, 3] }, { id: "c2", capper: "C", bet: { kind: "TOTAL", side: "Under", line: 46 }, lg: [7, 3] }]), "OVER")!;
  check("an opposer with two posts is subtracted once", twoPosts.score, lb(8, 2) + lb(6, 4) - lb(7, 3));
  // A capper who backed both directions has hedged: on neither side.
  const hedged = build([...base, { id: "h1", capper: "H", bet: { kind: "TOTAL", side: "Over", line: 44 }, lg: GOOD }, { id: "h2", capper: "H", bet: { kind: "TOTAL", side: "Under", line: 44 }, lg: GOOD }]);
  check("a capper on both directions is neither supporter nor opposer", [find(hedged, "OVER")!.supporters.map((s) => s.capperId).sort(), find(hedged, "OVER")!.opposers.length], [["A", "B"], 0]);
}

// ============================================================================
// The N threshold, and the markets left out
// ============================================================================
{
  const two: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: GOOD },
  ];
  check("two supporters qualify", build(two).length, 1);
  check("one supporter does not", build(two.slice(0, 1)).length, 0);
  check("minSupporters is adjustable", [build(two.slice(0, 1), { minSupporters: 1 }).length, build(two, { minSupporters: 3 }).length], [1, 0]);

  const other = (id: string, capper: string, bet: Bet): Spec => ({ id, capper, bet, lg: GOOD });
  for (const [name, bet] of [
    ["player props", { kind: "PROP" }],
    ["team totals", { kind: "TEAM_TOTAL", side: "Over", line: 24.5 }],
    ["NRFI", { kind: "NRFI" }],
    ["period spreads (1H)", { kind: "H1_SPREAD", team: "HOME", line: -1.5 }],
    ["regulation (3-way) moneylines", { kind: "REG_ML", team: "HOME" }],
  ] as [string, Bet][]) {
    check(`${name} never make a position`, build([other("x", "A", bet), other("y", "B", bet), other("z", "C", bet)]).length, 0);
    check(`${name} do not count as a supporter beside a real post`, build([...two.slice(0, 1), other("x", "B", bet)]).length, 0);
  }
}
{
  // Doubleheader: a pick with no game number could be on either game.
  const specs: Spec[] = [
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -1.5 }, lg: GOOD, gameNumber: 1 },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -1.5 }, lg: GOOD, gameNumber: null },
  ];
  check("doubleheader: a pick with no game number is not used", build(specs, {}, { doubleheader: true }).length, 0);
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
// The record hierarchy, the win-% lever and the soft sample-size adjustment
// ============================================================================
{
  // League record first, even when the all-time one is better.
  const leagueFirst = find(build([
    { id: "a", capper: "A", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [90, 10] },
    { id: "b", capper: "B", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [6, 4], all: [90, 10] },
  ]), HOME)!;
  check("the league-specific record is used first", leagueFirst.supporters.map((s) => [s.record.source, s.record.wins, s.record.losses]), [["LEAGUE", 6, 4], ["LEAGUE", 6, 4]]);
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
  check("gate 65 drops the 60% capper: one supporter left", build(specs, { minWinPct: 65 }).length, 0);
  check("gate 70 drops the 60%", build([specs[1], { ...specs[1], id: "c", capper: "C" }], { minWinPct: 70 }).length, 1);
  check("an invalid lever is the 55 default", build(specs, { minWinPct: 63 }).length, 1);
  check("gate 55 with a 52% record: not a supporter", build([specs[1], { id: "c", capper: "C", bet: { kind: "SPREAD", team: "HOME", line: -3 }, lg: [13, 12] }]).length, 0);
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

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll consensus position checks passed");
