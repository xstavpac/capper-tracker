// Proof that a bulk-imported ML / spread / total pick is priced from the odds snapshot when the schedule feed and
// The Odds API spell a team differently.
//
// The bug (2026-11-10): "Duke Moneyline" stored at -110 (DEFAULTED, no_market) on Duke -278 night, and so did
// every ML/spread/total on Duke v Michigan State, Duquesne v Washington State and Suns v Clippers. The snapshot had
// all three games with 8-10 books. The pick side is ESPN-spelled ("Michigan State Spartans", "LA Clippers"); the
// snapshot is Odds-API-spelled ("Michigan St Spartans", "Los Angeles Clippers"). teamNamesMatch already reconciles
// both (#403's NCAAB "state" -> "st" fold and alias rows; the NBA/NCAAF alias rows) - but only when it is given the
// sport key, and resolveOddsGame did not pass one. So resolveOddsGame returned null, and every price lookup behind
// it (findMarketPricePoint, findFavoredSide, findMarketSpreadLine/TotalLine, alt lines, props) found no game.
// 396 NCAAB picks over 72 games since 2026-11-02 were defaulted this way, plus NBA Clippers and NCAAF App State /
// Louisiana / UMass / Southern Miss / Sam Houston games.
//
// Pinned here, with real snapshot data (fixture: __fixtures__/odds-team-name-pricing-fixture.ts):
//   1. the three games price at their real snapshot prices, through the real findMarketPricePoint/findFavoredSide;
//   2. exact-line and side rules are untouched - an off-main-line pick still gets no price, never a neighbour's;
//   3. guard: every NCAAB name seen in a live snapshot (2026-11-01..10) matches exactly one ESPN D1 team;
//   4. replay: for every NBA/NCAAF game that priced from the market in the last 14 days, the keyed resolver picks
//      the very same snapshot event as the old unkeyed one (same event -> same price), so turning the alias rows
//      on for this path changes no price that already resolves;
//   5. a feed that lists a game home/away the other way round still does not match (reading "home" off it would
//      price the other team).
//
// No DB, no network: every loader below serves the fixture.
// Run with:
//   npx tsx src/server/data/odds-team-name-pricing-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { closestByTime } from "@/lib/dates";
import { teamNamesMatch } from "@/lib/team-name-match";
import { NCAAB_D1_TEAMS } from "@/lib/generated/college-teams.generated";
import { resolveOddsGame, findMarketPricePoint, findFavoredSide, type OddsGame, type OddsLoader } from "./odds";
import { NOV10_EVENTS, NCAAB_SNAPSHOT_NAMES, PICK_GAMES, SNAPSHOT_EVENTS } from "./__fixtures__/odds-team-name-pricing-fixture";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const NCAAB = "basketball_ncaab";
const NBA = "basketball_nba";
const nov10: OddsLoader = async (sportKey) => NOV10_EVENTS.filter((e) => e.sportKey === sportKey).map((e) => e.game);
const FULL = "FULL_GAME";

async function main() {
  // ---- 1. the three games, ESPN-spelled as the import stores them, priced from the snapshot ---------------------

  // Duke v Michigan State: the schedule says "Michigan State Spartans", the snapshot "Michigan St Spartans".
  const duke = { homeTeam: "Duke Blue Devils", awayTeam: "Michigan State Spartans", commenceTime: "2026-11-11T00:00:00Z" };
  expect("Duke: resolves to the snapshot event", (await resolveOddsGame(NCAAB, duke, nov10))?.id, "8f8f96b87641a3cbc280c8e63aed3ad4");
  expect("Duke Moneyline: -278 from the first book (Caesars), not -110", await findMarketPricePoint(NCAAB, duke, "MONEYLINE", "home", { line: null, period: FULL }, nov10), { price: -278, book: "williamhill_us", eventId: "8f8f96b87641a3cbc280c8e63aed3ad4" });
  expect("Michigan State Moneyline: +222", (await findMarketPricePoint(NCAAB, duke, "MONEYLINE", "away", { line: null, period: FULL }, nov10))?.price, 222);
  expect("Duke -6.5 (the main line): -110 off the market, with its book", await findMarketPricePoint(NCAAB, duke, "SPREAD", "home", { line: -6.5, period: FULL }, nov10), { price: -110, book: "williamhill_us", eventId: "8f8f96b87641a3cbc280c8e63aed3ad4" });
  expect("Duke under 148.5: -110 off the market (a real -110, now MARKET not DEFAULTED)", (await findMarketPricePoint(NCAAB, duke, "TOTAL", "under", { line: 148.5, period: FULL }, nov10))?.book, "williamhill_us");
  expect("Duke: h2h favourite is HOME (Pick.mlFavoredSide)", await findFavoredSide(NCAAB, duke, nov10), "HOME");

  // Duquesne v Washington State. (Its first two books list no h2h - the spread and total are what price here.)
  const duq = { homeTeam: "Duquesne Dukes", awayTeam: "Washington State Cougars", commenceTime: "2026-11-11T00:00:00Z" };
  expect("Duquesne: resolves to the snapshot event", (await resolveOddsGame(NCAAB, duq, nov10))?.id, "cb982523378ba8e6e0aadc0e97748791");
  expect("Duquesne -5: -105 (BetOnline)", await findMarketPricePoint(NCAAB, duq, "SPREAD", "home", { line: -5, period: FULL }, nov10), { price: -105, book: "betonlineag", eventId: "cb982523378ba8e6e0aadc0e97748791" });
  expect("Washington State +5: -115", (await findMarketPricePoint(NCAAB, duq, "SPREAD", "away", { line: 5, period: FULL }, nov10))?.price, -115);
  expect("Duquesne/Washington State over 149.5: -110 (BetOnline)", (await findMarketPricePoint(NCAAB, duq, "TOTAL", "over", { line: 149.5, period: FULL }, nov10))?.book, "betonlineag");

  // Suns v Clippers: the schedule says "LA Clippers", the snapshot "Los Angeles Clippers" (the one NBA alias row).
  const suns = { homeTeam: "Phoenix Suns", awayTeam: "LA Clippers", commenceTime: "2026-11-11T02:00:00Z" };
  expect("Suns: resolves to the snapshot event (02:10Z listing vs 02:00Z schedule)", (await resolveOddsGame(NBA, suns, nov10))?.id, "8178ff2ec61f604b61dfe6d7b8d71103");
  expect("Phoenix Suns ML: -186 (FanDuel), not -110", await findMarketPricePoint(NBA, suns, "MONEYLINE", "home", { line: null, period: FULL }, nov10), { price: -186, book: "fanduel", eventId: "8178ff2ec61f604b61dfe6d7b8d71103" });
  expect("Los Angeles Clippers ML: +156", (await findMarketPricePoint(NBA, suns, "MONEYLINE", "away", { line: null, period: FULL }, nov10))?.price, 156);
  expect("Suns -4.5: -115", (await findMarketPricePoint(NBA, suns, "SPREAD", "home", { line: -4.5, period: FULL }, nov10))?.price, -115);
  expect("Suns: h2h favourite is HOME", await findFavoredSide(NBA, suns, nov10), "HOME");

  // ---- 2. the exact-line / side / period rules are unchanged ----------------------------------------------------

  // The 2026-11-10 picks at numbers the snapshot does not hang stay unpriced here (the alt-line path, not this one,
  // may price them) - never priced off the main line.
  expect("Duke -7.5 (main is -6.5): no snapshot price", await findMarketPricePoint(NCAAB, duke, "SPREAD", "home", { line: -7.5, period: FULL }, nov10), null);
  expect("Duquesne -3.5 (main is -5): no snapshot price", await findMarketPricePoint(NCAAB, duq, "SPREAD", "home", { line: -3.5, period: FULL }, nov10), null);
  expect("Phoenix Suns -3.5 (main is -4.5): no snapshot price", await findMarketPricePoint(NBA, suns, "SPREAD", "home", { line: -3.5, period: FULL }, nov10), null);
  expect("Clippers +4 (main is +4.5): no snapshot price", await findMarketPricePoint(NBA, suns, "SPREAD", "away", { line: 4, period: FULL }, nov10), null);
  expect("Duke ML 1H: full-game h2h is not a half price", await findMarketPricePoint(NCAAB, duke, "MONEYLINE", "home", { line: null, period: "FIRST_HALF" }, nov10), null);
  expect("Duquesne ML: no book in the fixture lists h2h -> null, not a spread price", await findMarketPricePoint(NCAAB, duq, "MONEYLINE", "home", { line: null, period: FULL }, nov10), null);
  // A different school with a similar name never takes this game.
  const michigan = { homeTeam: "Duke Blue Devils", awayTeam: "Michigan Wolverines", commenceTime: "2026-11-11T00:00:00Z" };
  expect("Duke v Michigan (not Michigan State): no event", await resolveOddsGame(NCAAB, michigan, nov10), null);
  const washington = { homeTeam: "Duquesne Dukes", awayTeam: "Washington Huskies", commenceTime: "2026-11-11T00:00:00Z" };
  expect("Duquesne v Washington (not Washington State): no event", await resolveOddsGame(NCAAB, washington, nov10), null);
  // The alias is league-scoped: an NCAAB lookup never uses the NBA row, and vice versa.
  expect("Suns v LA Clippers under the NCAAB key: no event", await resolveOddsGame(NCAAB, suns, async () => NOV10_EVENTS.filter((e) => e.sportKey === NBA).map((e) => e.game)), null);

  // ---- 3. guard: every NCAAB name in a live snapshot has exactly one ESPN D1 twin -------------------------------

  const espn = NCAAB_D1_TEAMS.map((t) => t.name);
  // Non-D1 opponents The Odds API lists (no ESPN D1 entry by design). Empty today: all 352 names seen 2026-11-01..10
  // have an ESPN D1 twin. A name only goes here once confirmed absent from ESPN's D1 list - anything else unmatched
  // is a missing alias row and fails below.
  const NON_D1: ReadonlySet<string> = new Set<string>();
  const twins = (o: string) => espn.filter((e) => teamNamesMatch(e, o, NCAAB));
  const unmatched = NCAAB_SNAPSHOT_NAMES.filter((o) => !NON_D1.has(o) && twins(o).length === 0);
  const ambiguous = NCAAB_SNAPSHOT_NAMES.filter((o) => twins(o).length > 1);
  console.log(`INFO: ${NCAAB_SNAPSHOT_NAMES.length} snapshot names checked against ${espn.length} ESPN D1 names`);
  expect("every NCAAB snapshot name matches an ESPN D1 team (else: add an alias row)", unmatched, []);
  expect("no NCAAB snapshot name matches two ESPN D1 teams", ambiguous, []);
  expect("the non-D1 allowlist holds only names really absent from ESPN D1", [...NON_D1].filter((o) => twins(o).length > 0), []);

  // ---- 4. replay: the keyed resolver picks the same event the old one did, for every market-priced game ---------

  // The old resolver, verbatim (teamNamesMatch without the sport key).
  function legacyResolve(events: OddsGame[], game: { homeTeam: string; awayTeam: string; commenceTime: string }): OddsGame | null {
    const candidates = events.filter((g) => teamNamesMatch(g.homeTeam, game.homeTeam) && teamNamesMatch(g.awayTeam, game.awayTeam));
    if (candidates.length === 0) return null;
    return closestByTime(candidates, (g) => new Date(g.commenceTime).getTime(), new Date(game.commenceTime).getTime());
  }
  const eventsFor = (sportKey: string, fetchDate: string): OddsGame[] =>
    SNAPSHOT_EVENTS.filter(([sk, fd]) => sk === sportKey && fd === fetchDate).map(([sk, fd, h, a, t]) => ({
      id: `${sk}|${fd}|${h}|${a}|${t}`, sportKey: sk, homeTeam: h, awayTeam: a, commenceTime: t, bookmakers: [],
    }));
  let same = 0;
  const changed: string[] = [];
  const unresolved: string[] = [];
  for (const [sk, fd, h, a, t] of PICK_GAMES) {
    const events = eventsFor(sk, fd);
    const game = { homeTeam: h, awayTeam: a, commenceTime: t };
    const before = legacyResolve(events, game)?.id ?? null;
    const after = (await resolveOddsGame(sk, game, async () => events))?.id ?? null;
    if (before === null) unresolved.push(`${sk} ${fd} ${h} v ${a}`);
    if (before === after) same++;
    else changed.push(`${sk} ${fd} ${h} v ${a}: ${before} -> ${after}`);
  }
  console.log(`INFO: replayed ${PICK_GAMES.length} market-priced NBA/NCAAF games against ${SNAPSHOT_EVENTS.length} snapshot events`);
  expect("replay: every market-priced game resolved under the old rule too (fixture is complete)", unresolved, []);
  expect("replay: no market-priced NBA/NCAAF game resolves to a different event once keyed", changed, []);
  expect("replay: games compared", same, PICK_GAMES.length);
  // ...while the alias-spelled games in those same snapshots, which the old rule could not reach, now resolve.
  const reached = [
    [NBA, "2026-11-08", "LA Clippers", "New Orleans Pelicans", "2026-11-09T02:00:00Z"],
    ["americanfootball_ncaaf", "2026-11-07", "App State Mountaineers", "Georgia State Panthers", "2026-11-07T19:30:00Z"],
    ["americanfootball_ncaaf", "2026-11-07", "Louisiana Ragin' Cajuns", "South Alabama Jaguars", "2026-11-07T22:00:00Z"],
    ["americanfootball_ncaaf", "2026-11-07", "Jacksonville State Gamecocks", "Sam Houston Bearkats", "2026-11-08T00:00:00Z"],
    ["americanfootball_ncaaf", "2026-11-04", "Massachusetts Minutemen", "Ball State Cardinals", "2026-11-05T00:00:00Z"],
    ["americanfootball_ncaaf", "2026-11-04", "Southern Miss Golden Eagles", "James Madison Dukes", "2026-11-06T01:00:00Z"],
  ] as const;
  for (const [sk, fd, h, a, t] of reached) {
    const events = eventsFor(sk, fd);
    const game = { homeTeam: h, awayTeam: a, commenceTime: t };
    expect(`${h} v ${a}: unreachable before (unkeyed)`, legacyResolve(events, game), null);
    expect(`${h} v ${a}: resolves now (keyed)`, (await resolveOddsGame(sk, game, async () => events)) !== null, true);
  }

  // ---- 5. home/away still have to agree ------------------------------------------------------------------------

  // 2026-11-08: the schedule had Nebraska at home, the snapshot listed Providence at home (neutral site).
  const flipped: OddsLoader = async () => [{ id: "x", sportKey: NCAAB, homeTeam: "Providence Friars", awayTeam: "Nebraska Cornhuskers", commenceTime: "2026-11-08T00:00:00Z", bookmakers: [] }];
  expect("home/away reversed between feeds: no match (side 'home' would read the other team's price)", await resolveOddsGame(NCAAB, { homeTeam: "Nebraska Cornhuskers", awayTeam: "Providence Friars", commenceTime: "2026-11-08T00:00:00Z" }, flipped), null);

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
