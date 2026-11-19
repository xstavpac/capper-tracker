// Neutral-site games in the ledger, tendencies, board dedup and recent swings - run with:
//   npx tsx src/server/data/neutral-site-ledger-acceptance-test.ts
//
// Auburn / Notre Dame 2026-11-19: ESPN home = Auburn, odds feed home = Notre Dame. The home/away-strict
// joins left favTeam / totalLine null, the game out of team tendencies, a phantom card undropped and
// the line "missing" in recent swings. Each now matches either orientation, and every value that is
// relative to a side (favorite, home spread) stays with its own team. Pure - no DB reads.
import { deriveLedgerFields } from "@/server/data/grading";
import { findOddsGameForResult, moneylinePrice, totalLine } from "@/server/data/team-tendencies";
import { dropPhantomCards } from "@/lib/live-board-dedup";
import { chooseLine, swingForTeam, assembleSwings, type StoredLine, type SwingScore } from "@/lib/parlay/recent-swings";
import type { OddsGame, ScoreGame } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const SK = "basketball_ncaab";
const AUB = "Auburn Tigers";
const ND = "Notre Dame Fighting Irish";
const START = "2026-11-19T23:00:00Z";
const startDate = new Date(START);

// An odds game listing `home` as home; `homePrice`/`awayPrice` are its h2h prices.
function oddsGame(home: string, away: string, homePrice: number, awayPrice: number, total: number | null = 150.5, spreadHome = -3.5): OddsGame {
  return {
    id: `${home}-${away}`,
    sportKey: SK,
    homeTeam: home,
    awayTeam: away,
    commenceTime: START,
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        markets: [
          { key: "h2h", outcomes: [{ name: home, price: homePrice }, { name: away, price: awayPrice }] },
          ...(total === null ? [] : [{ key: "totals", outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] }]),
          { key: "spreads", outcomes: [{ name: home, price: -110, point: spreadHome }, { name: away, price: -110, point: -spreadHome }] },
        ],
      },
    ],
  } as OddsGame;
}

// ============================================================================
// 1. deriveLedgerFields
// ============================================================================
{
  // Same orientation (control): Auburn home.
  check("same orientation, home favored: favTeam = home, total read", deriveLedgerFields([oddsGame(AUB, ND, -150, 130)], AUB, ND, startDate), { favTeam: AUB, totalLine: 150.5 });
  check("same orientation, away favored: favTeam = away", deriveLedgerFields([oddsGame(AUB, ND, 130, -150)], AUB, ND, startDate).favTeam, ND);
}
{
  // Flipped: ESPN (caller) says Auburn home, the odds feed lists Notre Dame at home.
  const g = [oddsGame(ND, AUB, -150, 130)];
  check("flipped, odds-home (Notre Dame) favored: favTeam = Notre Dame, totalLine kept", deriveLedgerFields(g, AUB, ND, startDate), { favTeam: ND, totalLine: 150.5 });
  const g2 = [oddsGame(ND, AUB, 130, -150)];
  check("flipped, odds-away (Auburn) favored: favTeam = Auburn", deriveLedgerFields(g2, AUB, ND, startDate).favTeam, AUB);
  check("flipped with no totals market: favTeam still set, totalLine null", deriveLedgerFields([oddsGame(ND, AUB, -150, 130, null)], AUB, ND, startDate), { favTeam: ND, totalLine: null });
  check("flipped, a different team pair: nothing", deriveLedgerFields(g, AUB, "Duke Blue Devils", startDate), { favTeam: null, totalLine: null });
  check("flipped, other Eastern day: nothing", deriveLedgerFields(g, AUB, ND, new Date("2026-11-21T23:00:00Z")), { favTeam: null, totalLine: null });
}

// ============================================================================
// 2. team-tendencies' findOddsGameForResult
// ============================================================================
{
  const flipped = oddsGame(ND, AUB, -150, 130);
  const result = { homeTeam: AUB, awayTeam: ND, gameDate: startDate };
  const found = findOddsGameForResult([flipped], result);
  check("findOddsGameForResult finds the flipped odds game", found?.id, flipped.id);
  check("moneylinePrice by name on the flipped game: Auburn +130, Notre Dame -150", [moneylinePrice(flipped, AUB), moneylinePrice(flipped, ND)], [130, -150]);
  check("totalLine on the flipped game", found ? totalLine(found) : null, 150.5);
  check("same orientation still found", findOddsGameForResult([oddsGame(AUB, ND, -150, 130)], result)?.id, `${AUB}-${ND}`);
  check("a different pair is not found", findOddsGameForResult([flipped], { homeTeam: AUB, awayTeam: "Duke Blue Devils", gameDate: startDate }), null);
}

// ============================================================================
// 3. live-board-dedup
// ============================================================================
{
  const card = (id: string, home: string, away: string, t: string) => ({ id, homeTeam: home, awayTeam: away, commenceTime: t });
  const sched = (home: string, away: string, t: string): ScoreGame =>
    ({ id: "s1", homeTeam: home, awayTeam: away, commenceTime: t, status: "preview", scores: null, inningHalf: null, inningOrdinal: null }) as ScoreGame;
  // Two odds cards for the one game (a phantom early start and the real one); the schedule lists it reversed.
  const real = card("real", ND, AUB, "2026-11-19T23:00:00Z");
  const phantom = card("phantom", ND, AUB, "2026-11-19T18:00:00Z");
  const out = dropPhantomCards([phantom, real], [sched(AUB, ND, "2026-11-19T23:00:00Z")]);
  check("reversed schedule game: the phantom card is dropped, the real one kept", out.games.map((g) => g.id), ["real"]);
  check("reversed schedule game is assigned to the kept card", out.scheduleGames.map((s) => s?.id), ["s1"]);
  check("same orientation unchanged: phantom dropped", dropPhantomCards([phantom, real], [sched(ND, AUB, "2026-11-19T23:00:00Z")]).games.map((g) => g.id), ["real"]);
  check("no schedule game: nothing dropped", dropPhantomCards([phantom, real], []).games.map((g) => g.id), ["phantom", "real"]);
  check("a schedule game for other teams: nothing dropped", dropPhantomCards([phantom, real], [sched(AUB, "Duke Blue Devils", "2026-11-19T23:00:00Z")]).games.map((g) => g.id), ["phantom", "real"]);
}

// ============================================================================
// 4. recent swings (chooseLine / swingForTeam / assembleSwings)
// ============================================================================
{
  const score: SwingScore = { externalId: "g1", gameDate: START, homeTeam: AUB, awayTeam: ND, homeScore: 80, awayScore: 70, gameNumber: null };
  // The stored line lists Notre Dame at home, favored by 3.5 (the home spread is Notre Dame's -3.5).
  const line: StoredLine = { fetchDate: "2026-11-19", eventId: "e1", homeTeam: ND, awayTeam: AUB, commenceTime: START, homeSpread: -3.5, spreadUpdatedAt: "2026-11-19T20:00:00Z", total: 148, totalUpdatedAt: "2026-11-19T20:00:00Z" };
  const chosen = chooseLine(score, [line], SK);
  check("flipped stored line is found, spread flipped to Auburn's (score-home) side", chosen && [chosen.homeSpread, chosen.total], [3.5, 148]);
  const auburn = swingForTeam(score, true, chosen);
  const nd = swingForTeam(score, false, chosen);
  check("Auburn posted +3.5, won by 10: covered by 13.5", [auburn.postedSpread, auburn.coverMargin], [3.5, 13.5]);
  check("Notre Dame posted -3.5, lost by 10: missed by 13.5", [nd.postedSpread, nd.coverMargin], [-3.5, -13.5]);
  check("total is orientation-free: 150 on 148", [auburn.postedTotal, auburn.totalMiss], [148, 2]);
  check("same orientation unchanged", chooseLine(score, [{ ...line, homeTeam: AUB, awayTeam: ND, homeSpread: 3.5 }], SK)?.homeSpread, 3.5);
  const all = assembleSwings(SK, [score], [line], 5);
  check("assembleSwings carries the flipped line to both teams", [all[AUB][0].lineSource, all[AUB][0].postedSpread, all[ND][0].postedSpread], ["stored", 3.5, -3.5]);
  check("flipped line with another team pair is not used", chooseLine({ ...score, awayTeam: "Duke Blue Devils" }, [line], SK), null);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll neutral-site ledger checks passed");
