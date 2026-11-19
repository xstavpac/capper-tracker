// Neutral-site games priced at import - run with:
//   npx tsx src/server/data/neutral-site-odds-pricing-acceptance-test.ts
//
// ESPN (which resolves a pick's game) and the Odds API (which prices it) disagree on the home team
// of a neutral-site game: Auburn / Notre Dame 2026-11-19, ESPN home = Auburn, Odds API home = Notre
// Dame. resolveOddsGame matched home-to-home only, so every pick on such a game was stored at the
// -110 default. It now accepts either orientation and hands a reversed listing back MIRRORED, so a
// side read off it ("home" = Auburn, in the pick's orientation) is always that team's own outcome.
//
// Every check goes through the real exported pricing functions (findMarketPricePoint,
// findFavoredSide, findMarketSpreadLine, findMarketTotalLine, resolveThreeWayOdds, resolveOddsGame)
// with a stub odds loader: pure, no DB, no network. The game starts in the future, so
// resolveOddsGame reads today's listing (the stub) and never a past-day row.
import {
  findFavoredSide,
  findMarketPricePoint,
  findMarketSpreadLine,
  findMarketTotalLine,
  mirrorOddsGame,
  resolveOddsGame,
  type OddsGame,
  type OddsLoader,
} from "@/server/data/odds";
import { resolveThreeWayOdds } from "@/server/data/nhl-goal-scorer-odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const SK = "basketball_ncaab";
const AUB = "Auburn Tigers";
const ND = "Notre Dame Fighting Irish";
const START = "2099-11-19T22:00:00Z";
const FG = "FULL_GAME";

// The real 2026-11-19 FanDuel listing for this game, as the Odds API had it: Notre Dame at home.
// Every price is distinct per team, so reading the wrong team's outcome can never pass by accident.
//   h2h:     Auburn -150, Notre Dame +126
//   spreads: Auburn -3.5 (-102), Notre Dame +3.5 (-120)
//   totals:  Over 151.5 (-115), Under 151.5 (-105)
//   team_totals (Over/Under, `description` = team): Auburn 78.5 (-112 / -108), Notre Dame 73.5 (-118 / -102)
function listing(home: string, away: string, id = "aub-nd"): OddsGame {
  return {
    id,
    sportKey: SK,
    homeTeam: home,
    awayTeam: away,
    commenceTime: START,
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        markets: [
          { key: "h2h", outcomes: [{ name: AUB, price: -150 }, { name: ND, price: 126 }] },
          { key: "spreads", outcomes: [{ name: AUB, price: -102, point: -3.5 }, { name: ND, price: -120, point: 3.5 }] },
          { key: "totals", outcomes: [{ name: "Over", price: -115, point: 151.5 }, { name: "Under", price: -105, point: 151.5 }] },
          {
            key: "team_totals",
            outcomes: [
              { name: "Over", description: AUB, price: -112, point: 78.5 },
              { name: "Under", description: AUB, price: -108, point: 78.5 },
              { name: "Over", description: ND, price: -118, point: 73.5 },
              { name: "Under", description: ND, price: -102, point: 73.5 },
            ],
          },
        ],
      },
    ],
  } as OddsGame;
}

const loaderOf = (games: OddsGame[]): OddsLoader => async () => games;

// The pick's game as ESPN resolved it: Auburn home.
const PICK_GAME = { homeTeam: AUB, awayTeam: ND, commenceTime: START };

// Both orientations of the feed must give identical answers for the same pick.
const FEEDS: [label: string, games: OddsGame[]][] = [
  ["same orientation (feed home = Auburn)", [listing(AUB, ND)]],
  ["FLIPPED (feed home = Notre Dame)", [listing(ND, AUB)]],
];

async function main() {
for (const [feed, games] of FEEDS) {
  const L = loaderOf(games);
  console.log(`\n########## ${feed} ##########`);

  // --- resolveOddsGame: found, and returned in the pick's orientation
  const g = await resolveOddsGame(SK, PICK_GAME, L);
  check(`${feed}: event found`, g?.id, "aub-nd");
  check(`${feed}: returned in the pick's orientation (home = Auburn)`, [g?.homeTeam, g?.awayTeam], [AUB, ND]);

  // --- Moneyline
  check(`${feed}: ML on Auburn (home) = Auburn's -150`, (await findMarketPricePoint(SK, PICK_GAME, "MONEYLINE", "home", { line: null, period: FG }, L))?.price, -150);
  check(`${feed}: ML on Notre Dame (away) = Notre Dame's +126`, (await findMarketPricePoint(SK, PICK_GAME, "MONEYLINE", "away", { line: null, period: FG }, L))?.price, 126);
  check(`${feed}: favored side = HOME (Auburn), in the pick's orientation`, await findFavoredSide(SK, PICK_GAME, L), "HOME");

  // --- Spread: the sign follows the team
  check(`${feed}: Auburn -3.5 (home) = -102`, (await findMarketPricePoint(SK, PICK_GAME, "SPREAD", "home", { line: -3.5, period: FG }, L))?.price, -102);
  check(`${feed}: Notre Dame +3.5 (away) = -120`, (await findMarketPricePoint(SK, PICK_GAME, "SPREAD", "away", { line: 3.5, period: FG }, L))?.price, -120);
  // Auburn +3.5 is not a line on the board (Auburn is -3.5): no price, never Notre Dame's +3.5 price.
  check(`${feed}: Auburn +3.5 (wrong sign for Auburn) -> no price`, await findMarketPricePoint(SK, PICK_GAME, "SPREAD", "home", { line: 3.5, period: FG }, L), null);
  check(`${feed}: Notre Dame -3.5 (wrong sign for Notre Dame) -> no price`, await findMarketPricePoint(SK, PICK_GAME, "SPREAD", "away", { line: -3.5, period: FG }, L), null);
  check(`${feed}: home spread line = Auburn's -3.5`, await findMarketSpreadLine(SK, PICK_GAME, "home", L), -3.5);
  check(`${feed}: away spread line = Notre Dame's +3.5`, await findMarketSpreadLine(SK, PICK_GAME, "away", L), 3.5);

  // --- Game total: side-free, unchanged by orientation
  check(`${feed}: Over 151.5 = -115`, (await findMarketPricePoint(SK, PICK_GAME, "TOTAL", "over", { line: 151.5, period: FG }, L))?.price, -115);
  check(`${feed}: Under 151.5 = -105`, (await findMarketPricePoint(SK, PICK_GAME, "TOTAL", "under", { line: 151.5, period: FG }, L))?.price, -105);
  check(`${feed}: total line = 151.5`, await findMarketTotalLine(SK, PICK_GAME, "over", L), 151.5);

  // --- Team total: outcomes keyed by team (description), so the resolved game's home team's
  // team-total is Auburn's in both orientations. (The importer does not price TEAM_TOTAL picks
  // from the feed today; this pins that the resolved game keeps them with the right team.)
  const tt = (team: string | undefined, side: "Over" | "Under") =>
    g?.bookmakers[0].markets.find((m) => m.key === "team_totals")?.outcomes.find((o) => o.description === team && o.name === side);
  check(`${feed}: home team total (Auburn) Under 78.5 = -108`, [tt(g?.homeTeam, "Under")?.point, tt(g?.homeTeam, "Under")?.price], [78.5, -108]);
  check(`${feed}: away team total (Notre Dame) Under 73.5 = -102`, [tt(g?.awayTeam, "Under")?.point, tt(g?.awayTeam, "Under")?.price], [73.5, -102]);
}

// ============================================================================
// Wrong-team guard: the bug this fix could introduce is matching a reversed listing WITHOUT
// mirroring it, so side "home" reads the feed's home team. Proven directly: the raw reversed
// listing's home outcome is Notre Dame's price - the value the pick on Auburn must never get.
// ============================================================================
console.log("\n########## wrong-team guard ##########");
{
  const raw = listing(ND, AUB);
  const rawHomeMl = raw.bookmakers[0].markets[0].outcomes.find((o) => o.name === raw.homeTeam)?.price;
  check("unmirrored reversed listing: 'home' would be Notre Dame's +126 (the wrong-team price)", rawHomeMl, 126);
  const L = loaderOf([raw]);
  const aubMl = (await findMarketPricePoint(SK, PICK_GAME, "MONEYLINE", "home", { line: null, period: FG }, L))?.price;
  check("pick on Auburn (home) over a reversed listing is NOT priced at Notre Dame's +126", aubMl !== 126, true);
  check("...it is Auburn's own -150", aubMl, -150);
  const aubSpread = (await findMarketPricePoint(SK, PICK_GAME, "SPREAD", "home", { line: -3.5, period: FG }, L))?.price;
  check("Auburn -3.5 over a reversed listing is not Notre Dame's -120", aubSpread !== -120 && aubSpread === -102, true);

  // mirrorOddsGame moves only the two team fields and leaves the original untouched.
  const m = mirrorOddsGame(raw);
  check("mirrorOddsGame swaps home/away", [m.homeTeam, m.awayTeam], [AUB, ND]);
  check("mirrorOddsGame keeps id and bookmakers", [m.id, m.bookmakers === raw.bookmakers], [raw.id, true]);
  check("mirrorOddsGame does not mutate its input", [raw.homeTeam, raw.awayTeam], [ND, AUB]);
}

// ============================================================================
// Names spelled differently across feeds AND reversed: Hawai'i / Washington State 2026-11-18.
// ESPN: home "Hawai'i Rainbow Warriors", away "Washington State Cougars"; Odds API: home
// "Washington St Cougars", away "Hawai'i Rainbow Warriors". Real DraftKings h2h: Hawai'i -120, WSU +100.
// ============================================================================
console.log("\n########## flipped + NCAAB 'State' -> 'St' spelling ##########");
{
  const HAW = "Hawai'i Rainbow Warriors";
  const WSU_ODDS = "Washington St Cougars";
  const ev: OddsGame = {
    id: "wsu-haw",
    sportKey: SK,
    homeTeam: WSU_ODDS,
    awayTeam: HAW,
    commenceTime: START,
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: HAW, price: -120 }, { name: WSU_ODDS, price: 100 }] }] }],
  };
  const game = { homeTeam: HAW, awayTeam: "Washington State Cougars", commenceTime: START };
  check("Hawai'i ML (pick home) = -120", (await findMarketPricePoint(SK, game, "MONEYLINE", "home", { line: null, period: FG }, loaderOf([ev])))?.price, -120);
  check("Washington State ML (pick away) = +100", (await findMarketPricePoint(SK, game, "MONEYLINE", "away", { line: null, period: FG }, loaderOf([ev])))?.price, 100);
}

// ============================================================================
// Orientation choice when both listings exist.
// ============================================================================
console.log("\n########## both orientations listed ##########");
{
  // Home-and-home series: same teams, opposite home, two days apart. Nearest start wins, so each
  // pick gets its own game's event - not "whichever orientation matches".
  const mon = { ...listing(ND, AUB, "mon"), commenceTime: "2099-11-17T00:00:00Z" };
  const wed = { ...listing(AUB, ND, "wed"), commenceTime: "2099-11-19T00:00:00Z" };
  const L = loaderOf([mon, wed]);
  check("pick on Wednesday's game (Auburn home) -> Wednesday's event", (await resolveOddsGame(SK, { ...PICK_GAME, commenceTime: "2099-11-19T00:00:00Z" }, L))?.id, "wed");
  const monPick = await resolveOddsGame(SK, { homeTeam: ND, awayTeam: AUB, commenceTime: "2099-11-17T00:00:00Z" }, L);
  check("pick on Monday's game (Notre Dame home) -> Monday's event, unmirrored", [monPick?.id, monPick?.homeTeam], ["mon", ND]);

  // Same start time in both orientations (a duplicated feed event): the same-orientation one wins.
  const L2 = loaderOf([listing(ND, AUB, "rev"), listing(AUB, ND, "same")]);
  check("tie on start time -> same-orientation listing kept", (await resolveOddsGame(SK, PICK_GAME, L2))?.id, "same");
}

// ============================================================================
// Unrelated games still never match.
// ============================================================================
console.log("\n########## non-matches ##########");
{
  const other = { ...listing("Duke Blue Devils", ND, "other") };
  check("one shared team only -> no event", await resolveOddsGame(SK, PICK_GAME, loaderOf([other])), null);
  check("one shared team only -> no ML price", await findMarketPricePoint(SK, PICK_GAME, "MONEYLINE", "home", { line: null, period: FG }, loaderOf([other])), null);
}

// ============================================================================
// NHL 3-way moneyline (regulation): priced by team name off the resolved game's home/away.
// ============================================================================
console.log("\n########## NHL 3-way, flipped ##########");
{
  const NHL = "icehockey_nhl";
  const A = "Boston Bruins";
  const B = "Toronto Maple Leafs";
  const ev: OddsGame = {
    id: "nhl-3w",
    sportKey: NHL,
    homeTeam: B, // feed lists Toronto home
    awayTeam: A,
    commenceTime: START,
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "h2h_3_way", outcomes: [{ name: A, price: 150 }, { name: B, price: 160 }, { name: "Draw", price: 300 }] }] }],
  };
  const game = { homeTeam: A, awayTeam: B, commenceTime: START }; // pick feed says Boston home
  check("3-way HOME (Boston) = Boston's +150", await resolveThreeWayOdds(NHL, game, "HOME", loaderOf([ev])), 150);
  check("3-way AWAY (Toronto) = Toronto's +160", await resolveThreeWayOdds(NHL, game, "AWAY", loaderOf([ev])), 160);
  check("3-way DRAW unchanged = +300", await resolveThreeWayOdds(NHL, game, "DRAW", loaderOf([ev])), 300);
}

}

main().then(() => {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
});

