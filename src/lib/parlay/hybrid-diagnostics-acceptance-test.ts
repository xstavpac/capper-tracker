// Consensus Hybrid's "Why only N games?" (hybrid-diagnostics.ts): every game with
// picks the parlay does not use gets the FIRST gate it failed, with its numbers -
// started / off the slate, no full-game picks, no side, no total, best capper below
// the win rate, too few cappers agreeing (and hedged cappers), past the pricing
// limit, FanDuel lines unavailable, no usable line, and built but not used. Used
// and alternate games are never listed; games with no picks never count. Pure -
// no DB, no fetch.
//   npx tsx src/lib/parlay/hybrid-diagnostics-acceptance-test.ts
import { buildConsensusPositions } from "@/lib/parlay/consensus";
import { explainSkips, SKIP_REASON_ORDER, skipReasonLabel, type ExplainInput } from "@/lib/parlay/hybrid-diagnostics";
import type { Hybrid, HybridBoxReport, HybridResult } from "@/lib/parlay/hybrid";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { HybridEventNote } from "@/server/data/hybrid-generate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-10-15T14:00:00.000Z");
const START = "2026-10-16T00:15:00.000Z";
const HOME = "Denver Broncos";
const AWAY = "Seattle Seahawks";

// ---- A snapshot built pick by pick: each pick names its capper, market and record ----
type Kind = "HOME_SPREAD" | "AWAY_SPREAD" | "HOME_ML" | "OVER" | "UNDER" | "PROP" | "FIRST_HALF_OVER";
type Spec = { capper: string; kind: Kind; w: number; l: number };
const records: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });

function pickOf(gameId: string, i: number, spec: Spec): GeneratorPick {
  const table: Record<Kind, { betType: string; period: string; detail: string; line: number | null; category: PickCategoryKey | null }> = {
    HOME_SPREAD: { betType: "SPREAD", period: "FULL_GAME", detail: "Broncos +3", line: 3, category: "SPREAD_PLUS" },
    AWAY_SPREAD: { betType: "SPREAD", period: "FULL_GAME", detail: "Seahawks -3", line: -3, category: "SPREAD_MINUS" },
    HOME_ML: { betType: "MONEYLINE", period: "FULL_GAME", detail: "Broncos ML", line: null, category: "DOG_ML" },
    OVER: { betType: "TOTAL", period: "FULL_GAME", detail: "Over 41.5", line: 41.5, category: "OVER" },
    UNDER: { betType: "TOTAL", period: "FULL_GAME", detail: "Under 41.5", line: 41.5, category: "UNDER" },
    PROP: { betType: "PLAYER_PROP", period: "FULL_GAME", detail: "Bo Nix over 220.5 passing yards", line: 220.5, category: null },
    FIRST_HALF_OVER: { betType: "TOTAL", period: "FIRST_HALF", detail: "1H Over 20.5", line: 20.5, category: "FIRST_HALF_OVER" },
  };
  const t = table[spec.kind];
  if (t.category) {
    const rec = col(spec.w, spec.l);
    records.records[spec.capper + "|NFL|" + t.category] = { category: t.category, label: t.category, overall: rec, league: rec } as never;
    categoryRecords[spec.capper + "|" + t.category] = { key: t.category, label: t.category, ...rec };
  }
  return {
    pickId: gameId + "-" + i, capperId: spec.capper, capperName: "Capper " + spec.capper, capperColorTag: null, capperIsFavorite: false,
    category: t.category, leagueName: "NFL", gameId, gameLabel: AWAY + " @ " + HOME + " (" + gameId + ")", betDetail: t.detail, odds: -110, units: 1, status: "PENDING",
    betType: t.betType, period: t.period, rawBetDetail: t.detail, propMarket: null, line: t.line, homeTeam: HOME, awayTeam: AWAY, gameTime: START,
    teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2026-10-14T00:00:00.000Z", gameNumber: null,
  } as unknown as GeneratorPick;
}
function game(id: string, specs: Spec[]): GeneratorGame {
  return { gameId: id, gameLabel: AWAY + " @ " + HOME + " (" + id + ")", gameTime: START, leagueName: "NFL", picks: specs.map((s, i) => pickOf(id, i, s)) } as GeneratorGame;
}
const good = (capper: string, kind: Kind): Spec => ({ capper, kind, w: 60, l: 40 });
const box = (id: string): GeneratorGame => game(id, [good(id + "a", "HOME_SPREAD"), good(id + "b", "HOME_SPREAD"), good(id + "c", "OVER"), good(id + "d", "OVER")]);

const games: GeneratorGame[] = [
  game("G01", [{ capper: "p1", kind: "PROP", w: 0, l: 0 }, { capper: "p2", kind: "FIRST_HALF_OVER", w: 9, l: 1 }]),
  game("G02", [good("s1", "HOME_SPREAD"), good("s2", "HOME_ML")]),
  game("G03", [good("t1", "OVER"), good("t2", "OVER")]),
  game("G04", [good("a1", "HOME_SPREAD"), good("a2", "HOME_SPREAD"), { capper: "a3", kind: "OVER", w: 8, l: 8 }, { capper: "a4", kind: "UNDER", w: 3, l: 5 }]),
  game("G05", [{ capper: "b1", kind: "HOME_SPREAD", w: 47, l: 52 }, { capper: "b2", kind: "AWAY_SPREAD", w: 20, l: 30 }, good("b3", "OVER"), good("b4", "OVER")]),
  game("G06", [good("c1", "HOME_SPREAD"), good("c2", "HOME_SPREAD"), { capper: "c3", kind: "OVER", w: 29, l: 16 }, { capper: "c4", kind: "OVER", w: 10, l: 17 }]),
  game("G07", [good("d1", "HOME_SPREAD"), good("d2", "HOME_SPREAD"), good("d3", "OVER"), good("d3", "UNDER")]),
  box("G08"),
  box("G09"),
  box("G10"),
  box("G11"),
  box("G12"),
  box("G13"),
  { gameId: "G14", gameLabel: "Empty", gameTime: START, leagueName: "NFL", picks: [] } as unknown as GeneratorGame,
];
const snapshot: Pick<GeneratorSnapshot, "leagueRecords" | "categoryRecords"> = { leagueRecords: records, categoryRecords };
const positions = buildConsensusPositions({ games, ...snapshot }, { now: NOW });

const legsOn = (...ids: string[]) => ({ legs: ids.map((eventId) => ({ eventId })) }) as unknown as Hybrid;
const result: HybridResult = { primary: legsOn("G12", "G12"), alternates: [legsOn("G13", "G13")], note: null, delivery: { requestedLegs: 3, deliveredLegs: 2, boxes: 1, qualifyingGames: 6, shortOfGames: false } };
const report: HybridBoxReport = { notReached: [], noLine: [{ eventId: "G10", leg: "total" }], leftOut: [{ eventId: "G11", why: "cap" }] };
const notes: HybridEventNote[] = [{ eventId: "G09", gameLabel: "x", kind: "alt-lines-not-posted", message: "x" }];
const base: ExplainInput = {
  games,
  pickCounts: Object.fromEntries(games.map((g) => [g.gameId, g.picks.length])),
  snapshotSkipped: [
    { gameId: "S1", gameLabel: "Bills @ Jets", gameTime: START, leagueName: "NFL", picks: 3, reason: "started" },
    { gameId: "S2", gameLabel: "Nets @ Celtics", gameTime: START, leagueName: "NBA", picks: 2, reason: "outside-window" },
    { gameId: "S3", gameLabel: "Chiefs @ Raiders", gameTime: START, leagueName: "NFL", picks: 1, reason: "outside-window" },
  ],
  records: snapshot,
  minWinPct: 55,
  filtered: false,
  positions,
  candidateEvents: ["G09", "G10", "G11", "G12", "G13"],
  notes,
  report,
  result,
};
const d = explainSkips(base);
const row = (id: string) => d.skipped.find((r) => r.eventId === id);
const reasonOf = (id: string) => row(id)?.reason ?? null;
const textOf = (id: string) => row(id)?.text ?? null;

// ---- a: started / off the slate (from the snapshot) ----
check("a: started", [reasonOf("S1"), textOf("S1")], ["started", "Already started"]);
check("a: outside the window, daily league", [reasonOf("S2"), textOf("S2")], ["outside-window", "Not on today's slate"]);
check("a: outside the window, weekly league", textOf("S3"), "Not in this week's slate");

// ---- b-e: the consensus gates, first failure only ----
check("b: props and period picks only", [reasonOf("G01"), textOf("G01")], ["no-eligible-picks", "No full-game spread, moneyline or total picks (2 other picks: props, periods or team totals)"]);
check("c: a side but no total", [reasonOf("G02"), textOf("G02")], ["no-total-picks", "No full-game total picks"]);
check("c: a total but no side", [reasonOf("G03"), textOf("G03")], ["no-side-picks", "No full-game side picks (spread or moneyline)"]);
check("d: the best total capper is below 55%, with the record", [reasonOf("G04"), textOf("G04")], ["below-gate", "Best Over capper 50% (8-8), needs 55%"]);
check("d: the side is checked before the total", [reasonOf("G05"), textOf("G05")], ["below-gate", "Best Denver Broncos capper 47% (47-52), needs 55%"]);
check("one capper at 55%+ on the total is enough now: the game is a box (here past the pricing limit)", reasonOf("G06"), "beyond-ladder-limit");
check("\"needs 2\" never appears under the one-capper rule", d.skipped.some((r) => r.text.includes("needs 2")), false);
// With a minimum of 2 (still supported), the agreement gate reads as before.
const two = explainSkips({ ...base, minSupporters: 2, positions: buildConsensusPositions({ games, ...snapshot }, { now: NOW, minSupporters: 2 }) });
check("e (minimum 2): one capper at 55%+ on the total, two needed", [two.skipped.find((r) => r.eventId === "G06")!.reason, two.skipped.find((r) => r.eventId === "G06")!.text], ["not-enough-supporters", "Only 1 capper at 55%+ on the total (Over); needs 2"]);
check("e (minimum 2): its label", two.counts.find((c) => c.reason === "not-enough-supporters")!.label, "Fewer than 2 cappers agree");
check("e: a capper on both sides of the total is set aside", [reasonOf("G07"), textOf("G07")], ["not-enough-supporters", "Cappers at 55%+ took both sides of the total, so neither side counts"]);

// ---- f-i: after consensus ----
check("f: box-eligible but past the pricing limit", [reasonOf("G08"), textOf("G08")], ["beyond-ladder-limit", "Not priced: each generation prices the top 5 qualifying games"]);
check("g: FanDuel hasn't posted alternate lines", [reasonOf("G09"), textOf("G09")], ["ladder-unavailable", "FanDuel hasn't posted alternate lines for this game yet"]);
check("h: no usable line for the total", [reasonOf("G10"), textOf("G10")], ["no-usable-line", "No usable FanDuel total line (none within -600 or your per-leg range)"]);
check("i: built, but the Total legs cap was reached", [reasonOf("G11"), textOf("G11")], ["not-used", "Total legs cap reached"]);

// ---- What is never listed ----
check("the primary's game and the alternate's game are not listed", [row("G12"), row("G13")], [undefined, undefined]);
check("a game with no picks is neither listed nor counted", [row("G14"), d.gamesWithPicks], [undefined, 16]);
check("games used: the primary's", d.gamesUsed, 1);

// ---- Order and counts ----
check("rows come in gate order", d.skipped.map((r) => SKIP_REASON_ORDER.indexOf(r.reason)).every((v, i, a) => i === 0 || a[i - 1] <= v), true);
check("one row per left-out game", d.skipped.length, 14);
check(
  "counts by reason, in gate order, only those that occur",
  d.counts.map((c) => [c.reason, c.count]),
  [["started", 1], ["outside-window", 2], ["no-eligible-picks", 1], ["no-side-picks", 1], ["no-total-picks", 1], ["below-gate", 2], ["not-enough-supporters", 1], ["beyond-ladder-limit", 2], ["ladder-unavailable", 1], ["no-usable-line", 1], ["not-used", 1]]
);
check("the counts' labels: under the one-capper rule this reason is only hedging", d.counts.find((c) => c.reason === "not-enough-supporters")!.label, "Cappers took both sides");
check("every reason has a label", SKIP_REASON_ORDER.every((r) => skipReasonLabel(r).length > 0), true);

// ---- The gate and the Bet types follow the settings ----
const at45 = explainSkips({ ...base, minWinPct: 45, positions: buildConsensusPositions({ games, ...snapshot }, { now: NOW, minWinPct: 45 }) });
check("at 45%: the 50% Over capper now clears, so the game is a box (past the pricing limit here)", at45.skipped.find((r) => r.eventId === "G04")!.reason, "beyond-ladder-limit");
const filtered = explainSkips({ ...base, filtered: true });
check("Bet types filtering is named", filtered.skipped.find((r) => r.eventId === "G02")!.text, "No full-game total picks in your Bet types");
check("pick counts come from before the Bet types filter", explainSkips({ ...base, pickCounts: { ...base.pickCounts, G02: 7 } }).skipped.find((r) => r.eventId === "G02")!.picks, 7);

// ---- Ladder notes: budget, pricing, failures ----
const noteFor = (n: Partial<HybridEventNote>) => explainSkips({ ...base, notes: [{ eventId: "G09", gameLabel: "x", kind: "ladders-unavailable", message: "x", ...n }] }).skipped.find((r) => r.eventId === "G09")!.text;
check("g: the credit budget", noteFor({ cause: "budget" }), "Today's FanDuel price lookups are used up");
check("g: the usage gate reads the same", noteFor({ cause: "usage-gate" }), "Today's FanDuel price lookups are used up");
check("g: an API failure", noteFor({ cause: "api-failure" }), "FanDuel prices are unavailable right now");
check("g: pricing in progress", noteFor({ kind: "pricing-in-progress" }), "Another request is pricing this game - try again in a moment");
check("i: ranked below the games shown", explainSkips({ ...base, report: { ...report, leftOut: [{ eventId: "G11", why: "ranked" }] } }).skipped.find((r) => r.eventId === "G11")!.text, "Ranked below the games shown");
check("i: past the optimizer's box limit reads as ranked lower", explainSkips({ ...base, report: { ...report, leftOut: [], notReached: ["G11"] } }).skipped.find((r) => r.eventId === "G11")!.text, "Ranked below the games shown");

// ---- No result at all ----
const none = explainSkips({ ...base, result: { primary: null, alternates: [], note: "x", delivery: { requestedLegs: 3, deliveredLegs: 0, boxes: 0, qualifyingGames: 0, shortOfGames: true } } });
check("no primary: games used 0, the primary's and alternate's games now listed", [none.gamesUsed, none.skipped.some((r) => r.eventId === "G12"), none.skipped.some((r) => r.eventId === "G13")], [0, true, true]);

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll hybrid diagnostics checks passed.");
process.exit(failures > 0 ? 1 : 0);
