// The Parlay Generator engine (generator.ts) with the Include Picks categories,
// the per-category Pick Mix and Max legs per game across categories and
// periods, on a synthetic MLB slate whose games carry every market: full-game
// and F5 moneylines, run lines, game and F5 totals, team totals, NRFI and
// player props. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-categories-acceptance-test.ts
import { buildGeneratedParlay, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { betCategory } from "@/lib/parlay/bet-category";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { PropMarketRecord } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays", "Rays"],
  ["Houston Astros", "Baltimore Orioles", "Astros", "Orioles"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians", "Tigers"],
  ["Seattle Mariners", "Texas Rangers", "Mariners", "Rangers"],
  ["Los Angeles Dodgers", "San Francisco Giants", "Dodgers", "Giants"],
];

type Market = "ML" | "F5_ML" | "RL" | "TOTAL" | "F5_TOTAL" | "TEAM_TOTAL" | "NRFI" | "PROP";
type Spec = { id: string; game: number; market: Market; wl: [number, number] };

function pickOf(s: Spec): GeneratorPick {
  const [home, away, nick, awayNick] = TEAMS[s.game];
  const shapes: Record<Market, [string, string, string, number | null, PickCategoryKey, string | null]> = {
    ML: ["MONEYLINE", "FULL_GAME", `${nick} ML`, null, "FAV_ML", null],
    F5_ML: ["MONEYLINE", "FIRST_HALF", `${nick} First Five Moneyline`, null, "F5_ML", null],
    RL: ["SPREAD", "FULL_GAME", `${nick} -1.5`, -1.5, "SPREAD_MINUS", null],
    TOTAL: ["TOTAL", "FULL_GAME", `${awayNick} ${nick} Over 8.5`, 8.5, "OVER", null],
    F5_TOTAL: ["TOTAL", "FIRST_HALF", `${awayNick} ${nick} First Five Over 4.5`, 4.5, "F5_OVER", null],
    TEAM_TOTAL: ["TEAM_TOTAL", "FULL_GAME", `${nick} team total over 4.5`, 4.5, "TEAM_TOTAL", null],
    NRFI: ["NRFI", "FULL_GAME", `${awayNick} ${nick} No Run First Inning`, null, "NRFI", null],
    PROP: ["PLAYER_PROP", "FULL_GAME", `Hitter ${"ABCDEF"[s.game]}${s.id} Over 1.5 Hits`, 1.5, "TD_PROP", "HITS"],
  };
  const [betType, period, detail, line, category, propMarket] = shapes[s.market];
  return {
    pickId: s.id,
    capperId: "cap-" + s.id,
    capperName: "Capper " + s.id,
    capperColorTag: null,
    capperIsFavorite: false,
    category,
    leagueName: "MLB",
    gameId: "G" + s.game,
    gameLabel: away + " @ " + home,
    betDetail: detail,
    odds: -110,
    units: 1,
    status: "PENDING",
    betType,
    period,
    rawBetDetail: detail,
    propMarket,
    line,
    homeTeam: home,
    awayTeam: away,
    gameTime: START,
    teamGroup: "HOME",
    teamLabel: "",
    teamColor: null,
    datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}

function snapOf(specs: Spec[], slip: string[] = []): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  // A HITS prop is gated on its per-market record (recordForGate) - the same W-L.
  const propMarketRecords: Record<string, PropMarketRecord | null> = {};
  const byGame = new Map<number, GeneratorPick[]>();
  const picks = new Map<string, GeneratorPick>();
  for (const s of specs) {
    const p = pickOf(s);
    const [wins, losses] = s.wl;
    categoryRecords[p.capperId + "|" + p.category] = { key: p.category!, label: p.category!, wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
    if (s.market === "PROP") {
      const c = { wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
      propMarketRecords[p.capperId + "|MLB|BASEBALL:HITS"] = { key: "BASEBALL:HITS", league: { wins: 0, losses: 0, pushes: 0, winPct: 0, count: 0 }, allTime: c };
    }
    picks.set(s.id, p);
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), p]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, ps]) => ({ gameId: "G" + n, gameLabel: TEAMS[n][1] + " @ " + TEAMS[n][0], gameTime: START, leagueName: "MLB", picks: ps }));
  return { builtAt: NOW.toISOString(), games, slipPicks: slip.map((id) => picks.get(id)!), targets: [], leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords, propMarketRecords };
}

const BASE: GeneratorSettings = { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const run = (s: GeneratorSnapshot, over: Partial<GeneratorSettings> = {}) => buildGeneratedParlay(s, { ...BASE, ...over }, null, NOW);
const cats = (p: GeneratedParlay) => Array.from(new Set(p.legs.map((l) => betCategory(l.pick)))).sort();
const perGameMax = (p: GeneratedParlay) => Math.max(0, ...Array.from(p.legs.reduce((m, l) => m.set(l.gameId, (m.get(l.gameId) ?? 0) + 1), new Map<string, number>()).values()));
const shape = (p: GeneratedParlay) => p.legs.map((l) => `${l.pick.betType}/${l.pick.period}`).sort();

// Six games, every market on each; strengths vary so each game's best leg differs.
const MARKETS: Market[] = ["ML", "F5_ML", "RL", "TOTAL", "F5_TOTAL", "TEAM_TOTAL", "NRFI", "PROP"];
const FULL: Spec[] = TEAMS.flatMap((_, g) => MARKETS.map((m, i) => ({ id: `g${g}${m}`, game: g, market: m, wl: [56 + ((g * 3 + i * 5) % 17), 40] as [number, number] })));
const full = snapOf(FULL);

// ---- Categories ---------------------------------------------------------------------
{
  const totals = run(full, { include: ["TOTALS"], legCount: 6, maxLegsPerGame: 5 });
  check("Totals only: every leg is Totals", cats(totals), ["TOTALS"]);
  check("Totals only: full parlay", totals.legs.length, 6);
  const totalsAll = run(full, { include: ["TOTALS"], legCount: 20, maxLegsPerGame: 5 });
  const kinds = new Set(totalsAll.legs.map((l) => `${l.pick.betType}/${l.pick.period}`));
  check("Totals only: F5 totals, team totals and NRFI all come through", ["TOTAL/FIRST_HALF", "TEAM_TOTAL/FULL_GAME", "NRFI/FULL_GAME", "TOTAL/FULL_GAME"].every((k) => kinds.has(k)), true);

  const ml = run(full, { include: ["MONEYLINE"], legCount: 12, maxLegsPerGame: 5 });
  check("Moneyline only: no spreads, totals or props", cats(ml), ["MONEYLINE"]);
  check("Moneyline only: F5 moneylines are Moneyline", ml.legs.some((l) => l.pick.period === "FIRST_HALF"), true);

  const mlProps = run(full, { include: ["MONEYLINE", "PROPS"], legCount: 12, maxLegsPerGame: 2 });
  check("Moneyline + Props: both, and nothing else", cats(mlProps), ["MONEYLINE", "PROPS"]);

  const four = run(full, { include: ["MONEYLINE", "SPREAD", "TOTALS", "PROPS"], legCount: 12, maxLegsPerGame: 3 });
  const all = run(full, { include: "ALL", legCount: 12, maxLegsPerGame: 3 });
  check("all four categories = All Picks (same legs, same capacity)", [four.legs.map((l) => l.pick.pickId), four.capacity], [all.legs.map((l) => l.pick.pickId), all.capacity]);

  const withUnknown = snapOf([...FULL.slice(0, 1), { id: "x", game: 0, market: "ML", wl: [90, 10] }]);
  withUnknown.games[0].picks[1] = { ...withUnknown.games[0].picks[1], betType: "WINNING_MARGIN" };
  check("an unclassified pick: kept by All", run(withUnknown, { legCount: 1 }).legs[0].pick.pickId, "x");
  check("...never by a category", run(withUnknown, { include: ["MONEYLINE"], legCount: 1 }).legs[0].pick.pickId, "g0ML");
}

// ---- Max legs per game, across categories and periods -------------------------------
{
  const one = snapOf([
    { id: "ml", game: 0, market: "ML", wl: [80, 20] },
    { id: "ou", game: 0, market: "TOTAL", wl: [78, 22] },
  ]);
  const r = run(one, { include: ["MONEYLINE", "TOTALS"], legCount: 2, maxLegsPerGame: 1 });
  check("Max 1, ML + Totals, both qualify on one game: one leg only", r.legs.map((l) => l.pick.pickId), ["ml"]);
  check("...and with 2 they pair (ML + O/U is not a conflict)", run(one, { include: ["MONEYLINE", "TOTALS"], legCount: 2, maxLegsPerGame: 2 }).legs.map((l) => l.pick.pickId).sort(), ["ml", "ou"]);

  const nested = snapOf([
    { id: "ml", game: 0, market: "ML", wl: [80, 20] },
    { id: "f5t", game: 0, market: "F5_TOTAL", wl: [79, 21] },
    { id: "tt", game: 0, market: "TEAM_TOTAL", wl: [78, 22] },
    { id: "f5ml", game: 1, market: "F5_ML", wl: [77, 23] },
    { id: "tt1", game: 1, market: "TEAM_TOTAL", wl: [76, 24] },
    { id: "pr1", game: 1, market: "PROP", wl: [75, 25] },
  ]);
  const two = run(nested, { legCount: 6, maxLegsPerGame: 2 });
  check("Max 2: never more than 2 legs on a game", perGameMax(two), 2);
  check("Max 2: ML + F5 total on one game, team total + F5 ML on the other (1H / F5 legs count)", two.legs.map((l) => l.pick.pickId).sort(), ["f5ml", "f5t", "ml", "tt1"]);
  check("Max 2: same-game legs flagged as SGP", two.legs.every((l) => l.sameGame), true);
  check("Max 2: the parlay says it is short", two.legs.length < 6 && two.shortfall.length > 0, true);

  const slip = snapOf([...FULL.filter((s) => s.game === 0)], ["g0ML", "g0TOTAL", "g0PROP"]);
  const s1 = run(slip, { legCount: 4, maxLegsPerGame: 1 });
  check("a slip over Max legs: the best pick on the game stays, no generated leg on that game", [s1.fromSlip, s1.generated], [1, 0]);
  const left = s1.dropped.filter((d) => d.reason === "left_out");
  check("...the other two are named as left out, with why and who stayed", [left.length, left.every((d) => d.note.includes("max legs per game is 1") && d.against?.pickId === s1.legs[0].pick.pickId)], [2, true]);
  check("...left out + kept = the three the slip holds", [...left.map((d) => d.pickId), s1.legs[0].pick.pickId].sort(), ["g0ML", "g0PROP", "g0TOTAL"]);
  const s2 = run(slip, { legCount: 4, maxLegsPerGame: 2 });
  check("Max 2 on three slip picks of one game: two stay, one left out", [s2.fromSlip, s2.dropped.filter((d) => d.reason === "left_out").length], [2, 1]);
  check("the kept picks are the best two by the slip ranking (the left-out one is the one that stayed out at Max 1's order)", s2.legs.map((l) => l.pick.pickId).includes(s1.legs[0].pick.pickId), true);
  const s3 = run(slip, { legCount: 4, maxLegsPerGame: 3 });
  check("Max 3: all three stay, nothing left out", [s3.fromSlip, s3.dropped.length], [3, 0]);
  const leftOutGames = new Set(s1.legs.map((l) => l.gameId));
  check("a game with picks left out is full: no generated leg on it, so Hedge and Contrarian have nothing to swap there",
    [s1.legs.filter((l) => leftOutGames.has(l.gameId) && l.source === "GENERATED").length, [...s1.hedge.SUGGESTED.legs, ...s1.contrarian.SUGGESTED.legs].filter((l) => leftOutGames.has(l.original.gameId) && l.swap !== null).length], [0, 0]);
}

// ---- Pick Mix -------------------------------------------------------------------------
{
  check("no mix and an all-0 mix build the same parlay", shape(run(full, { mix: { MONEYLINE: 0, SPREAD: 0, TOTALS: 0, PROPS: 0 } })), shape(run(full)));
  check("no mix: no mix notes", run(full).mixNotes, []);

  const m = run(full, { legCount: 6, maxLegsPerGame: 2, mix: { MONEYLINE: 50, SPREAD: 0, TOTALS: 50, PROPS: 0 } });
  const counts = m.legs.reduce((o, l) => ((o[betCategory(l.pick)] = (o[betCategory(l.pick)] ?? 0) + 1), o), {} as Record<string, number>);
  check("mix ML 50 / Totals 50 of 6: 3 + 3", [counts.MONEYLINE, counts.TOTALS, Object.keys(counts).length], [3, 3, 2]);

  const fewProps = snapOf([
    ...TEAMS.slice(0, 5).map((_, g) => ({ id: `ml${g}`, game: g, market: "ML" as const, wl: [70 - g, 30] as [number, number] })),
    { id: "p0", game: 5, market: "PROP", wl: [60, 40] },
  ]);
  const short = run(fewProps, { legCount: 4, include: ["MONEYLINE", "PROPS"], mix: { MONEYLINE: 50, PROPS: 50 } });
  check("Props 50% with one qualifying prop: the full 4 legs anyway", short.legs.length, 4);
  check("...the shortfall is filled from Moneyline", short.legs.map((l) => l.pick.pickId).sort(), ["ml0", "ml1", "ml2", "p0"]);
  check("...and it says so", short.mixNotes, ["Only 1 Props leg qualified (mix asked for 2)."]);

  const oneGame = snapOf([
    { id: "ml", game: 0, market: "ML", wl: [80, 20] },
    { id: "pr", game: 0, market: "PROP", wl: [79, 21] },
  ]);
  const capped = run(oneGame, { legCount: 2, maxLegsPerGame: 1, include: ["MONEYLINE", "PROPS"], mix: { MONEYLINE: 50, PROPS: 50 } });
  check("mix vs Max legs 1: Max legs wins (one leg from the one game)", capped.legs.length, 1);

  const over = run(full, { legCount: 7, maxLegsPerGame: 2, include: ["MONEYLINE", "PROPS"], mix: { MONEYLINE: 80, PROPS: 60 } });
  check("shares over 100% are scaled, not refused: 80/60 of 7 -> 4 ML + 3 Props", [over.legs.filter((l) => betCategory(l.pick) === "MONEYLINE").length, over.legs.filter((l) => betCategory(l.pick) === "PROPS").length], [4, 3]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
