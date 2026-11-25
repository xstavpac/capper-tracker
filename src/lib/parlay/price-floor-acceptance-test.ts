// Proof for the leg price floor (price-floor.ts): a generated pick priced shorter than -250 is
// never a leg, never a Hedge / Contrarian alternate and never in any Swap tab (below-gate group
// included); exactly -250 is allowed; a slip pick is never capped; a pick with no real price
// isn't capped; the edge model (scoreModel EDGE) is untouched.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/lib/parlay/price-floor-acceptance-test.ts
import { belowPriceFloor, GENERATED_LEG_PRICE_FLOOR } from "@/lib/parlay/price-floor";
import { buildGeneratedParlay, legSwapOptions, SWAP_TAB_KEYS, type GeneratorSettings, type GeneratorSnapshot, type LegSwapOptions } from "@/lib/parlay/generator";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T12:00:00.000Z");
const LATER = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string][] = [
  ["Boston Celtics", "New York Knicks"],
  ["Denver Nuggets", "Utah Jazz"],
  ["Miami Heat", "Orlando Magic"],
];
const col = (w: number, l: number) => ({ wins: w, losses: l, pushes: 0, winPct: (w / (w + l)) * 100, count: w + l });
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };

type Kind = "HOME_ML" | "AWAY_ML" | "OVER" | "UNDER";
function mk(id: string, g: number, kind: Kind, wins: number, losses: number, odds: number, oddsSource: GeneratorPick["oddsSource"] = "MARKET"): GeneratorPick {
  const [home, away] = TEAMS[g];
  const category = kind === "HOME_ML" ? "FAV_ML" : kind === "AWAY_ML" ? "DOG_ML" : kind;
  leagueRecords.records[`cap-${id}|NBA|${category}`] = { category, label: category, overall: col(wins, losses), league: col(wins, losses) };
  const detail = kind === "HOME_ML" ? home + " ML" : kind === "AWAY_ML" ? away + " ML" : kind === "OVER" ? "Over 220.5" : "Under 220.5";
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "NBA",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, rawBetDetail: detail, odds, oddsSource, units: 1, status: "PENDING",
    betType: kind === "OVER" || kind === "UNDER" ? "TOTAL" : "MONEYLINE", period: "FULL_GAME", line: kind === "OVER" || kind === "UNDER" ? 220.5 : null,
    homeTeam: home, awayTeam: away, gameTime: LATER, teamGroup: kind === "AWAY_ML" ? "AWAY" : "HOME", teamLabel: "", teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z", propMarket: null,
  } as GeneratorPick;
}

// G0: the strongest record on the slate is a -300 favorite; a -250 ML on the other side; a strong
// Over at -110 (the leg the floor leaves); a below-gate Under at -400 (capped: never even below the gate).
// G1: a -251 ML (capped) and a DEFAULTED -300 ML (no real price: not capped). G2: a -110 Over.
const PICKS: GeneratorPick[] = [
  mk("g0-fav300", 0, "HOME_ML", 40, 5, -300),
  mk("g0-dog250", 0, "AWAY_ML", 30, 10, -250),
  mk("g0-over", 0, "OVER", 30, 12, -110),
  mk("g0-under400", 0, "UNDER", 10, 30, -400),
  mk("g1-fav251", 1, "HOME_ML", 40, 5, -251),
  mk("g1-defaulted300", 1, "AWAY_ML", 35, 8, -300, "DEFAULTED"),
  mk("g2-over", 2, "OVER", 28, 14, -110),
];
const byId = new Map(PICKS.map((p) => [p.pickId, p]));
function snap(slip: string[] = []): GeneratorSnapshot {
  return {
    builtAt: NOW.toISOString(),
    games: TEAMS.map(([home, away], g) => ({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: LATER, leagueName: "NBA", picks: PICKS.filter((p) => p.gameId === "G" + g) })),
    slipPicks: slip.map((id) => byId.get(id)!),
    targets: [],
    leagueRecords,
    categoryRecords: {},
    propMarketRecords: {},
  };
}
const base: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "COMBINED", manualSlots: 25, minWinPct: 55 };
const ids = (ls: { pick: { pickId: string } }[]) => ls.map((l) => l.pick.pickId);
const everyRow = (o: LegSwapOptions) => SWAP_TAB_KEYS.flatMap((t) => ids(o[t]));
const CAPPED = ["g0-fav300", "g0-under400", "g1-fav251"];

// ---- The rule itself ----------------------------------------------------------------
check("the floor is one constant, -250", GENERATED_LEG_PRICE_FLOOR, -250);
check("-251 / -300 / -500 are below it; -250, -249, +150 aren't", [-251, -300, -500, -250, -249, 150].map((odds) => belowPriceFloor({ betType: "MONEYLINE", odds, oddsSource: "MARKET" })), [true, true, true, false, false, false]);
check("no real price is never capped (DEFAULTED, unusable odds)", [belowPriceFloor({ betType: "MONEYLINE", odds: -300, oddsSource: "DEFAULTED" }), belowPriceFloor({ betType: "MONEYLINE", odds: 0, oddsSource: null })], [false, false]);

// ---- A build ---------------------------------------------------------------------------
const p = buildGeneratedParlay(snap(), base, null, NOW);
check("a -300 generated pick is never a leg (G0's leg is the -250 dog: exactly -250 is allowed; G1's the unpriced -300)", ids(p.legs).sort(), ["g0-dog250", "g1-defaulted300", "g2-over"]);
check("no capped pick is a Hedge or Contrarian alternate", [...Object.values(p.hedge), ...Object.values(p.contrarian)].flatMap((s) => s.legs.flatMap((l) => (l.swap ? [l.swap.pick.pickId] : []))).filter((id) => CAPPED.includes(id)), []);
check("an unpriced (DEFAULTED) -300 pick isn't capped: it is a leg", ids(p.legs).includes("g1-defaulted300"), true);

// ---- Every Swap tab, every leg ----------------------------------------------------------
const all = p.legs.map((_, i) => legSwapOptions(snap(), base, p.legs, i, NOW));
check("a -300 / -251 / -400 pick is in no Swap tab, on any leg (Primary, Hedge, Contrarian, Other games, below gate)", all.flatMap(everyRow).filter((id) => CAPPED.includes(id)), []);
const g0 = all[p.legs.findIndex((l) => l.gameId === "G0")];
check("exactly -250 is allowed: the G0 dog ML is a swap option", everyRow(g0).includes("g0-dog250"), true);
check("the -400 below-gate Under isn't even in Below your gate", SWAP_TAB_KEYS.flatMap((t) => g0[t]).some((r) => r.pick.pickId === "g0-under400"), false);
{
  const g1 = all[p.legs.findIndex((l) => l.gameId === "G0")];
  check("Other games never offers the -251 G1 ML", ids(g1.OTHER_GAMES).includes("g1-fav251"), false);
}

// ---- Your own picks are never capped ----------------------------------------------------
const ps = buildGeneratedParlay(snap(["g0-fav300"]), base, null, NOW);
check("a -300 slip pick is kept as a leg", ps.legs.some((l) => l.pick.pickId === "g0-fav300" && l.source === "SLIP"), true);
{
  // An unused slip pick at -300 is still offered in the tray (ungated, uncapped, no below-gate mark).
  const pu = buildGeneratedParlay(snap(["g1-fav251"]), { ...base, legCount: 1 }, null, NOW);
  const opts = pu.legs.map((_, i) => legSwapOptions(snap(["g1-fav251"]), { ...base, legCount: 1 }, pu.legs, i, NOW));
  const row = opts.flatMap((o) => SWAP_TAB_KEYS.flatMap((t) => o[t])).find((r) => r.pick.pickId === "g1-fav251");
  check("a -251 slip pick is a leg or a tray row, never marked below gate", ps.legs.length > 0 && (pu.legs.some((l) => l.pick.pickId === "g1-fav251") || (row !== undefined && row.belowGate === undefined)), true);
}

// ---- The edge model is left as it was ----------------------------------------------------
{
  const edge: GeneratorSettings = { ...base, scoreModel: "EDGE", minWinPct: 0 };
  const pe = buildGeneratedParlay(snap(), edge, null, NOW);
  const rows = pe.legs.flatMap((_, i) => everyRow(legSwapOptions(snap(), edge, pe.legs, i, NOW)));
  check("scoreModel EDGE applies no floor (the -300 favorite is a leg or a swap option)", ids(pe.legs).includes("g0-fav300") || rows.includes("g0-fav300"), true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
