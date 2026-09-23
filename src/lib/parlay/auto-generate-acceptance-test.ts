// Proof for auto-generate.ts (Parlay A + Hedge + Contrarian). Pure: no DB -
// records are hand-built fixtures in the same shapes getCapperLeagueRecords /
// getCapperCategoryRecords return. Run with:
//   npx tsx src/lib/parlay/auto-generate-acceptance-test.ts
import {
  buildAutoParlay,
  buildSwapParlay,
  type GeneratorGame,
  type GeneratorPick,
} from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { pickCategory, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import type { BetType, Period } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const GAME_TIME = "2026-09-23T23:05:00.000Z";
const POSTED = "2026-09-23T15:00:00.000Z";

type GameTeams = { gameId: string; homeTeam: string; awayTeam: string };
const G1: GameTeams = { gameId: "g1", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox" };
const G2: GameTeams = { gameId: "g2", homeTeam: "New York Mets", awayTeam: "Atlanta Braves" };
const G3: GameTeams = { gameId: "g3", homeTeam: "Los Angeles Dodgers", awayTeam: "San Francisco Giants" };
const G4: GameTeams = { gameId: "g4", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals" };

function mk(
  game: GameTeams,
  pickId: string,
  capperId: string,
  betType: string,
  betDetail: string,
  odds: number,
  line: number | null = null
): GeneratorPick {
  const category = pickCategory({
    betType: betType as BetType,
    period: "FULL_GAME" as Period,
    betDetail,
    odds,
    line,
    sportName: "MLB",
  });
  return {
    pickId,
    capperId,
    capperName: capperId,
    capperColorTag: null,
    capperIsFavorite: false,
    category,
    leagueName: "MLB",
    gameId: game.gameId,
    gameLabel: game.awayTeam + " @ " + game.homeTeam,
    betDetail,
    odds,
    units: 1,
    status: "PENDING",
    betType,
    period: "FULL_GAME",
    rawBetDetail: betDetail,
    line,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    gameTime: GAME_TIME,
    teamGroup: "OTHER",
    teamLabel: "",
    teamColor: null,
    datePosted: POSTED,
  };
}

function game(teams: GameTeams, picks: GeneratorPick[]): GeneratorGame {
  return { gameId: teams.gameId, gameLabel: teams.gameId, gameTime: GAME_TIME, leagueName: "MLB", picks };
}

// Parlay A's records (getCapperLeagueRecords shape): league column = overall
// column here, so the rank basis is the LEAGUE record.
function leagueRecords(entries: [GeneratorPick, number, number][]): CapperLeagueRecords {
  const records: CapperLeagueRecords["records"] = {};
  for (const [p, wins, losses] of entries) {
    const col = { wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
    records[p.capperId + "|MLB|" + p.category] = { category: p.category!, label: "", overall: col, league: col };
  }
  return { records, streaks: {}, last20: {} };
}

// Hedge/Contrarian's records (getCapperCategoryRecords shape).
function categoryRecords(entries: [string, PickCategoryKey, number, number][]): Record<string, CategoryBreakdownItem | null> {
  const out: Record<string, CategoryBreakdownItem | null> = {};
  for (const [capperId, key, wins, losses] of entries) {
    out[capperId + "|" + key] = { key, label: "", wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture slate
// ---------------------------------------------------------------------------
const a1 = mk(G1, "a1", "capA", "MONEYLINE", "Yankees ML", -150); // 70% - G1's #1
const a2 = mk(G1, "a2", "capB", "TOTAL", "Over 8.5", -110, 8.5); // hedge alternate
const a3 = mk(G1, "a3", "capC", "MONEYLINE", "Red Sox ML", 130); // contrarian alternate
const a4 = mk(G1, "a4", "capD", "MONEYLINE", "Yankees ML", -150); // second Yankees capper -> majority
const b1 = mk(G2, "b1", "capE", "MONEYLINE", "Mets ML", -130); // 65% (13-7)
const b2 = mk(G2, "b2", "capF", "MONEYLINE", "Mets ML", -130); // 65% (26-14) - wins the tie on sample
const c1 = mk(G3, "c1", "capG", "MONEYLINE", "Dodgers ML", -140); // 62%, G3's #1
const c2 = mk(G3, "c2", "capH", "TOTAL", "Under 7.5", -110, 7.5); // alternate that fails the 55% gate

const games = [game(G1, [a1, a2, a3, a4]), game(G2, [b1, b2]), game(G3, [c1, c2])];
const lr = leagueRecords([
  [a1, 21, 9],
  [a2, 12, 8],
  [a3, 7, 5],
  [a4, 11, 9],
  [b1, 13, 7],
  [b2, 26, 14],
  [c1, 31, 19],
  [c2, 5, 5],
]);
const cr = categoryRecords([
  ["capB", "OVER", 16, 9], // 64% - qualifies
  ["capC", "DOG_ML", 7, 5], // 58.3% - qualifies
  ["capE", "FAV_ML", 13, 7],
  ["capH", "UNDER", 10, 10], // 50% - fails the gate
]);

// ============================================================================
// Parlay A
// ============================================================================
const parlayA = buildAutoParlay(games, lr, 3);
const parlayASnapshot = JSON.stringify(parlayA);
{
  check("A: 3 legs requested and built", parlayA.legs.length, 3);
  check("A: exactly one leg per game (distinct gameIds)", new Set(parlayA.legs.map((l) => l.gameId)).size, parlayA.legs.length);
  check("A: every leg's pick belongs to that leg's game", parlayA.legs.every((l) => l.top.pick.gameId === l.gameId), true);
  check("A: legs ordered by strongest #1 pick (70% > 65% > 62%)", parlayA.legs.map((l) => l.top.pick.pickId), ["a1", "b2", "c1"]);
  check("A: 65% tie goes to the bigger sample (26-14 over 13-7)", parlayA.legs[1].top.pick.pickId, "b2");
  check("A: leg carries its market record", parlayA.legs[0].top.record && { w: parlayA.legs[0].top.record.wins, l: parlayA.legs[0].top.record.losses, s: parlayA.legs[0].top.record.source }, { w: 21, l: 9, s: "LEAGUE" });
  check("A: next picks for G1 in rank order", parlayA.legs[0].next.map((r) => r.pick.pickId), ["a2", "a3", "a4"]);
  check("A: G3's runner-up still shown despite small record", parlayA.legs[2].next.map((r) => r.pick.pickId), ["c2"]);
}

// Fewer games than requested -> reports available, never pads or silently shrinks.
{
  const short = buildAutoParlay(games, lr, 5);
  check("shortfall: requested stays 5", short.requested, 5);
  check("shortfall: available = 3 games with picks", short.available, 3);
  check("shortfall: 3 legs, still one per game", [short.legs.length, new Set(short.legs.map((l) => l.gameId)).size], [3, 3]);
  const withEmptyGame = buildAutoParlay([...games, game(G4, [])], lr, 5);
  check("shortfall: a game with no picks isn't counted as available", withEmptyGame.available, 3);
}

// Pick with no record ranks below any pick with one, but is still a candidate.
{
  const noRec = mk(G4, "d1", "capZ", "MONEYLINE", "Cubs ML", -120);
  const r = buildAutoParlay([game(G4, [noRec]), game(G3, [c1])], lr, 2);
  check("no record: still builds a leg for its game, ranked last", r.legs.map((l) => [l.top.pick.pickId, l.top.record === null]), [["c1", false], ["d1", true]]);
}

// ============================================================================
// Hedge
// ============================================================================
{
  const hedge = buildSwapParlay(parlayA, games, "AUTO_HEDGE", cr);
  check("hedge: same leg count as Parlay A", hedge.legs.length, parlayA.legs.length);
  check("hedge: still one leg per game", new Set(hedge.legs.map((l) => (l.swap ?? l.original).pick.gameId)).size, hedge.legs.length);
  const g1 = hedge.legs[0];
  check("hedge: G1 Yankees ML swapped to Over 8.5", g1.swap?.pick.pickId, "a2");
  check("hedge: the swap stays in the same game", g1.swap?.pick.gameId, g1.gameId);
  check("hedge: swap carries the gated market record (16-9)", g1.swap && [g1.swap.record.wins, g1.swap.record.losses], [16, 9]);
  check("hedge: side-vs-total is rule R4", g1.swap?.rule, "R4");
  check("hedge: G2 has no alternate (only a duplicate Mets ML) -> unchanged", [hedge.legs[1].swap, hedge.legs[1].unchangedReason], [null, "NO_ALTERNATE"]);
  check("hedge: G3's only alternate fails the 55% gate -> leg stays", [hedge.legs[2].swap, hedge.legs[2].original.pick.pickId], [null, "c1"]);
  check(
    "hedge: unchanged legs are identical to Parlay A's legs",
    [1, 2].map((i) => JSON.stringify(hedge.legs[i].original) === JSON.stringify(parlayA.legs[i].top)),
    [true, true]
  );
  check("hedge: swap count = 1 of 3", hedge.swapCount, 1);
}

// ============================================================================
// Contrarian
// ============================================================================
{
  const contrarian = buildSwapParlay(parlayA, games, "CONTRARIAN", cr);
  const g1 = contrarian.legs[0];
  check("contrarian: G1 Yankees ML flipped to Red Sox ML (2-vs-1 majority)", g1.swap?.pick.pickId, "a3");
  check("contrarian: flip stays in the same game", g1.swap?.pick.gameId, g1.gameId);
  check("contrarian: opposing side is rule R2", g1.swap?.rule, "R2");
  check("contrarian: G1 does not take the hedge's Over", g1.swap?.pick.pickId !== "a2", true);
  check("contrarian: G2/G3 unchanged", [contrarian.legs[1].swap, contrarian.legs[2].swap], [null, null]);
  check("contrarian: swap count = 1 of 3", contrarian.swapCount, 1);

  // 1-vs-1: primary's side isn't the majority -> unchanged, and says why.
  const e1 = mk(G4, "e1", "capX", "MONEYLINE", "Cubs ML", -120);
  const e2 = mk(G4, "e2", "capY", "MONEYLINE", "Cardinals ML", 110);
  const tieGames = [game(G4, [e1, e2])];
  const tieA = buildAutoParlay(tieGames, leagueRecords([[e1, 20, 10], [e2, 15, 10]]), 1);
  const tie = buildSwapParlay(tieA, tieGames, "CONTRARIAN", categoryRecords([["capY", "DOG_ML", 15, 10]]));
  check("contrarian: 1-vs-1 tie -> unchanged with NOT_MAJORITY", [tie.legs[0].swap, tie.legs[0].unchangedReason], [null, "NOT_MAJORITY"]);
}

// ============================================================================
// Parlay A is never modified by building Hedge / Contrarian
// ============================================================================
check("Parlay A unchanged after Hedge + Contrarian builds", JSON.stringify(parlayA) === parlayASnapshot, true);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll auto-generate checks passed");
