// Picks must reach their /live card when the two feeds spell a team
// differently - run with:
//   npx tsx src/server/data/live-picks-cross-source-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// A pick's homeTeam/awayTeam are stored as the feed that resolved it at import
// spelled them - normally ESPN's score feed. A /live card is an Odds API game.
// matchPicksToGame joined the two with ===, then fell back to a nickname text
// search that compared un-folded text, so for a team the feeds spell
// differently the pick existed but was on no card:
//   - "App State Mountaineers" vs the card's "Appalachian State Mountaineers"
//     (different words - needs the league's alias row)
//   - "Louisiana Ragin' Cajuns" / "Hawai'i Rainbow Warriors" vs the card's
//     apostrophe-less spelling
//   - "San José State Spartans" vs the card's unaccented spelling
//
// Part 3 covers the other direction, at import: finding a pick's game when
// only the Odds API lists it yet (resolveGameForNickname / resolveGameForTeams).
//
// Team spellings are the real ones, read off both feeds on 2026-10-12.

import { matchPicksToGame } from "./picks";
import { resolveGameForNickname, resolveGameForTeams } from "./odds";
import type { OddsGame } from "./odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const AT = "2026-10-17T23:00:00Z";

type Pick = { homeTeam: string; awayTeam: string; betDetail: string | null; gameTime: Date };
const pick = (homeTeam: string, awayTeam: string, betDetail: string | null, iso: string = AT): Pick => ({
  homeTeam,
  awayTeam,
  betDetail,
  gameTime: new Date(iso),
});
const card = (homeTeam: string, awayTeam: string, iso: string = AT) => ({ homeTeam, awayTeam, commenceTime: new Date(iso) });
const details = (picks: Pick[]) => picks.map((p) => p.betDetail);

// Each matchup: the pick side as ESPN spells it, the card as The Odds API does.
// betDetail is what the capper typed - it usually names one team or neither.
const MATCHUPS = [
  {
    name: "Old Dominion @ App State",
    espn: { home: "App State Mountaineers", away: "Old Dominion Monarchs" },
    odds: { home: "Appalachian State Mountaineers", away: "Old Dominion Monarchs" },
    bets: ["App State -3.5", "Old Dominion +3.5", "ODU ML", "Over 54.5", null],
  },
  {
    name: "Louisiana @ Louisiana Tech",
    espn: { home: "Louisiana Tech Bulldogs", away: "Louisiana Ragin' Cajuns" },
    odds: { home: "Louisiana Tech Bulldogs", away: "Louisiana Ragin Cajuns" },
    bets: ["Louisiana +6.5", "Louisiana Tech -6.5", "La Tech ML", "Under 49", null],
  },
  {
    name: "Hawaii @ Arizona State",
    espn: { home: "Arizona State Sun Devils", away: "Hawai'i Rainbow Warriors" },
    odds: { home: "Arizona State Sun Devils", away: "Hawaii Rainbow Warriors" },
    bets: ["Hawaii +21", "Arizona State -21", "ASU 1H -10.5", "Over 58", null],
  },
  {
    name: "Wyoming @ San José State",
    espn: { home: "San José State Spartans", away: "Wyoming Cowboys" },
    odds: { home: "San Jose State Spartans", away: "Wyoming Cowboys" },
    bets: ["Wyoming +2.5", "San Jose State -2.5", "SJSU ML", "Under 44.5", null],
  },
];

console.log("\n########## 1. ESPN-spelled picks appear on the Odds-API-spelled card ##########");

for (const m of MATCHUPS) {
  const picks = m.bets.map((b) => pick(m.espn.home, m.espn.away, b));
  const onCard = matchPicksToGame(picks, card(m.odds.home, m.odds.away), "NCAAF");
  expect(`${m.name}: all ${picks.length} picks are on the card`, details(onCard), m.bets);

  // The same picks must not spill onto any of the other three cards.
  for (const other of MATCHUPS) {
    if (other === m) continue;
    expect(
      `${m.name}: none of them are on the ${other.name} card`,
      matchPicksToGame(picks, card(other.odds.home, other.odds.away), "NCAAF").length,
      0
    );
  }

  // And a pick already stored with the Odds API's spelling still matches as before.
  expect(`${m.name}: an Odds-API-spelled pick is still on the card`,
    matchPicksToGame([pick(m.odds.home, m.odds.away, "Over 50")], card(m.odds.home, m.odds.away), "NCAAF").length, 1);

  // The time window still applies: same teams a week later is another game.
  expect(`${m.name}: a pick on the same matchup a week earlier is not on the card`,
    matchPicksToGame([pick(m.espn.home, m.espn.away, "Over 50", "2026-10-10T23:00:00Z")], card(m.odds.home, m.odds.away), "NCAAF").length, 0);
}

console.log("\n########## 1b. free-text picks: the nickname fallback folds accents and apostrophes ##########");

{
  // No resolved teams at all - only what the capper typed, punctuation included.
  const freeText = (betDetail: string) => pick("", "", betDetail);
  expect("'Hawai'i +21 vs Arizona State' finds the Hawaii @ Arizona State card",
    matchPicksToGame([freeText("Hawai'i +21 vs Arizona State")], card("Arizona State Sun Devils", "Hawaii Rainbow Warriors"), "NCAAF").length, 1);
  expect("'San José State -2.5 vs Wyoming' finds the Wyoming @ San Jose State card",
    matchPicksToGame([freeText("San José State -2.5 vs Wyoming")], card("San Jose State Spartans", "Wyoming Cowboys"), "NCAAF").length, 1);
  expect("'Ragin' Cajuns +6.5 at Louisiana Tech' finds the Louisiana @ Louisiana Tech card",
    matchPicksToGame([freeText("Ragin' Cajuns +6.5 at Louisiana Tech")], card("Louisiana Tech Bulldogs", "Louisiana Ragin Cajuns"), "NCAAF").length, 1);
  // The card itself ESPN-spelled (a schedule-sourced card) and plain text.
  expect("plain 'San Jose State -2.5 vs Wyoming' finds an accented 'San José State' card",
    matchPicksToGame([freeText("San Jose State -2.5 vs Wyoming")], card("San José State Spartans", "Wyoming Cowboys"), "NCAAF").length, 1);
  expect("plain 'Hawaii +21 vs Arizona State' finds an apostrophe 'Hawai'i' card",
    matchPicksToGame([freeText("Hawaii +21 vs Arizona State")], card("Arizona State Sun Devils", "Hawai'i Rainbow Warriors"), "NCAAF").length, 1);
  // Still needs BOTH teams.
  expect("'Hawai'i +21' alone (one team) does not latch onto the card",
    matchPicksToGame([freeText("Hawai'i +21")], card("Arizona State Sun Devils", "Hawaii Rainbow Warriors"), "NCAAF").length, 0);
}

console.log("\n########## 2. Louisiana and Louisiana Tech never match each other ##########");

{
  // Three Louisiana schools, three different games, same kickoff.
  const cajunsGame = { espn: card("Louisiana Ragin' Cajuns", "Troy Trojans"), odds: card("Louisiana Ragin Cajuns", "Troy Trojans") };
  const techGame = { espn: card("Louisiana Tech Bulldogs", "UTEP Miners"), odds: card("Louisiana Tech Bulldogs", "UTEP Miners") };
  const monroeGame = { espn: card("UL Monroe Warhawks", "Texas State Bobcats"), odds: card("UL Monroe Warhawks", "Texas State Bobcats") };

  const cajunsPicks = [pick("Louisiana Ragin' Cajuns", "Troy Trojans", "Louisiana -3"), pick("Louisiana Ragin' Cajuns", "Troy Trojans", "Over 51")];
  const techPicks = [pick("Louisiana Tech Bulldogs", "UTEP Miners", "Louisiana Tech -7"), pick("Louisiana Tech Bulldogs", "UTEP Miners", "Under 47")];
  const monroePicks = [pick("UL Monroe Warhawks", "Texas State Bobcats", "ULM +10")];
  const all = [...cajunsPicks, ...techPicks, ...monroePicks];

  expect("Louisiana's card gets only Louisiana's picks", details(matchPicksToGame(all, cajunsGame.odds, "NCAAF")), ["Louisiana -3", "Over 51"]);
  expect("Louisiana Tech's card gets only Louisiana Tech's picks", details(matchPicksToGame(all, techGame.odds, "NCAAF")), ["Louisiana Tech -7", "Under 47"]);
  expect("UL Monroe's card gets only UL Monroe's picks", details(matchPicksToGame(all, monroeGame.odds, "NCAAF")), ["ULM +10"]);

  // Same opponent on both cards, so only the Louisiana side tells them apart.
  const vsTroyCajuns = card("Louisiana Ragin Cajuns", "Troy Trojans");
  const vsTroyTech = card("Louisiana Tech Bulldogs", "Troy Trojans");
  expect("a Louisiana pick is not on a Louisiana Tech card with the same opponent",
    matchPicksToGame([pick("Louisiana Ragin' Cajuns", "Troy Trojans", "Louisiana -3")], vsTroyTech, "NCAAF").length, 0);
  expect("a Louisiana Tech pick is not on a Louisiana card with the same opponent",
    matchPicksToGame([pick("Louisiana Tech Bulldogs", "Troy Trojans", "Louisiana Tech -3")], vsTroyCajuns, "NCAAF").length, 0);
  expect("a UL Monroe pick is not on a Louisiana card with the same opponent",
    matchPicksToGame([pick("UL Monroe Warhawks", "Troy Trojans", "ULM +3")], vsTroyCajuns, "NCAAF").length, 0);
  expect("free text 'Louisiana Tech -3 vs Troy' is not on the Louisiana card",
    matchPicksToGame([pick("", "", "Louisiana Tech -3 vs Troy")], vsTroyCajuns, "NCAAF").length, 0);
  expect("free text 'Louisiana -3 vs Troy' is not on the Louisiana Tech card",
    matchPicksToGame([pick("", "", "Louisiana -3 vs Troy")], vsTroyTech, "NCAAF").length, 0);

  // When they actually play each other, the one card takes the picks on that game and no others.
  const headToHead = card("Louisiana Tech Bulldogs", "Louisiana Ragin Cajuns");
  expect("Louisiana @ Louisiana Tech: picks on the other two Louisiana games stay off the card",
    matchPicksToGame(all, headToHead, "NCAAF").length, 0);
}

{
  // The alias rows are NCAAF's: under another league's label they do nothing.
  const p = [pick("App State Mountaineers", "Old Dominion Monarchs", "Over 54.5")];
  const c = card("Appalachian State Mountaineers", "Old Dominion Monarchs");
  expect("App State alias applies to an NCAAF card", matchPicksToGame(p, c, "NCAAF").length, 1);
  expect("...not under the NFL label", matchPicksToGame(p, c, "NFL").length, 0);
}

async function importSide() {
  console.log("\n########## 3. import: a nickname finds its game in either feed's spelling ##########");

  // Score feed empty (the game is days out), so resolution falls through to
  // the odds feed - whose games are Odds-API-spelled.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ events: [] }), { status: 200 })) as typeof fetch;
  try {
    const referenceTime = new Date("2026-10-14T16:00:00Z");
    const og = (id: string, homeTeam: string, awayTeam: string): OddsGame =>
      ({ id, sportKey: "americanfootball_ncaaf", homeTeam, awayTeam, commenceTime: AT, bookmakers: [] }) as OddsGame;
    const board = [
      og("odu-app", "Appalachian State Mountaineers", "Old Dominion Monarchs"),
      og("ul-latech", "Louisiana Tech Bulldogs", "Louisiana Ragin Cajuns"),
      og("haw-asu", "Arizona State Sun Devils", "Hawaii Rainbow Warriors"),
      og("wyo-sjsu", "San Jose State Spartans", "Wyoming Cowboys"),
      og("ulm-txst", "Texas State Bobcats", "UL Monroe Warhawks"),
    ];
    const opts = { referenceTime, getOdds: async () => board };
    const NCAAF = "americanfootball_ncaaf";

    // The nicknames are what the catalog parser hands over: the score feed's
    // full name, lowercased (parse-catalog.ts's NCAAF canonical suffix).
    const one = async (nickname: string) => (await resolveGameForNickname(NCAAF, nickname, opts)).game?.id ?? null;
    const two = async (a: string, b: string) => (await resolveGameForTeams(NCAAF, a, b, opts)).game?.id ?? null;

    expect("'app state mountaineers' -> the Appalachian State game", await one("app state mountaineers"), "odu-app");
    expect("'hawai'i rainbow warriors' -> the Hawaii game", await one("hawai'i rainbow warriors"), "haw-asu");
    expect("'san josé state spartans' -> the San Jose State game", await one("san josé state spartans"), "wyo-sjsu");
    expect("'louisiana ragin' cajuns' -> the Louisiana game (it is the away side of the Tech card)", await one("louisiana ragin' cajuns"), "ul-latech");
    expect("'ul monroe warhawks' -> UL Monroe's own game, not a Louisiana one", await one("ul monroe warhawks"), "ulm-txst");

    expect("two teams: app state + old dominion", await two("app state mountaineers", "old dominion monarchs"), "odu-app");
    expect("two teams: louisiana + louisiana tech", await two("louisiana ragin' cajuns", "louisiana tech bulldogs"), "ul-latech");
    expect("two teams: hawai'i + arizona state", await two("arizona state sun devils", "hawai'i rainbow warriors"), "haw-asu");
    expect("two teams: wyoming + san josé state", await two("wyoming cowboys", "san josé state spartans"), "wyo-sjsu");

    // Louisiana must not be found through Louisiana Tech (or the reverse).
    const techOnly = { referenceTime, getOdds: async () => [og("latech-utep", "Louisiana Tech Bulldogs", "UTEP Miners")] };
    expect("'louisiana ragin' cajuns' with only a Louisiana Tech game posted -> no game",
      (await resolveGameForNickname(NCAAF, "louisiana ragin' cajuns", techOnly)).game, null);
    const cajunsOnly = { referenceTime, getOdds: async () => [og("ul-troy", "Louisiana Ragin Cajuns", "Troy Trojans")] };
    expect("'louisiana tech bulldogs' with only a Louisiana game posted -> no game",
      (await resolveGameForNickname(NCAAF, "louisiana tech bulldogs", cajunsOnly)).game, null);
    expect("'ul monroe warhawks' with only a Louisiana game posted -> no game",
      (await resolveGameForNickname(NCAAF, "ul monroe warhawks", cajunsOnly)).game, null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

importSide()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
    if (failures > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
