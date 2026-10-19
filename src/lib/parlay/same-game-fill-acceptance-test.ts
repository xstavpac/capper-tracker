// Proof for Auto-Generate's "max legs per game" (buildSameGameLegs in
// auto-generate.ts), the doubleheader check it relies on (doubleheader.ts) and
// how the result is laid out (same-game-display.ts). Pure - no DB. Run with:
//   npx tsx src/lib/parlay/same-game-fill-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAutoParlay,
  buildSameGameLegs,
  buildSwapParlay,
  toMaxLegsPerGame,
  type GeneratorGame,
  type GeneratorPick,
} from "@/lib/parlay/auto-generate";
import { FROZEN_CATEGORY_RECORDS, FROZEN_GAMES, FROZEN_LEAGUE_RECORDS, FROZEN_LEG_COUNTS } from "@/lib/parlay/auto-generate-frozen-fixture";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import { incompleteSameGameGroups, legCountText, orderDisplayLegs, sameGameCounts } from "@/lib/parlay/same-game-display";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const games = FROZEN_GAMES;
const lr = FROZEN_LEAGUE_RECORDS;
const cr = FROZEN_CATEGORY_RECORDS;
const ids = (legs: { pick: GeneratorPick }[]) => legs.map((l) => l.pick.pickId);

// ============================================================================
// Max 1: byte for byte what the generator returned before this setting existed
// ============================================================================
{
  const frozenText = readFileSync(join(__dirname, "auto-generate-frozen-parlay-a.json"), "utf8").replace(/\r\n/g, "\n");
  const now: Record<string, unknown> = {};
  for (const n of FROZEN_LEG_COUNTS) now["requested" + n] = buildAutoParlay(games, lr, n);
  check("max 1: Parlay A for 3 / 5 / 20 legs is byte-for-byte the frozen output", JSON.stringify(now, null, 2) + "\n" === frozenText, true);

  for (const n of FROZEN_LEG_COUNTS) {
    const a = buildAutoParlay(games, lr, n);
    const before = JSON.stringify(a);
    check(`max 1, ${n} legs asked: no same-game legs`, buildSameGameLegs(a, games, cr, 1).legs, []);
    buildSameGameLegs(a, games, cr, 3);
    check(`${n} legs asked: building same-game legs leaves Parlay A untouched`, JSON.stringify(a) === before, true);
  }
  check("an unknown setting is read as 1", [0, 6, "2", null, undefined, 2.5].map(toMaxLegsPerGame), [1, 1, 1, 1, 1, 1]);
  check("1 to 5 are read as themselves", [1, 2, 3, 4, 5].map(toMaxLegsPerGame), [1, 2, 3, 4, 5]);
}

// ============================================================================
// Only fills a shortfall
// ============================================================================
{
  // 5 games have picks.
  check("3 legs asked, 5 games: nothing added at max 3", buildSameGameLegs(buildAutoParlay(games, lr, 3), games, cr, 3).legs, []);
  check("5 legs asked, 5 games: nothing added at max 3", buildSameGameLegs(buildAutoParlay(games, lr, 5), games, cr, 3).legs, []);
  const six = buildSameGameLegs(buildAutoParlay(games, lr, 6), games, cr, 3);
  check("6 legs asked, 5 games: exactly one added - the strongest that fits", ids(six.legs), ["g2-c"]);
  const seven = buildSameGameLegs(buildAutoParlay(games, lr, 7), games, cr, 3);
  check("7 legs asked, 5 games: exactly two added", ids(seven.legs), ["g2-c", "g4-b"]);
}

// ============================================================================
// The walk: gate, rules, order, per-game cap
// ============================================================================
const parlayA = buildAutoParlay(games, lr, 20);
const max2 = buildSameGameLegs(parlayA, games, cr, 2);
const max3 = buildSameGameLegs(parlayA, games, cr, 3);
{
  check("Parlay A: one leg from each of the 5 games", parlayA.legs.map((l) => l.top.pick.pickId), ["g1-a", "g2-a", "g3-a", "g4-a", "g5-a"]);

  // Candidates by Wilson: g1-c .670 (second side, R-A), g2-c .546, g2-b .522
  // (game total Under vs Judge's Over, R-E), g4-b .488, g1-d .462, g1-b .445,
  // g2-d .387, g1-e .342. g5-b is on a doubleheader with no game number.
  check("max 2: added strongest first, one extra per game", ids(max2.legs), ["g2-c", "g4-b", "g1-d"]);
  check("max 3: a third leg where one fits", ids(max3.legs), ["g2-c", "g4-b", "g1-d", "g1-b", "g2-d"]);
  check("added legs are in Wilson order", max3.legs.every((l, i) => i === 0 || max3.legs[i - 1].wilsonLowerBound >= l.wilsonLowerBound), true);

  const perGame = (legs: { gameId: string }[]) => {
    const n: Record<string, number> = {};
    for (const l of [...parlayA.legs, ...legs]) n[l.gameId] = (n[l.gameId] ?? 0) + 1;
    return n;
  };
  check("max 2: no game has more than 2 legs", perGame(max2.legs), { g1: 2, g2: 2, g3: 1, g4: 2, g5: 1 });
  check("max 3: no game has more than 3 legs", perGame(max3.legs), { g1: 3, g2: 3, g3: 1, g4: 2, g5: 1 });
  check("every added leg is on a game Parlay A already has, under its own game id", max3.legs.every((l) => l.pick.gameId === l.gameId && parlayA.legs.some((a) => a.gameId === l.gameId)), true);

  check("the rejected strongest candidate (g1-c, a second side) is not in", ids(max3.legs).includes("g1-c"), false);
  check("...and did not block later candidates on its own game", ids(max3.legs).filter((id) => id.startsWith("g1-")), ["g1-d", "g1-b"]);
  check("...or on other games", ids(max3.legs).filter((id) => !id.startsWith("g1-")), ["g2-c", "g4-b", "g2-d"]);
  check("R-E: the game-total Under (g2-b) is skipped once Judge's Over is in, and g2-d after it still gets in", [ids(max3.legs).includes("g2-b"), ids(max3.legs).includes("g2-d")], [false, true]);

  check("gate: the 54.5% pick (g1-f) is never added", [...max2.legs, ...max3.legs].some((l) => l.pick.pickId === "g1-f"), false);
  check("gate: every added leg is at 55% or better", [...max2.legs, ...max3.legs].every((l) => l.record.winPct >= 55), true);
  check("added leg carries the market record that qualified it (g1-d: 30-20, not its 9-6 league record)", max3.legs.find((l) => l.pick.pickId === "g1-d")?.record, { wins: 30, losses: 20, n: 50, winPct: 60 });
  check("never padded: 20 asked, 10 built", parlayA.legs.length + max3.legs.length, 10);
}

// The gate's boundary, on its own: exactly 55.0% is in, just under is out, no
// record and no category are out.
{
  const boundaryGames = games.filter((g) => g.gameId === "g1").map((g) => ({ ...g, picks: g.picks.filter((p) => ["g1-a", "g1-e", "g1-f"].includes(p.pickId)) }));
  const a = buildAutoParlay(boundaryGames, lr, 3);
  check("gate: exactly 55.0% (11-9) qualifies", ids(buildSameGameLegs(a, boundaryGames, cr, 3).legs), ["g1-e"]);
  const under: Record<string, CategoryBreakdownItem | null> = { ...cr, "capE|TD_PROP": { key: "TD_PROP", label: "", wins: 109, losses: 91, pushes: 0, winPct: 54.5, count: 200 } };
  check("gate: 54.5% does not, however large the sample", buildSameGameLegs(a, boundaryGames, under, 3).legs, []);
  check("gate: no record does not", buildSameGameLegs(a, boundaryGames, { ...cr, "capE|TD_PROP": null }, 3).legs, []);
  check("gate: no record entry at all does not", buildSameGameLegs(a, boundaryGames, {}, 3).legs, []);
  const noCategory = boundaryGames.map((g) => ({ ...g, picks: g.picks.map((p) => (p.pickId === "g1-e" ? { ...p, category: null } : p)) }));
  check("gate: a pick with no category does not", buildSameGameLegs(buildAutoParlay(noCategory, lr, 3), noCategory, cr, 3).legs, []);
}

// ============================================================================
// Never past MAX_PARLAY_LEGS (25) legs
// ============================================================================
{
  // Two games short of the cap, each with a side (Parlay A's leg), a game total
  // and a prop that all qualify and all fit together: twice that many candidates
  // for 2 open slots.
  const TEAMS: [string, string][] = [
    ["Chicago Cubs", "Tampa Bay Rays"],
    ["New York Yankees", "Boston Red Sox"],
    ["Los Angeles Dodgers", "San Francisco Giants"],
  ];
  const many: GeneratorGame[] = [];
  const league: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const market: Record<string, CategoryBreakdownItem | null> = {};
  const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
  const GAMES = MAX_PARLAY_LEGS - 2;
  for (let i = 0; i < GAMES; i++) {
    const [homeTeam, awayTeam] = TEAMS[i % TEAMS.length];
    const gameId = "m" + String(i).padStart(2, "0");
    const base = games[0].picks[0];
    const mk = (suffix: string, betType: string, betDetail: string, category: PickCategoryKey, line: number | null): GeneratorPick => {
      const capperId = "cap-" + gameId + suffix;
      league.records[capperId + "|MLB|" + category] = { category, label: "", overall: col(30, 10 + i), league: col(30, 10 + i) };
      market[capperId + "|" + category] = { key: category, label: "", ...col(30, 10 + i) };
      return { ...base, pickId: gameId + suffix, capperId, capperName: capperId, gameId, betType, betDetail, rawBetDetail: betDetail, category, line, homeTeam, awayTeam };
    };
    const side = mk("-a", "MONEYLINE", homeTeam.split(" ").pop() + " ML", "FAV_ML", null);
    // The side is each game's #1: give it the best league record on the game.
    league.records[side.capperId + "|MLB|FAV_ML"] = { category: "FAV_ML", label: "", overall: col(90, 10 + i), league: col(90, 10 + i) };
    many.push({
      gameId,
      gameLabel: gameId,
      gameTime: base.gameTime,
      leagueName: "MLB",
      picks: [side, mk("-b", "TOTAL", "Over 8.5", "OVER", 8.5), mk("-c", "PLAYER_PROP", "Player " + gameId.replace(/\d/g, (d) => "abcdefghij"[+d]) + " over 1.5 total bases", "TD_PROP", null)],
    });
  }
  const a20 = buildAutoParlay(many, league, MAX_PARLAY_LEGS);
  const fill20 = buildSameGameLegs(a20, many, market, 3);
  check(`${MAX_PARLAY_LEGS} asked, ${GAMES} games, ${GAMES * 2} candidates: ${GAMES} + 2, no more`, [a20.legs.length, fill20.legs.length], [GAMES, 2]);
  // Even handed a request past the cap (the action refuses those), it stops at the cap.
  const over = buildSameGameLegs({ ...a20, requested: 50 }, many, market, 3);
  check("a request past the cap still stops at the cap", a20.legs.length + over.legs.length, MAX_PARLAY_LEGS);
}

// ============================================================================
// Doubleheaders
// ============================================================================
{
  const g4 = parlayA.legs.find((l) => l.gameId === "g4")!;
  const g5 = parlayA.legs.find((l) => l.gameId === "g5")!;
  check("the two games of a doubleheader are two games: a Parlay A leg each", [g4.top.pick.pickId, g5.top.pick.pickId], ["g4-a", "g5-a"]);
  check("same teams, different game ids", [g4.top.pick.homeTeam === g5.top.pick.homeTeam, g4.gameId === g5.gameId], [true, false]);
  check("game 1's added leg is grouped with game 1 only", max3.legs.filter((l) => l.pick.pickId === "g4-b").map((l) => l.gameId), ["g4"]);
  check("game 2's qualifying pick with no game number (g5-b) is not paired", ids(max3.legs).includes("g5-b"), false);

  const edit = (fn: (p: GeneratorPick) => GeneratorPick, doubleheader = true) =>
    games.filter((g) => g.gameId === "g5").map((g) => ({ ...g, doubleheader, picks: g.picks.map(fn) }));
  const fillOf = (gs: GeneratorGame[]) => ids(buildSameGameLegs(buildAutoParlay(gs, lr, 3), gs, cr, 3).legs);
  check("...it is once it carries its game number", fillOf(edit((p) => ({ ...p, gameNumber: 2 }))), ["g5-b"]);
  check("...or when the game is not a doubleheader", fillOf(edit((p) => p, false)), ["g5-b"]);
  check("a doubleheader game whose Parlay A leg has no game number is skipped whole", fillOf(edit((p) => (p.pickId === "g5-a" ? { ...p, gameNumber: null } : { ...p, gameNumber: 2 }))), []);
  check("a missing gameNumber field counts as none", fillOf(edit(({ gameNumber: _drop, ...p }) => p)), []);

  // doubleheaderGameIds: what the server action marks games with.
  const card = (id: string, homeTeam: string, awayTeam: string, commenceTime: string) => ({ id, homeTeam, awayTeam, commenceTime });
  const c1 = card("c1", "New York Mets", "Atlanta Braves", "2026-09-23T17:10:00.000Z");
  const c2 = card("c2", "New York Mets", "Atlanta Braves", "2026-09-23T23:10:00.000Z");
  const c3 = card("c3", "Chicago Cubs", "Tampa Bay Rays", "2026-09-23T23:05:00.000Z");
  const nextDay = card("c4", "New York Mets", "Atlanta Braves", "2026-09-24T23:10:00.000Z");
  check("two cards, same teams, same day: both are doubleheader games", Array.from(doubleheaderGameIds([c1, c2, c3])).sort(), ["c1", "c2"]);
  check("same teams on consecutive days are not", Array.from(doubleheaderGameIds([c2, nextDay, c3])), []);
  check("home/away swapped between the two games still counts", Array.from(doubleheaderGameIds([c1, { ...c2, homeTeam: c2.awayTeam, awayTeam: c2.homeTeam }])).sort(), ["c1", "c2"]);
  const sched = (commenceTime: string, doubleHeaderStatus: "Y" | "S" | "N" | null) => ({ homeTeam: "New York Mets", awayTeam: "Atlanta Braves", commenceTime, doubleHeaderStatus });
  check("one card left, the schedule marks it a doubleheader", Array.from(doubleheaderGameIds([c2, c3], [sched(c2.commenceTime, "S")])), ["c2"]);
  check("one card left, the schedule lists the matchup twice that day", Array.from(doubleheaderGameIds([c2, c3], [sched(c1.commenceTime, null), sched(c2.commenceTime, null)])), ["c2"]);
  check("a single game the schedule marks N is not", Array.from(doubleheaderGameIds([c2, c3], [sched(c2.commenceTime, "N")])), []);
  check("no schedule feed at all: board only", Array.from(doubleheaderGameIds([c2, c3])), []);
}

// ============================================================================
// Hedge / Contrarian are built from Parlay A alone
// ============================================================================
{
  const added = new Set(ids(max3.legs));
  for (const mode of ["AUTO_HEDGE", "CONTRARIAN"] as const) {
    const swap = buildSwapParlay(parlayA, games, mode, cr);
    check(`${mode}: one leg per Parlay A leg, ${parlayA.legs.length} not ${parlayA.legs.length + max3.legs.length}`, swap.legs.length, parlayA.legs.length);
    check(`${mode}: every leg starts from a Parlay A leg, none from a same-game leg`, swap.legs.map((l) => l.original.pick.pickId), parlayA.legs.map((l) => l.top.pick.pickId));
    check(`${mode}: still one leg per game`, new Set(swap.legs.map((l) => (l.swap ?? l.original).pick.gameId)).size, swap.legs.length);
    check(`${mode}: no same-game leg is carried over unswapped`, swap.legs.some((l) => added.has(l.original.pick.pickId)), false);
    const without = JSON.stringify(buildSwapParlay(buildAutoParlay(games, lr, 20), games, mode, cr));
    check(`${mode}: identical whether or not same-game legs were built`, JSON.stringify(swap) === without, true);
  }
}

// ============================================================================
// Layout and readout
// ============================================================================
{
  const display = orderDisplayLegs(parlayA.legs, max3.legs);
  const shown = display.map((d) => (d.kind === "TOP" ? d.leg.top.pick.pickId : d.leg.pick.pickId));
  check("legs of one game sit together, Parlay A's leg first", shown, ["g1-a", "g1-d", "g1-b", "g2-a", "g2-c", "g2-d", "g3-a", "g4-a", "g4-b", "g5-a"]);
  check("every leg of a game with 2+ legs is marked, the rest are not", display.map((d) => d.sameGame), [true, true, true, true, true, true, false, true, true, false]);
  check("row keys (pick ids) are unique", new Set(shown).size, shown.length);

  const legGames = display.map((d) => ({ gameId: d.gameId }));
  check("counts: a 3-leg game is one SGP", sameGameCounts(legGames), { legs: 10, games: 5, sgps: 3 });
  check("readout with SGPs", legCountText(legGames, ["MLB"]), "10 legs · 5 games · 3 SGPs");
  check("readout, one SGP", legCountText([{ gameId: "a" }, { gameId: "a" }, { gameId: "b" }], ["MLB"]), "3 legs · 2 games · 1 SGP");
  check("readout with no SGP is the old one", legCountText(parlayA.legs, ["MLB", "NFL"]), "5 legs · MLB, NFL");
  check("readout, one leg", legCountText([{ gameId: "a" }], ["MLB"]), "1 leg · MLB");
  const eighteen = [...Array.from({ length: 14 }, (_, i) => ({ gameId: "g" + i })), { gameId: "g0" }, { gameId: "g0" }, { gameId: "g1" }, { gameId: "g1" }];
  check("readout: 18 legs · 14 games · 2 SGPs", legCountText(eighteen, ["MLB"]), "18 legs · 14 games · 2 SGPs");

  // Send to FanDuel: a same-game group the link doesn't hold whole.
  const send = [
    { pickId: "g1-a", gameId: "g1", gameLabel: "Rays @ Cubs" },
    { pickId: "g1-d", gameId: "g1", gameLabel: "Rays @ Cubs" },
    { pickId: "g2-a", gameId: "g2", gameLabel: "Red Sox @ Yankees" },
    { pickId: "g2-c", gameId: "g2", gameLabel: "Red Sox @ Yankees" },
    { pickId: "g3-a", gameId: "g3", gameLabel: "Giants @ Dodgers" },
  ];
  check("FanDuel: all sent -> nothing to flag", incompleteSameGameGroups(send, new Set(send.map((l) => l.pickId))), []);
  check("FanDuel: one leg of a pair not sent -> that game is flagged", incompleteSameGameGroups(send, new Set(["g1-a", "g2-a", "g2-c", "g3-a"])), [{ gameId: "g1", gameLabel: "Rays @ Cubs", sent: 1, total: 2 }]);
  check("FanDuel: neither leg of a pair sent -> flagged too", incompleteSameGameGroups(send, new Set(["g1-a", "g1-d", "g3-a"])), [{ gameId: "g2", gameLabel: "Red Sox @ Yankees", sent: 0, total: 2 }]);
  check("FanDuel: a single-leg game not sent is not a same-game problem", incompleteSameGameGroups(send, new Set(["g1-a", "g1-d", "g2-a", "g2-c"])), []);
  check("FanDuel: legs with no game id are in no group", incompleteSameGameGroups([{ pickId: "x" }, { pickId: "y" }], new Set()), []);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll same-game fill checks passed");
