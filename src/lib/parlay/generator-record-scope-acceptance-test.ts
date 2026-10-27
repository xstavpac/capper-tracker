// Record scope (generator.ts, pick-record.ts): a generated leg, and a Hedge or
// Contrarian alternate, is gated and ranked on the better (Wilson lower bound
// at GENERATOR_Z, a tie to the league) of its capper's record in this market
// in THIS league and their all-time record in the market - no minimum volume,
// never last 20 (pick-record-best-of-two-acceptance-test.ts has the rule's own
// cases). Contrarian takes any capper on the other side who clears the gate,
// whatever the headcount. LEGACY_RULES is the engine as it was (all-leagues
// market record, headcount). Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-record-scope-acceptance-test.ts
import { buildGeneratedParlay, LEGACY_RULES, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { recordForGate } from "@/lib/parlay/pick-record";
import { recordText } from "@/components/parlay/generator-result";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

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

const col = (wins: number, losses: number, pushes = 0) => ({ wins, losses, pushes, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses + pushes });

// lg: the capper's record in this market in MLB ([w, l] or [w, l, pushes]);
// all: all leagues. noCard: only the all-leagues map has the capper.
type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER"; lg: number[] | null; all: number[] | null; noCard?: boolean };

function makeSnapshot(specs: Spec[], last20: CapperLeagueRecords["last20"] = {}): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20 };
  const byGame = new Map<number, GeneratorPick[]>();
  for (const s of specs) {
    const [home, away, homeNick, awayNick] = TEAMS[s.game];
    const detail = s.bet === "HOME" ? homeNick + " ML" : s.bet === "AWAY" ? awayNick + " ML" : "Over 8.5";
    const category: PickCategoryKey = s.bet === "HOME" ? "FAV_ML" : s.bet === "AWAY" ? "DOG_ML" : "OVER";
    const capperId = "cap-" + s.id;
    if (s.all) {
      const c = col(s.all[0], s.all[1], s.all[2]);
      categoryRecords[capperId + "|" + category] = { key: category, label: category, ...c };
      if (!s.noCard) leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: c, league: s.lg ? col(s.lg[0], s.lg[1], s.lg[2]) : col(0, 0) };
    }
    const pick = {
      pickId: s.id,
      capperId,
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
      betType: s.bet === "OVER" ? "TOTAL" : "MONEYLINE",
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: null,
      line: s.bet === "OVER" ? 8.5 : null,
      homeTeam: home,
      awayTeam: away,
      gameTime: START,
      teamGroup: s.bet === "AWAY" ? "AWAY" : "HOME",
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), pick]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, picks]) => ({ gameId: "G" + n, gameLabel: TEAMS[n][1] + " @ " + TEAMS[n][0], gameTime: START, leagueName: "MLB", picks }));
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const SETTINGS: GeneratorSettings = { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);
const swapOf = (p: GeneratedParlay["hedge"], pickId: string) => {
  const l = p.legs.find((x) => x.original.pick.pickId === pickId)!;
  return l.swap ? { to: l.swap.pick.pickId, basis: l.swap.basis ?? "MARKET", record: `${l.swap.record.wins}-${l.swap.record.losses}` } : l.unchangedReason;
};

// ============================================================================
// recordForGate
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "lg", game: 0, bet: "HOME", lg: [4, 1], all: [4, 6] },
    { id: "one", game: 0, bet: "AWAY", lg: [1, 0], all: [1, 4] },
    { id: "pushes", game: 1, bet: "HOME", lg: [0, 0, 3], all: [6, 4, 3] },
    { id: "nolg", game: 1, bet: "AWAY", lg: null, all: [6, 4] },
    { id: "nocard", game: 2, bet: "HOME", lg: null, all: [7, 3], noCard: true },
    { id: "none", game: 2, bet: "AWAY", lg: null, all: null },
  ]);
  const pick = (id: string) => snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!;
  const rec = (id: string) => {
    const r = recordForGate(pick(id), snap.leagueRecords, snap.categoryRecords);
    return r && `${r.source} ${r.wins}-${r.losses}`;
  };
  check("in-league 4-1 beats all-time 4-6", rec("lg"), "LEAGUE 4-1");
  check("no minimum volume: in-league 1-0 beats all-time 1-4", rec("one"), "LEAGUE 1-0");
  check("pushes only in the league: falls back to all time", rec("pushes"), "OVERALL 6-4");
  check("no picks in the league: all time", rec("nolg"), "OVERALL 6-4");
  check("no card at all: all time from the all-leagues map", rec("nocard"), "OVERALL 7-3");
  check("no record anywhere: none", rec("none"), null);
  check("no category: none", recordForGate({ ...pick("lg"), category: null }, snap.leagueRecords, snap.categoryRecords), null);
}

// ============================================================================
// Gate and rank on the better of the two records
// ============================================================================
{
  // G0: "lgGood" is 4-1 in MLB but 40% all time; "lgBad" is 1-3 in MLB but 55% all
  //     time - its all-time record is the better one, so it qualifies on that, and
  //     4-1 still outranks it.
  // G1: "rank" ranks above "rank2" in MLB (9-1 vs 6-4) but below it all time (50% vs 60%):
  //     9-1 in MLB is rank's better record, 60-40 all time is rank2's, and 9-1 wins.
  // G2: no MLB picks yet - the all-time record decides.
  // G3: Last 20 is never a gate: no market record, a strong last 20.
  const snap = makeSnapshot(
    [
      { id: "lgGood", game: 0, bet: "HOME", lg: [4, 1], all: [4, 6] },
      { id: "lgBad", game: 0, bet: "OVER", lg: [1, 3], all: [11, 9] },
      { id: "rank", game: 1, bet: "HOME", lg: [9, 1], all: [50, 50] },
      { id: "rank2", game: 1, bet: "OVER", lg: [6, 4], all: [60, 40] },
      { id: "fallback", game: 2, bet: "HOME", lg: null, all: [6, 4] },
      { id: "last20", game: 3, bet: "HOME", lg: null, all: null },
    ],
    { "cap-last20": col(18, 2) }
  );
  const now = buildGeneratedParlay(snap, SETTINGS, null, NOW);
  const old = buildGeneratedParlay(snap, SETTINGS, null, NOW, LEGACY_RULES);
  const gated = (id: string) => {
    const r = recordForGate(snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!, snap.leagueRecords, snap.categoryRecords);
    return r && `${r.source} ${r.wins}-${r.losses}`;
  };
  check("in-league 1-3 no longer hides all-time 11-9", [gated("lgGood"), gated("lgBad")], ["LEAGUE 4-1", "OVERALL 11-9"]);
  check("4-1 in MLB (40% all time) qualifies and outranks 11-9 all time on its game", ids(now).includes("lgGood") && !ids(now).includes("lgBad"), true);
  check("legacy: the opposite", ids(old).includes("lgBad") && !ids(old).includes("lgGood"), true);
  check("each on its better record: 9-1 in MLB beats 60-40 all time", [gated("rank"), gated("rank2"), ids(now).includes("rank") && !ids(now).includes("rank2")], ["LEAGUE 9-1", "OVERALL 60-40", true]);
  check("legacy: 9-1 in MLB is 50% all time and fails the gate", ids(old).includes("rank2") && !ids(old).includes("rank"), true);
  check("no MLB record: all time qualifies it", ids(now).includes("fallback"), true);
  check("Last 20 never qualifies a pick", ids(now).includes("last20"), false);
  const leg = (id: string) => now.legs.find((l) => l.pick.pickId === id)!;
  check("each leg says which record it is", [leg("lgGood").basis, leg("rank").basis, leg("fallback").basis], ["LEAGUE", "LEAGUE", "OVERALL"]);
  check("the leg's record is the one it was gated on", [leg("lgGood").record, leg("fallback").record], [{ wins: 4, losses: 1, n: 5, winPct: 80 }, { wins: 6, losses: 4, n: 10, winPct: 60 }]);
  check("legacy legs say MARKET", old.legs.map((l) => l.basis), ["MARKET", "MARKET", "MARKET"]);
  check("shown: MLB market / all leagues market", [recordText(leg("lgGood").record, "LEAGUE", leg("lgGood").pick), recordText(leg("fallback").record, "OVERALL", leg("fallback").pick)], ["80% (4–1) · MLB favorite moneyline", "60% (6–4) · all leagues favorite moneyline"]);
}

// ============================================================================
// Hedge and Contrarian use the same record; Contrarian has no headcount
// ============================================================================
{
  // G0: Hedge's alternate (Over) is 6-2 in MLB, 40% all time.
  // G1: Contrarian 1 vs 1 - the other side is 6-3 in MLB.
  // G2: the other side is 2-3 in MLB but 30-10 all time: all time is its record.
  // G3: two on the other side (2 vs 1): the better Wilson wins (20-8 over 3-0).
  const snap = makeSnapshot([
    { id: "h", game: 0, bet: "HOME", lg: [8, 2], all: [8, 2] },
    { id: "hAlt", game: 0, bet: "OVER", lg: [6, 2], all: [40, 60] },
    { id: "c", game: 1, bet: "HOME", lg: [9, 1], all: [9, 1] },
    { id: "cAlt", game: 1, bet: "AWAY", lg: [6, 3], all: [6, 3] },
    { id: "x", game: 2, bet: "HOME", lg: [9, 1], all: [9, 1] },
    { id: "xAlt", game: 2, bet: "AWAY", lg: [2, 3], all: [30, 10] },
    { id: "o", game: 3, bet: "HOME", lg: [12, 1], all: [12, 1] },
    { id: "oSmall", game: 3, bet: "AWAY", lg: [3, 0], all: [3, 0] },
    { id: "oBig", game: 3, bet: "AWAY", lg: [20, 8], all: [20, 8] },
  ]);
  const now = buildGeneratedParlay(snap, SETTINGS, null, NOW);
  const old = buildGeneratedParlay(snap, SETTINGS, null, NOW, LEGACY_RULES);
  check("primaries", ids(now).sort(), ["c", "h", "o", "x"]);
  check("Hedge: alternate qualifies on its MLB record", swapOf(now.hedge, "h"), { to: "hAlt", basis: "LEAGUE", record: "6-2" });
  check("legacy Hedge: 40% all time, no alternate", swapOf(old.hedge, "h"), "NO_ALTERNATE");
  check("Contrarian 1 vs 1: the other side's capper clears the gate - a swap", swapOf(now.contrarian, "c"), { to: "cAlt", basis: "LEAGUE", record: "6-3" });
  check("legacy Contrarian 1 vs 1: not the majority", swapOf(old.contrarian, "c"), "NOT_MAJORITY");
  check("Contrarian: 2-3 in MLB no longer hides 30-10 all time", swapOf(now.contrarian, "x"), { to: "xAlt", basis: "OVERALL", record: "30-10" });
  check("Contrarian with the other side bigger: same Wilson order as everything else", swapOf(now.contrarian, "o"), { to: "oBig", basis: "LEAGUE", record: "20-8" });
  check("legacy: 1 vs 2 is not the majority", swapOf(old.contrarian, "o"), "NOT_MAJORITY");
  check("NOT_MAJORITY never comes from the new rules", [...now.contrarian.legs].some((l) => l.unchangedReason === "NOT_MAJORITY"), false);
  check("swap shown with its record", recordText({ wins: 6, losses: 2, n: 8, winPct: 75 }, "LEAGUE", snap.games[0].picks[1]), "75% (6–2) · MLB over");
}

// ============================================================================
// Same inputs, same output (Generate stays deterministic)
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "a", game: 0, bet: "HOME", lg: [5, 2], all: [10, 9] },
    { id: "b", game: 0, bet: "OVER", lg: [5, 2], all: [10, 10] },
    { id: "c", game: 1, bet: "HOME", lg: [3, 1], all: [3, 1] },
  ]);
  const runs = [0, 1, 2].map(() => JSON.stringify(buildGeneratedParlay(snap, SETTINGS, null, NOW)));
  check("deterministic", new Set(runs).size, 1);
  check("an exact tie on the in-league record: pick id breaks it", ids(buildGeneratedParlay(snap, SETTINGS, null, NOW)).slice(0, 1), ["a"]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
