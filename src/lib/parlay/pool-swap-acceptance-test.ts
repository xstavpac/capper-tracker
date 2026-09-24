// Proof for pool-swap.ts (Hedge/Contrarian on Select-Your-Own-Picks' pool).
// Pure: no DB - records/games are hand-built fixtures in the same shapes
// getCapperLeagueRecords / getLiveBoardData's catalog already return, same
// convention as auto-generate-acceptance-test.ts. Run with:
//   npx tsx src/lib/parlay/pool-swap-acceptance-test.ts
import { buildPoolPrimary, excludeSelectedPicks } from "@/lib/parlay/pool-swap";
import { buildSwapParlay, type GeneratorGame, type GeneratorPick } from "@/lib/parlay/auto-generate";
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

function mk(
  game: GameTeams,
  pickId: string,
  capperId: string,
  betType: string,
  betDetail: string,
  odds: number,
  line: number | null = null,
  datePosted: string | undefined = POSTED
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
    datePosted: datePosted as string,
  };
}

function game(teams: GameTeams, picks: GeneratorPick[]): GeneratorGame {
  return { gameId: teams.gameId, gameLabel: teams.gameId, gameTime: GAME_TIME, leagueName: "MLB", picks };
}

function leagueRecords(entries: [GeneratorPick, number, number][]): CapperLeagueRecords {
  const records: CapperLeagueRecords["records"] = {};
  for (const [p, wins, losses] of entries) {
    const col = { wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
    records[p.capperId + "|MLB|" + p.category] = { category: p.category!, label: "", overall: col, league: col };
  }
  return { records, streaks: {}, last20: {} };
}

function categoryRecords(entries: [string, PickCategoryKey, number, number][]): Record<string, CategoryBreakdownItem | null> {
  const out: Record<string, CategoryBreakdownItem | null> = {};
  for (const [capperId, key, wins, losses] of entries) {
    out[capperId + "|" + key] = { key, label: "", wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
  }
  return out;
}

// ============================================================================
// buildPoolPrimary: ranks by win%, applies Section 9 conflict validation
// (same rule My Picks uses), and honors whatever leg count is requested -
// no fixed ceiling like Auto-Generate's AUTO_GENERATE_MAX_LEGS.
// ============================================================================
{
  const p1 = mk(G1, "p1", "capA", "MONEYLINE", "Yankees ML", -150); // 70% - highest ranked
  const p2 = mk(G1, "p2", "capB", "TOTAL", "Over 8.5", -110, 8.5); // independent of p1 (R4) - allowed alongside it
  const p3 = mk(G2, "p3", "capC", "MONEYLINE", "Mets ML", -130); // 62%
  const p4 = mk(G1, "p4", "capD", "MONEYLINE", "Red Sox ML", 130); // opposes p1 (R2) - conflicts, lower ranked

  const records = leagueRecords([
    [p1, 21, 9], // 70%
    [p2, 12, 8], // 60%
    [p3, 13, 8], // 62%
    [p4, 5, 5], // 50%
  ]);

  const primary = buildPoolPrimary([p1, p2, p3, p4], records, 4);
  check(
    "buildPoolPrimary: conflict-free legs kept, ranked best-first (p1 70% > p3 62% > p2 60%)",
    primary.parlayA.legs.map((l) => l.top.pick.pickId),
    ["p1", "p3", "p2"]
  );
  check("buildPoolPrimary: opposing pick skipped as conflict", primary.skipped.map((s) => s.pickId), ["p4"]);
  check("buildPoolPrimary: shortfall reported, never silently built smaller", primary.shortfall, 1);
  check("buildPoolPrimary: leg carries its own gameId for the swap engine", primary.parlayA.legs[0]?.gameId, "g1");
}

// ============================================================================
// Leg count is bounded only by how many conflict-free picks the pool has -
// building with more than Auto-Generate's 10-leg cap works.
// ============================================================================
{
  const picks: GeneratorPick[] = [];
  const recordEntries: [GeneratorPick, number, number][] = [];
  for (let i = 0; i < 12; i++) {
    const g: GameTeams = { gameId: `game${i}`, homeTeam: `Home${i}`, awayTeam: `Away${i}` };
    const p = mk(g, `pick${i}`, `cap${i}`, "MONEYLINE", `Home${i} ML`, -120);
    picks.push(p);
    recordEntries.push([p, 10, 5]);
  }
  const records = leagueRecords(recordEntries);
  const primary = buildPoolPrimary(picks, records, 12);
  check("buildPoolPrimary: 12 legs built from 12 non-conflicting picks", primary.parlayA.legs.length, 12);
  check("buildPoolPrimary: no shortfall past 10 legs", primary.shortfall, 0);
}

// ============================================================================
// The pool itself is never mutated by ranking/selection.
// ============================================================================
{
  const p1 = mk(G1, "p1", "capA", "MONEYLINE", "Yankees ML", -150);
  const p2 = mk(G2, "p2", "capB", "MONEYLINE", "Mets ML", -130);
  const pool = [p1, p2];
  const before = JSON.stringify(pool);
  const records = leagueRecords([
    [p1, 21, 9],
    [p2, 13, 8],
  ]);
  buildPoolPrimary(pool, records, 2);
  check("buildPoolPrimary: pool array/picks unchanged after building", JSON.stringify(pool), before);
}

// ============================================================================
// excludeSelectedPicks: a sibling primary leg from the same game must never
// resurface as a "swap" suggestion for a DIFFERENT leg in that game - only
// Auto-Generate's parlayA (one leg per game) was safe from this by
// construction; the pool-driven primary is not.
// ============================================================================
{
  const p1 = mk(G1, "p1", "capA", "MONEYLINE", "Yankees ML", -150); // primary leg 1
  const p2 = mk(G1, "p2", "capB", "TOTAL", "Over 8.5", -110, 8.5); // primary leg 2, same game as p1
  const support = mk(G1, "support", "capF", "MONEYLINE", "Yankees ML", -150); // NOT in the pool - agrees with p1, needed so the Contrarian headcount isn't a 1-1 tie
  const alt = mk(G1, "alt", "capE", "MONEYLINE", "Red Sox ML", 130); // genuine external alternate

  const records = leagueRecords([
    [p1, 21, 9],
    [p2, 12, 8],
  ]);
  const primary = buildPoolPrimary([p1, p2], records, 2);
  check("setup: both G1 picks became primary legs", primary.parlayA.legs.map((l) => l.top.pick.pickId), ["p1", "p2"]);

  const catalog = [game(G1, [p1, p2, support, alt])];
  const filtered = excludeSelectedPicks(catalog, primary.parlayA);
  check(
    "excludeSelectedPicks: sibling primary legs stripped, only non-selected picks remain",
    filtered[0]?.picks.map((p) => p.pickId),
    ["support", "alt"]
  );

  const cr = categoryRecords([["capE", "DOG_ML", 7, 5]]); // 58.3% - qualifies as Contrarian for p1
  const contrarian = buildSwapParlay(primary.parlayA, filtered, "CONTRARIAN", cr);
  const p1Swap = contrarian.legs.find((l) => l.original.pick.pickId === "p1");
  check("contrarian swap for p1 uses the external alternate, not sibling leg p2", p1Swap?.swap?.pick.pickId, "alt");
}

// ============================================================================
// A primary leg whose game isn't in the fetched catalog (already started, or
// outside the slate window) keeps its original pick - buildSwapParlay's own
// existing "missing gameId -> no alternates" behavior, exercised here
// through a pool-built primary instead of Auto-Generate's.
// ============================================================================
{
  const p1 = mk(G1, "p1", "capA", "MONEYLINE", "Yankees ML", -150);
  const records = leagueRecords([[p1, 21, 9]]);
  const primary = buildPoolPrimary([p1], records, 1);

  const hedge = buildSwapParlay(primary.parlayA, [], "AUTO_HEDGE", {});
  check("started/missing-game leg stays unchanged", hedge.legs[0]?.swap, null);
  check("started/missing-game leg's original pick is untouched", hedge.legs[0]?.original.pick.pickId, "p1");
  check("started/missing-game leg reason is NO_ALTERNATE", hedge.legs[0]?.unchangedReason, "NO_ALTERNATE");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
