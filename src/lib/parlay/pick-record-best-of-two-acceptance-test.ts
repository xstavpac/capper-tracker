// recordForGate's best-of-two (pick-record.ts): a generated leg, and a Hedge or
// Contrarian alternate, is gated and ranked on whichever of its capper's
// in-league and all-time category records scores higher on the generator's
// ordering score (Wilson lower bound at GENERATOR_Z = 1.5), a tie to the
// league. The win-% gate is checked on the chosen record only - no fallback to
// the other one - and there is no minimum sample. Consensus Hybrid stays on
// leagueFirstRecord. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/pick-record-best-of-two-acceptance-test.ts
import { buildGeneratedParlay, GENERATOR_Z, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { leagueFirstRecord, recordForGate } from "@/lib/parlay/pick-record";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
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
];

const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });

// lg: the capper's record in this market in MLB; all: every league, every season.
type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER"; lg: [number, number] | null; all: [number, number] | null };

function makeSnapshot(specs: Spec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<number, GeneratorPick[]>();
  for (const s of specs) {
    const [home, away, homeNick, awayNick] = TEAMS[s.game];
    const detail = s.bet === "HOME" ? homeNick + " ML" : s.bet === "AWAY" ? awayNick + " ML" : "Over 8.5";
    const category: PickCategoryKey = s.bet === "HOME" ? "FAV_ML" : s.bet === "AWAY" ? "DOG_ML" : "OVER";
    const capperId = "cap-" + s.id;
    if (s.all) {
      const c = col(s.all[0], s.all[1]);
      categoryRecords[capperId + "|" + category] = { key: category, label: category, ...c };
      leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: c, league: s.lg ? col(s.lg[0], s.lg[1]) : col(0, 0) };
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

const SETTINGS: GeneratorSettings = { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const pickOf = (snap: GeneratorSnapshot, id: string) => snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!;
const chosen = (snap: GeneratorSnapshot, id: string) => {
  const r = recordForGate(pickOf(snap, id), snap.leagueRecords, snap.categoryRecords);
  return r && `${r.source} ${r.wins}-${r.losses}`;
};

check("ordering score is z = 1.5", GENERATOR_Z, 1.5);

// ============================================================================
// The acceptance cases
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "perfect8", game: 0, bet: "HOME", lg: [8, 0], all: [60, 40] },
    { id: "small12", game: 0, bet: "AWAY", lg: [1, 2], all: [60, 40] },
    { id: "one10", game: 1, bet: "HOME", lg: [1, 0], all: [60, 40] },
    { id: "mid184", game: 1, bet: "AWAY", lg: [18, 4], all: [70, 50] },
    { id: "allOnly", game: 2, bet: "HOME", lg: null, all: [60, 40] },
  ]);
  check("in-league 8-0 vs all-time 60-40 -> in-league", chosen(snap, "perfect8"), "LEAGUE 8-0");
  check("in-league 1-2 vs all-time 60-40 -> all-time", chosen(snap, "small12"), "OVERALL 60-40");
  check("in-league 1-0 vs all-time 60-40 -> all-time", chosen(snap, "one10"), "OVERALL 60-40");
  check("in-league 18-4 vs all-time 70-50 -> in-league", chosen(snap, "mid184"), "LEAGUE 18-4");
  check("only an all-time record -> all-time", chosen(snap, "allOnly"), "OVERALL 60-40");
}

// A capper whose only record is 1-0 qualifies at the 55% gate and orders below a 60-40 capper.
{
  const snap = makeSnapshot([
    { id: "onlyOne", game: 0, bet: "HOME", lg: [1, 0], all: [1, 0] },
    { id: "sixty", game: 0, bet: "OVER", lg: [60, 40], all: [60, 40] },
  ]);
  check("only 1-0 total: its record is 1-0", chosen(snap, "onlyOne"), "LEAGUE 1-0");
  const one = buildGeneratedParlay(makeSnapshot([{ id: "onlyOne", game: 0, bet: "HOME", lg: [1, 0], all: [1, 0] }]), SETTINGS, null, NOW);
  check("only 1-0 total: qualifies at the 55% gate", one.legs.map((l) => l.pick.pickId), ["onlyOne"]);
  const both = buildGeneratedParlay(snap, { ...SETTINGS, legCount: 1 }, null, NOW);
  check("1-0 orders below 60-40 (one leg on their game: 60-40 gets it)", both.legs.map((l) => l.pick.pickId), ["sixty"]);
  check("scores: 1-0 below 60-40", wilsonLowerBound(1, 0, GENERATOR_Z) < wilsonLowerBound(60, 40, GENERATOR_Z), true);
}

// ============================================================================
// Ties, the gate, the suffix, Hedge / Contrarian, Hybrid
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "tie", game: 0, bet: "HOME", lg: [6, 4], all: [6, 4] },
    // 50-40 in MLB (55.6%) scores above 2-0 all time, so 50-40 is the record.
    { id: "noFallback", game: 1, bet: "HOME", lg: [50, 40], all: [2, 0] },
    { id: "hedged", game: 2, bet: "HOME", lg: [9, 1], all: [9, 1] },
    { id: "hedgeAlt", game: 2, bet: "OVER", lg: [1, 2], all: [60, 40] },
    { id: "flipped", game: 3, bet: "HOME", lg: [9, 1], all: [9, 1] },
    { id: "flipAlt", game: 3, bet: "AWAY", lg: [1, 0], all: [60, 40] },
  ]);
  check("a tie goes to the in-league record", chosen(snap, "tie"), "LEAGUE 6-4");
  check(
    "scored at the z it is given: 50-40 in MLB at 1.5, 2-0 all time at 0.1",
    [chosen(snap, "noFallback"), recordForGate(pickOf(snap, "noFallback"), snap.leagueRecords, snap.categoryRecords, 0.1)?.source],
    ["LEAGUE 50-40", "OVERALL"]
  );
  check("gate on the chosen record: 50-40 in MLB passes 55", buildGeneratedParlay(snap, SETTINGS, null, NOW).legs.some((l) => l.pick.pickId === "noFallback"), true);
  check(
    "gate on the chosen record only: 50-40 fails 60, and 2-0 all time is never tried",
    buildGeneratedParlay(snap, { ...SETTINGS, minWinPct: 60 }, null, NOW).legs.some((l) => l.pick.pickId === "noFallback"),
    false
  );

  const built = buildGeneratedParlay(snap, SETTINGS, null, NOW);
  const leg = built.legs.find((l) => l.pick.pickId === "tie")!;
  check("the leg's suffix names the chosen record: MLB", recordText(leg.record, leg.basis, leg.pick), "60% (6–4) · MLB favorite moneyline");
  const hedge = built.hedge.SUGGESTED.legs.find((l) => l.original.pick.pickId === "hedged")!;
  check("Hedge alternate on its better record (all time 60-40 over 1-2 in MLB)", hedge.swap && { to: hedge.swap.pick.pickId, basis: hedge.swap.basis, record: `${hedge.swap.record.wins}-${hedge.swap.record.losses}` }, { to: "hedgeAlt", basis: "OVERALL", record: "60-40" });
  check("swap suffix names the chosen record: all leagues", hedge.swap && recordText(hedge.swap.record, hedge.swap.basis ?? "MARKET", hedge.swap.pick), "60% (60–40) · all leagues over");
  const flip = built.contrarian.SUGGESTED.legs.find((l) => l.original.pick.pickId === "flipped")!;
  check("Contrarian alternate on its better record (all time 60-40 over 1-0 in MLB)", flip.swap && { to: flip.swap.pick.pickId, basis: flip.swap.basis }, { to: "flipAlt", basis: "OVERALL" });

  // Consensus Hybrid is unchanged: in-league whenever there is any.
  const lf = (id: string) => {
    const r = leagueFirstRecord(pickOf(snap, id), snap.leagueRecords, snap.categoryRecords);
    return r && `${r.source} ${r.wins}-${r.losses}`;
  };
  check("Hybrid (leagueFirstRecord) keeps in-league first", [lf("hedgeAlt"), lf("flipAlt"), lf("noFallback")], ["LEAGUE 1-2", "LEAGUE 1-0", "LEAGUE 50-40"]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
