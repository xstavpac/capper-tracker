// Proof for Auto-Generate's "Include Picks" filter and Pick Mix: pick-kind.ts
// (classifyPickKind), pick-mix.ts (the split arithmetic) and the parts of
// auto-generate.ts that use them (filterGamesByInclude, buildAutoParlay with a
// mix, buildSameGameLegs' short-pool preference, buildMixNotes,
// filterEmptyNote, swapVariantNote). Pure - no DB. Run with:
//   npx tsx src/lib/parlay/pick-mix-acceptance-test.ts
import { BetType } from "@prisma/client";
import {
  SWAP_GAME_LINES_ONLY_NOTE,
  buildAutoParlay,
  buildMixNotes,
  buildSameGameLegs,
  buildSwapParlay,
  filterEmptyNote,
  filterGamesByInclude,
  swapVariantNote,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
} from "@/lib/parlay/auto-generate";
import { PICK_KIND_BY_BET_TYPE, classifyPickKind } from "@/lib/parlay/pick-kind";
import { keepsPick, mixSplit, mixSplitText, toGameLinesPct, toIncludePicks } from "@/lib/parlay/pick-mix";
import { FROZEN_GAMES, FROZEN_LEAGUE_RECORDS, FROZEN_LEG_COUNTS } from "@/lib/parlay/auto-generate-frozen-fixture";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ============================================================================
// classifyPickKind - every bucket, the borderline cases, and the fallback
// ============================================================================
{
  const kind = (betType: string, period = "FULL_GAME", propMarket: string | null = null) => classifyPickKind({ betType, propMarket, ...{ period } });
  check("every BetType is mapped (a new one fails the build in pick-kind.ts)", Object.keys(PICK_KIND_BY_BET_TYPE).sort(), Object.values(BetType).sort());
  check("SPREAD -> GAME_LINE", kind("SPREAD"), "GAME_LINE");
  check("MONEYLINE -> GAME_LINE", kind("MONEYLINE"), "GAME_LINE");
  check("TOTAL -> GAME_LINE", kind("TOTAL"), "GAME_LINE");
  check("borderline: 1H / F5 total -> GAME_LINE", kind("TOTAL", "FIRST_HALF"), "GAME_LINE");
  check("borderline: Q1 spread -> GAME_LINE", kind("SPREAD", "FIRST_QUARTER"), "GAME_LINE");
  check("borderline: hockey P1 moneyline -> GAME_LINE", kind("MONEYLINE", "FIRST_PERIOD"), "GAME_LINE");
  check("borderline: regulation 3-way -> GAME_LINE", kind("MONEYLINE", "REGULATION"), "GAME_LINE");
  check("borderline: alternate line (a SPREAD row with an odd line) -> GAME_LINE", classifyPickKind({ betType: "SPREAD" }), "GAME_LINE");
  check("borderline: TEAM_TOTAL -> GAME_LINE", kind("TEAM_TOTAL"), "GAME_LINE");
  check("borderline: NRFI / YRFI (one BetType) -> GAME_LINE", kind("NRFI"), "GAME_LINE");
  check("PLAYER_PROP yardage -> PROP", kind("PLAYER_PROP", "FULL_GAME", "PASS_YDS"), "PROP");
  check("borderline: anytime TD -> PROP", kind("PLAYER_PROP", "FULL_GAME", "TD"), "PROP");
  check("borderline: NBA double-double -> PROP", kind("PLAYER_PROP", "FULL_GAME", "DOUBLE_DOUBLE"), "PROP");
  check("NHL first goal -> PROP", kind("PLAYER_PROP", "FULL_GAME", "FIRST_GOAL"), "PROP");
  check("MLB strikeouts -> PROP", kind("PLAYER_PROP", "FULL_GAME", "STRIKEOUTS"), "PROP");
  check("PLAYER_PROP with an unreadable market (no propMarket) -> still PROP", kind("PLAYER_PROP"), "PROP");
  check("unmapped bet type with a player attached -> PROP", classifyPickKind({ betType: "PLAYER_MILESTONE", propMarket: "HITS" }), "PROP");
  check("unmapped bet type with no player -> GAME_LINE", classifyPickKind({ betType: "WINNING_MARGIN" }), "GAME_LINE");
  check("unmapped bet type with propMarket null -> GAME_LINE", classifyPickKind({ betType: "WINNING_MARGIN", propMarket: null }), "GAME_LINE");
  check("an unmapped prop-shaped market is kept by Props", keepsPick("PROPS", { betType: "PLAYER_MILESTONE", propMarket: "HITS" }), true);
  check("an unmapped prop-shaped market is kept by All", keepsPick("ALL", { betType: "PLAYER_MILESTONE", propMarket: "HITS" }), true);
  check("an unmapped prop-shaped market is dropped by Game Lines", keepsPick("GAME_LINES", { betType: "PLAYER_MILESTONE", propMarket: "HITS" }), false);
}

// ============================================================================
// Split arithmetic and input checks
// ============================================================================
{
  check("60/40 at 5 legs: 3 GL / 2 P", mixSplit(5, 60), { gameLines: 3, props: 2 });
  check("60/40 at 7 legs: round(4.2) = 4 GL / 3 P", mixSplit(7, 60), { gameLines: 4, props: 3 });
  check("60/40 at 20 legs: 12 GL / 8 P", mixSplit(20, 60), { gameLines: 12, props: 8 });
  check("50/50 at 5 legs: round(2.5) = 3 GL / 2 P", mixSplit(5, 50), { gameLines: 3, props: 2 });
  check("50/50 at 7 legs: round(3.5) = 4 GL / 3 P", mixSplit(7, 50), { gameLines: 4, props: 3 });
  check("30/70 at 7 legs: exactly 2.1 -> 2 GL / 5 P (no float drift)", mixSplit(7, 30), { gameLines: 2, props: 5 });
  check("80/20 at 3 legs: round(2.4) = 2 GL / 1 P", mixSplit(3, 80), { gameLines: 2, props: 1 });
  check("100/0 at 5 legs", mixSplit(5, 100), { gameLines: 5, props: 0 });
  check("0/100 at 5 legs", mixSplit(5, 0), { gameLines: 0, props: 5 });
  check("live split text", mixSplitText(7, 60), "60 / 40 → 4 Game Lines · 3 Props");
  check("live split text, singulars", mixSplitText(2, 50), "50 / 50 → 1 Game Line · 1 Prop");
  check("toGameLinesPct: 60 kept", toGameLinesPct(60), 60);
  check("toGameLinesPct: 0 kept", toGameLinesPct(0), 0);
  check("toGameLinesPct: 55 (not a step of 10) -> null", toGameLinesPct(55), null);
  check("toGameLinesPct: 110 -> null", toGameLinesPct(110), null);
  check("toGameLinesPct: '60' (string) -> null", toGameLinesPct("60"), null);
  check("toIncludePicks: junk -> ALL", toIncludePicks("EVERYTHING"), "ALL");
  check("toIncludePicks: PROPS kept", toIncludePicks("PROPS"), "PROPS");
}

// ============================================================================
// All with no mix: exactly today's Parlay A
// ============================================================================
{
  for (const n of FROZEN_LEG_COUNTS) {
    const before = buildAutoParlay(FROZEN_GAMES, FROZEN_LEAGUE_RECORDS, n);
    const now = buildAutoParlay(filterGamesByInclude(FROZEN_GAMES, "ALL"), FROZEN_LEAGUE_RECORDS, n, null);
    check(`All, no mix, ${n} legs: identical to the no-option call`, JSON.stringify(now), JSON.stringify(before));
    check(`All, no mix, ${n} legs: no mix field on the result`, "mix" in now, false);
  }
  check("filterGamesByInclude(ALL) hands back the very same games", filterGamesByInclude(FROZEN_GAMES, "ALL") === FROZEN_GAMES, true);
}

// ============================================================================
// Fixture slate
// ============================================================================
type Teams = { gameId: string; homeTeam: string; awayTeam: string };
const T = (gameId: string, awayTeam: string, homeTeam: string): Teams => ({ gameId, homeTeam, awayTeam });
const G1 = T("g1", "Boston Red Sox", "New York Yankees");
const G2 = T("g2", "Atlanta Braves", "New York Mets");
const G3 = T("g3", "San Francisco Giants", "Los Angeles Dodgers");
const G4 = T("g4", "St. Louis Cardinals", "Chicago Cubs");
const G5 = T("g5", "Texas Rangers", "Houston Astros");
const G6 = T("g6", "San Diego Padres", "Philadelphia Phillies");
const G7 = T("g7", "Seattle Mariners", "Toronto Blue Jays");
const G8 = T("g8", "Detroit Tigers", "Cleveland Guardians");
const GAME_TIME = "2026-09-23T23:05:00.000Z";

// [wins, losses]: `league` is what Parlay A ranks by, `market` what the
// same-game fill gates on (55%) and Wilson-orders by.
type Row = { teams: Teams; id: string; betType: string; detail: string; category: PickCategoryKey; league: [number, number]; market?: [number, number]; line?: number | null; propMarket?: string; leagueName?: string };
const ROWS: Row[] = [
  { teams: G1, id: "gl1", betType: "MONEYLINE", detail: "Yankees ML", category: "FAV_ML", league: [21, 9], market: [12, 8] }, // 70%
  { teams: G1, id: "p1", betType: "PLAYER_PROP", detail: "Aaron Judge over 1.5 total bases", category: "TD_PROP", league: [16, 4], propMarket: "TOTAL_BASES" }, // 80%
  { teams: G2, id: "gl2", betType: "MONEYLINE", detail: "Mets ML", category: "FAV_ML", league: [13, 7] }, // 65%
  { teams: G2, id: "p2", betType: "PLAYER_PROP", detail: "Pete Alonso over 0.5 hits", category: "TD_PROP", league: [12, 8], market: [40, 10], propMarket: "HITS" }, // 60%
  { teams: G3, id: "gl3", betType: "MONEYLINE", detail: "Dodgers ML", category: "FAV_ML", league: [31, 19] }, // 62%
  { teams: G4, id: "p4", betType: "PLAYER_PROP", detail: "Seiya Suzuki over 1.5 total bases", category: "TD_PROP", league: [14, 10], propMarket: "TOTAL_BASES" }, // 58.3%
  { teams: G5, id: "gl5", betType: "MONEYLINE", detail: "Astros ML", category: "FAV_ML", league: [11, 9] }, // 55%
  { teams: G6, id: "p6", betType: "PLAYER_PROP", detail: "Bryce Harper over 0.5 hits", category: "TD_PROP", league: [15, 5], propMarket: "HITS" }, // 75%
];

// Distinct capper per pick, so every record key is its own.
function toPick(r: Row): GeneratorPick {
  const leagueName = r.leagueName ?? "MLB";
  return {
    pickId: r.id,
    capperId: "cap-" + r.id,
    capperName: "cap-" + r.id,
    capperColorTag: null,
    capperIsFavorite: false,
    category: r.category,
    leagueName,
    gameId: r.teams.gameId,
    gameLabel: r.teams.awayTeam + " @ " + r.teams.homeTeam,
    betDetail: r.detail,
    odds: -110,
    units: 1,
    status: "PENDING",
    betType: r.betType,
    period: "FULL_GAME",
    rawBetDetail: r.detail,
    line: r.line ?? null,
    homeTeam: r.teams.homeTeam,
    awayTeam: r.teams.awayTeam,
    gameTime: GAME_TIME,
    teamGroup: "OTHER",
    teamLabel: "",
    teamColor: null,
    datePosted: "2026-09-23T15:00:00.000Z",
    propMarket: r.propMarket ?? null,
  };
}

function slate(rows: Row[]): GeneratorGame[] {
  const out = new Map<string, GeneratorGame>();
  for (const r of rows) {
    const g = out.get(r.teams.gameId) ?? {
      gameId: r.teams.gameId,
      gameLabel: r.teams.gameId,
      gameTime: GAME_TIME,
      leagueName: r.leagueName ?? "MLB",
      picks: [],
    };
    g.picks.push(toPick(r));
    out.set(r.teams.gameId, g);
  }
  return Array.from(out.values());
}

const column = ([wins, losses]: [number, number]) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
function leagueRecords(rows: Row[]): CapperLeagueRecords {
  return {
    records: Object.fromEntries(
      rows.map((r) => [`cap-${r.id}|${r.leagueName ?? "MLB"}|${r.category}`, { category: r.category, label: "", overall: column(r.league), league: column(r.league) }])
    ),
    streaks: {},
    last20: {},
  };
}
function categoryRecords(rows: Row[]): Record<string, CategoryBreakdownItem | null> {
  return Object.fromEntries(rows.filter((r) => r.market).map((r) => [`cap-${r.id}|${r.category}`, { key: r.category, label: "", ...column(r.market!) }]));
}

const games = slate(ROWS);
const lr = leagueRecords(ROWS);
const cr = categoryRecords(ROWS);
const legIds = (p: AutoParlay) => p.legs.map((l) => l.top.pick.pickId);

// ============================================================================
// Include Picks filters
// ============================================================================
{
  check("All, 3 legs: plain ranking (each game's #1, strongest first)", legIds(buildAutoParlay(games, lr, 3)), ["p1", "p6", "gl2"]);
  const gl = buildAutoParlay(filterGamesByInclude(games, "GAME_LINES"), lr, 3);
  check("Game Lines, 3 legs: only game lines, strongest first", legIds(gl), ["gl1", "gl2", "gl3"]);
  check("Game Lines: games with a game line", gl.available, 4);
  const props = buildAutoParlay(filterGamesByInclude(games, "PROPS"), lr, 3);
  check("Props, 3 legs: only props, strongest first", legIds(props), ["p1", "p6", "p2"]);
  check("Props: games with a prop", props.available, 4);
  check(
    "Game Lines: next picks never include a prop",
    gl.legs.flatMap((l) => l.next.map((r) => classifyPickKind(r.pick))).every((k) => k === "GAME_LINE"),
    true
  );
}

// ============================================================================
// All with a mix: the mix sets how many, the ranking sets which
// ============================================================================
{
  const five = buildAutoParlay(games, lr, 5, 60);
  // Offers, strongest first: p1 80, p6 75, gl1 70, gl2 65, gl3 62, p2 60, p4 58, gl5 55.
  // p1 and p6 fill Props; gl1 is skipped because g1 already went to its stronger prop.
  check("60/40 at 5: 3 GL + 2 P, best of each pool, one per game", legIds(five), ["p1", "p6", "gl2", "gl3", "gl5"]);
  check("60/40 at 5: target recorded", five.mix, { gameLinesPct: 60, target: { gameLines: 3, props: 2 } });
  check("60/40 at 5: mix met, no notes", buildMixNotes(five), []);

  const seven = buildAutoParlay(games, lr, 7, 60);
  check("60/40 at 7 (4 GL / 3 P), only 6 games: 3 GL + 3 P", legIds(seven), ["p1", "p6", "gl2", "gl3", "p4", "gl5"]);
  check("60/40 at 7: game lines short with nothing to fill -> note", buildMixNotes(seven), ["Only 3 eligible game lines for the 4 legs of Game Lines in your mix."]);

  const twenty = buildAutoParlay(games, lr, 20, 60);
  check("60/40 at 20: target 12 / 8", twenty.mix?.target, { gameLines: 12, props: 8 });
  check("60/40 at 20: every game used once", twenty.legs.length, 6);

  const allGl = buildAutoParlay(games, lr, 3, 100);
  check("100/0 at 3: the three best game lines, in ranking order", legIds(allGl), ["gl1", "gl2", "gl3"]);
  check(
    "100/0 picks the same legs as the Game Lines filter (ranking respected within the pool)",
    legIds(allGl),
    legIds(buildAutoParlay(filterGamesByInclude(games, "GAME_LINES"), lr, 3))
  );
  const allProps = buildAutoParlay(games, lr, 3, 0);
  check("0/100 at 3: the three best props, in ranking order", legIds(allProps), ["p1", "p6", "p2"]);
}

// ============================================================================
// Shortfall: the other pool fills in, and a note says so
// ============================================================================
{
  const oneProp = ROWS.filter((r) => ["gl1", "p1", "gl2", "gl3", "gl5"].includes(r.id));
  const g = slate(oneProp);
  const r = buildAutoParlay(g, leagueRecords(oneProp), 4, 30); // 1 GL / 3 P
  check("30/70 at 4 with one prop: 1 prop + 3 game lines, never fails", legIds(r), ["p1", "gl2", "gl3", "gl5"]);
  check("shortfall note", buildMixNotes(r), ["Only 1 eligible prop — filled 2 extra legs with Game Lines."]);

  const noProps = ROWS.filter((r) => r.betType !== "PLAYER_PROP");
  const n = buildAutoParlay(slate(noProps), leagueRecords(noProps), 3, 50); // 2 GL / 1 P
  check("50/50 at 3 with no props: all game lines", legIds(n), ["gl1", "gl2", "gl3"]);
  check("no-props note", buildMixNotes(n), ["No eligible props — filled 1 extra leg with Game Lines."]);

  const p = buildAutoParlay(games, lr, 5, 0); // 0 GL / 5 P, 4 prop games
  check("0/100 at 5 with 4 prop games: the 4 props + the best unused game line", legIds(p), ["p1", "p6", "gl3", "p2", "p4"]);
  check("game-line fill note", buildMixNotes(p), ["Only 4 eligible props — filled 1 extra leg with Game Lines."]);
}

// ============================================================================
// Same-game fill with a mix: Max Legs Per Game and the conflict rules hold
// across pools, and a short pool is served first
// ============================================================================
{
  // 7 legs, 6 games: Parlay A is 3 GL + 3 P against a 4 / 3 target, one short.
  const seven = buildAutoParlay(games, lr, 7, 60);
  check("max 1: no same-game legs", buildSameGameLegs(seven, games, cr, 1).legs.length, 0);
  const fill = buildSameGameLegs(seven, games, cr, 2);
  // p2 (40-10) out-Wilsons gl1 (12-8), but game lines are the short pool.
  check("max 2: the short pool (game lines) is served before a stronger prop", fill.legs.map((l) => l.pick.pickId), ["gl1"]);
  check("max 2: mix met once the same-game leg is in", buildMixNotes(seven, fill), []);
  const plain = buildSameGameLegs(buildAutoParlay(games, lr, 7), games, cr, 2);
  check("no mix: the same slate takes the strongest candidate (unchanged behavior)", plain.legs.map((l) => l.pick.pickId)[0], "p2");

  // One game: a game-total Under, an offensive prop Over on it (R-E: blocked),
  // and a prop Under (allowed).
  const g7Rows: Row[] = [
    { teams: G7, id: "u7", betType: "TOTAL", detail: "Under 8.5", line: 8.5, category: "UNDER", league: [21, 9], market: [21, 9] },
    { teams: G7, id: "po7", betType: "PLAYER_PROP", detail: "Vladimir Guerrero over 1.5 total bases", category: "TD_PROP", league: [12, 8], market: [45, 5], propMarket: "TOTAL_BASES" },
    { teams: G7, id: "pu7", betType: "PLAYER_PROP", detail: "Julio Rodriguez under 1.5 total bases", category: "TD_PROP", league: [11, 9], market: [22, 10], propMarket: "TOTAL_BASES" },
  ];
  const g7 = slate(g7Rows);
  const a7 = buildAutoParlay(g7, leagueRecords(g7Rows), 2, 50);
  check("one game, 50/50 at 2: Parlay A takes the game's strongest offer", legIds(a7), ["u7"]);
  const f7 = buildSameGameLegs(a7, g7, categoryRecords(g7Rows), 2);
  check("conflict across pools: an Over prop beside the game Under is skipped, the Under prop is taken", f7.legs.map((l) => l.pick.pickId), ["pu7"]);

  // One game, a side and three props on three players: Max Legs Per Game caps it.
  const g8Rows: Row[] = [
    { teams: G8, id: "s8", betType: "MONEYLINE", detail: "Guardians ML", category: "FAV_ML", league: [21, 9], market: [21, 9] },
    { teams: G8, id: "pa8", betType: "PLAYER_PROP", detail: "Jose Ramirez over 0.5 hits", category: "TD_PROP", league: [12, 8], market: [30, 10], propMarket: "HITS" },
    { teams: G8, id: "pb8", betType: "PLAYER_PROP", detail: "Riley Greene over 0.5 hits", category: "TD_PROP", league: [12, 8], market: [28, 12], propMarket: "HITS" },
    { teams: G8, id: "pc8", betType: "PLAYER_PROP", detail: "Steven Kwan over 0.5 hits", category: "TD_PROP", league: [12, 8], market: [26, 14], propMarket: "HITS" },
  ];
  const g8 = slate(g8Rows);
  const a8 = buildAutoParlay(g8, leagueRecords(g8Rows), 4, 50);
  check("Max Legs Per Game 2 across pools: one prop added to the game line", buildSameGameLegs(a8, g8, categoryRecords(g8Rows), 2).legs.map((l) => l.pick.pickId), ["pa8"]);
  check("Max Legs Per Game 3 across pools: two props added, never a fourth leg", buildSameGameLegs(a8, g8, categoryRecords(g8Rows), 3).legs.map((l) => l.pick.pickId), ["pa8", "pb8"]);
  check(
    "after the same-game fill, the note counts what the mix still lacks",
    buildMixNotes(a8, buildSameGameLegs(a8, g8, categoryRecords(g8Rows), 3)),
    ["Only 1 eligible game line for the 2 legs of Game Lines in your mix."]
  );
}

// ============================================================================
// Zero eligible picks: a clear empty state, read off the picks themselves
// ============================================================================
{
  const wnba = ROWS.filter((r) => r.betType !== "PLAYER_PROP").slice(0, 1).map((r) => ({ ...r, id: "w1", leagueName: "WNBA", teams: T("w1", "Las Vegas Aces", "New York Liberty") }));
  const mixed = slate([...ROWS, ...wnba]);
  check("Props + MLB + WNBA: WNBA named", filterEmptyNote(mixed, "PROPS", ["MLB", "WNBA"]), "No props available for WNBA right now.");
  check("Props + WNBA alone: named, and Parlay A comes back empty", filterEmptyNote(mixed, "PROPS", ["WNBA"]), "No props available for WNBA right now.");
  const onlyWnba = mixed.filter((g) => g.leagueName === "WNBA");
  check("Props + WNBA alone: no games to build from", buildAutoParlay(filterGamesByInclude(onlyWnba, "PROPS"), lr, 3).available, 0);
  check("a selected league with no games at all is named too", filterEmptyNote(mixed, "PROPS", ["MLB", "WNBA", "NCAAF"]), "No props available for WNBA, NCAAF right now.");
  check("Game Lines with game lines in every league: no note", filterEmptyNote(mixed, "GAME_LINES", ["MLB", "WNBA"]), null);
  check("All: never a filter note", filterEmptyNote(onlyWnba, "ALL", ["WNBA"]), null);
}

// ============================================================================
// Hedge / Contrarian honor the filter
// ============================================================================
{
  const hedgeRows: Row[] = [
    { teams: G1, id: "h-ml", betType: "MONEYLINE", detail: "Yankees ML", category: "FAV_ML", league: [21, 9], market: [21, 9] },
    { teams: G1, id: "h-over", betType: "TOTAL", detail: "Over 8.5", line: 8.5, category: "OVER", league: [12, 8], market: [30, 10] },
    { teams: G1, id: "h-prop", betType: "PLAYER_PROP", detail: "Aaron Judge over 1.5 total bases", category: "TD_PROP", league: [40, 2], market: [80, 2], propMarket: "TOTAL_BASES" },
  ];
  const hg = slate(hedgeRows);
  const hlr = leagueRecords(hedgeRows);
  const hcr = categoryRecords(hedgeRows);

  const glGames = filterGamesByInclude(hg, "GAME_LINES");
  const glA = buildAutoParlay(glGames, hlr, 1);
  const hedge = buildSwapParlay(glA, glGames, "AUTO_HEDGE", hcr);
  check("Game Lines: Parlay A leg is the game line", legIds(glA), ["h-ml"]);
  check("Game Lines: Hedge swaps to a game line, never the (stronger) prop", hedge.legs.map((l) => l.swap?.pick.pickId ?? null), ["h-over"]);
  check("Game Lines: no swap note", swapVariantNote("GAME_LINES", glA), null);

  const propGames = filterGamesByInclude(hg, "PROPS");
  const propA = buildAutoParlay(propGames, hlr, 1);
  const propHedge = buildSwapParlay(propA, propGames, "AUTO_HEDGE", hcr);
  check("Props: Hedge never swaps in a game line", propHedge.legs.map((l) => l.swap?.pick.pickId ?? null), [null]);
  check("Props: swap note instead of 0/N", swapVariantNote("PROPS", propA), SWAP_GAME_LINES_ONLY_NOTE);

  const allA = buildAutoParlay(hg, hlr, 1);
  check("All, the only leg is a prop: swap note", [legIds(allA), swapVariantNote("ALL", allA)], [["h-prop"], SWAP_GAME_LINES_ONLY_NOTE]);
  check("All with a game-line leg: no swap note", swapVariantNote("ALL", buildAutoParlay(games, lr, 3)), null);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll pick-mix checks passed.");
