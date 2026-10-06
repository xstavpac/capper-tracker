// Proof for capper-name collisions in catalog import. Run with:
//   npx tsx src/lib/capper-name-collision-acceptance-test.ts
//
// The bug (production skip log, 2026-10): a saved capper named "Tampa Bay
// Rays" made parseCatalog strip that prefix from "Tampa Bay Rays Moneyline",
// leaving "Moneyline", which was then discarded without a trace - and "Tampa
// Bay Rays vs Yankees ML" imported as that capper's Yankees pick. The same
// prefix read swallowed new capper headers ("Sharp University" under a saved
// SHARP) and abbreviations ("UNC +21.5" under a saved UNC), and a bare player
// name ("James Cook") became a capper header.
//
// Pure: no network, no database.
import { parseCatalog, isTeamPhrase } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { buildFeedTeams } from "@/lib/feed-teams";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const SAVED = ["Tampa Bay Rays", "SHARP", "UNC", "BET LABS", "AFS", "Gold Mine", "Porter Picks", "Sharp Sam", "Marshall", "Rays", "TBL", "Tampa Bay", "KC", "Weber State", "James Cook"];
const ROSTER: RosterPlayer[] = [
  { playerName: "James Cook", firstName: "James", lastName: "Cook", team: "Buffalo Bills", position: "RB", externalPlayerId: "1" },
  { playerName: "Josh Allen", firstName: "Josh", lastName: "Allen", team: "Buffalo Bills", position: "QB", externalPlayerId: "2" },
];
const ROSTER_NAMES = ROSTER.map((p) => p.playerName);
const FEED = buildFeedTeams("NCAAF", [
  { homeTeam: "Weber State Wildcats", awayTeam: "Idaho Vandals", homeLocation: "Weber State", awayLocation: "Idaho" },
]);

type Summary = { picks: [string, string, string, string, string[]][]; unresolved: [string, string][]; silent: string[] };
function run(paste: string, saved: string[] = SAVED, roster: string[] | null = ROSTER_NAMES): Summary {
  const out = parseCatalog(paste, saved, roster ?? undefined, FEED);
  return {
    picks: out.picks.map((p) => [p.capperName, p.sportName, p.betType, p.description, p.teamNicknames]),
    unresolved: out.unresolved.map((u, i) => [out.unresolvedCapperNames[i], u]),
    silent: out.droppedAsHeaders.map((d) => d.text),
  };
}
const only = (picks: Summary["picks"], unresolved: Summary["unresolved"] = []): Summary => ({ picks, unresolved, silent: [] });

// ---- 1. Team phrases beat capper prefixes ----
expect(
  '"Tampa Bay Rays Moneyline" is the Rays moneyline for the active capper',
  run("Porter Picks\nTampa Bay Rays Moneyline"),
  only([["Porter Picks", "MLB", "MONEYLINE", "Tampa Bay Rays Moneyline", ["rays"]]])
);
expect(
  '"Tampa Bay Rays +1.5" is the Rays spread for the active capper',
  run("Porter Picks\nTampa Bay Rays +1.5"),
  only([["Porter Picks", "MLB", "SPREAD", "Tampa Bay Rays +1.5", ["rays"]]])
);
expect(
  '"Tampa Bay Rays vs Yankees ML" keeps both teams and is not credited to the "Tampa Bay Rays" capper',
  run("Porter Picks\nTampa Bay Rays vs Yankees ML"),
  only([["Porter Picks", "MLB", "MONEYLINE", "Tampa Bay Rays vs Yankees ML", ["yankees", "rays"]]])
);
expect(
  "the same line right after a blank line still parses as the bet",
  run("Porter Picks\nYankees ML\n\nTampa Bay Rays Moneyline"),
  only([
    ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["Porter Picks", "MLB", "MONEYLINE", "Tampa Bay Rays Moneyline", ["rays"]],
  ])
);
expect('nickname capper: "Rays ML"', run("Porter Picks\nRays ML"), only([["Porter Picks", "MLB", "MONEYLINE", "Rays ML", ["rays"]]]));
expect('abbreviation capper: "TBL -1.5"', run("Porter Picks\nTBL -1.5"), only([["Porter Picks", "NHL", "SPREAD", "TBL -1.5", ["tbl"]]]));
expect(
  'B. NCAAF alias capper: "UNC +21.5" is the North Carolina spread',
  run("Porter Picks\nUNC +21.5"),
  only([["Porter Picks", "NCAAF", "SPREAD", "UNC +21.5", ["unc"]]])
);
expect(
  'feed-derived (FCS) team capper: "Weber State -14.5"',
  run("Porter Picks\nWeber State -14.5"),
  only([["Porter Picks", "NCAAF", "SPREAD", "Weber State -14.5", ["weber state wildcats"]]])
);
{
  const out = parseCatalog("Porter Picks\nTampa Bay ML", SAVED, ROSTER_NAMES, FEED);
  expect(
    'city-key capper: "Tampa Bay ML" asks which Tampa Bay team, for the active capper',
    out.picks.map((p) => [p.capperName, p.ambiguousKey, p.description]),
    [["Porter Picks", "tampa", "Tampa Bay ML"]]
  );
}

// The capper prefix is retried when the leading team is not part of the bet.
expect(
  '"Marshall: Yankees ML" (Marshall is NCAAF, the bet is MLB) is still Marshall\'s pick, as on main',
  run("Porter Picks\nMarshall: Yankees ML"),
  only([["Marshall", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]]])
);
expect(
  '"Tampa Bay Rays Lakers -3" (the Rays are not in an NBA bet) is the "Tampa Bay Rays" capper\'s pick',
  run("Porter Picks\nTampa Bay Rays Lakers -3"),
  only([["Tampa Bay Rays", "NBA", "SPREAD", "Lakers -3", ["lakers"]]])
);

// ---- 2. No silent discards ----
expect(
  "text after a saved capper's name that resolves to nothing is unresolved under that capper",
  run("Sharp Sam Some Guy 2+ wins"),
  only([], [["Sharp Sam", "Sharp Sam Some Guy 2+ wins"]])
);
expect(
  'a bare line after an abbreviation-shaped capper ("KC -3") is unresolved under the ACTIVE capper',
  run("Porter Picks\nKC -3"),
  only([], [["Porter Picks", "KC -3"]])
);
expect("parseCatalog no longer returns droppedInline", "droppedInline" in parseCatalog("SHARP Foo 2+ wins", SAVED), false);

// ---- 3. A bare team-name line is never a capper header ----
expect(
  'bare "Tampa Bay Rays" inside a block is the Rays moneyline, as it is for an unsaved name on main',
  run("Porter Picks\nTampa Bay Rays"),
  only([["Porter Picks", "MLB", "MONEYLINE", "Tampa Bay Rays", ["rays"]]])
);
expect(
  'bare "Tampa Bay Rays" opening a block is unresolved; the next pick stays with the active capper',
  run("Porter Picks\nYankees ML\n\nTampa Bay Rays\nDodgers ML"),
  only(
    [
      ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
      ["Porter Picks", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
    ],
    [["Porter Picks", "Tampa Bay Rays"]]
  )
);
expect(
  "same for a team name nobody has saved",
  run("Porter Picks\nYankees ML\n\nSeattle Mariners\nDodgers ML", []),
  only(
    [
      ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
      ["Porter Picks", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
    ],
    [["Porter Picks", "Seattle Mariners"]]
  )
);
expect(
  'the "*Name" escape still heads a block with a team-named capper',
  run("Porter Picks\nYankees ML\n\n*Tampa Bay Rays\nDodgers ML"),
  only([
    ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["Tampa Bay Rays", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
  ])
);
expect(
  'the "*Name" escape works for a new team-named capper too',
  run("*Seattle Mariners\nDodgers ML", []),
  only([["Seattle Mariners", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]]])
);

// ---- A. A new capper header is not swallowed by a shorter saved capper ----
for (const header of ["Sharp University", "Sharp Investments", "BET LABS North", "AFS North", "Gold Mine Card"]) {
  expect(
    `"${header}" is a new capper header, and its pick is credited to it`,
    run(`Porter Picks\nYankees ML\n\n${header}\nDodgers ML`),
    only([
      ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
      [header, "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
    ])
  );
}
expect(
  'a saved capper\'s name plus a section label ("SHARP Best Bets") is that capper\'s header',
  run("Porter Picks\nYankees ML\n\nSHARP Best Bets\nDodgers ML"),
  only([
    ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["SHARP", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
  ])
);

// ---- C. A bare player name is never a capper header ----
{
  const paste = "Porter Picks\nYankees ML\nJames Cook\nTouchdown";
  expect(
    '"James Cook" / "Touchdown" are read as one line, parked for the roster pass under the active capper',
    run(paste),
    only([["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]]], [["Porter Picks", "James Cook Touchdown"]])
  );
  const out = parseCatalog(paste, SAVED, ROSTER_NAMES, FEED);
  const recovered = recoverUnresolvedLines(out.unresolved, out.unresolvedCapperNames, [], ROSTER, out.picks);
  expect(
    "the roster pass turns it into one NFL touchdown pick",
    [recovered.recovered.map((p) => [p.capperName, p.sportName, p.betType, p.description, p.teamNicknames]), recovered.stillUnresolved],
    [[["Porter Picks", "NFL", "PLAYER_PROP", "James Cook Touchdown", ["buffalo bills"]]], []]
  );
}
expect(
  "a yardage market on the next line joins the same way",
  run("Porter Picks\nJosh Allen\nOver 225.5 Passing Yards", []).unresolved,
  [["Porter Picks", "Josh Allen Over 225.5 Passing Yards"]]
);
expect(
  '"James Cook" with no market line after it is unresolved; the next pick stays with the active capper',
  run("Porter Picks\nYankees ML\nJames Cook\nDodgers ML"),
  only(
    [
      ["Porter Picks", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
      ["Porter Picks", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
    ],
    [["Porter Picks", "James Cook"]]
  )
);
expect(
  'one-line "James Cook Touchdown" under a saved "James Cook" capper is parked under the active capper',
  run("Porter Picks\nJames Cook Touchdown").unresolved,
  [["Porter Picks", "James Cook Touchdown"]]
);
expect(
  "with no roster available a bare name is still read as a header (nothing identifies it as a player)",
  run("Porter Picks\nYankees ML\n\nJosh Allen\nDodgers ML", [], null).picks.map((p) => p[0]),
  ["Porter Picks", "Josh Allen"]
);

// ---- Controls: unchanged from main ----
expect(
  "normal capper headers, each followed by bets",
  run("Bambino Bets\nYankees ML\nDodgers -1.5\n\nVegas John\nCubs ML (2u)", []),
  only([
    ["Bambino Bets", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["Bambino Bets", "MLB", "SPREAD", "Dodgers -1.5", ["dodgers"]],
    ["Vegas John", "MLB", "MONEYLINE", "Cubs ML", ["cubs"]],
  ])
);
expect(
  "a saved capper's header line, then bets",
  run("SHARP\nYankees ML\n\nPorter Picks\nDodgers ML"),
  only([
    ["SHARP", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["Porter Picks", "MLB", "MONEYLINE", "Dodgers ML", ["dodgers"]],
  ])
);
expect(
  'a saved capper\'s inline picks ("SHARP Yankees ML", "SHARP: Dodgers -1.5 (2u)", "SHARP - Cubs Over 8.5")',
  run("Porter Picks\nSHARP Yankees ML\nSHARP: Dodgers -1.5 (2u)\nSHARP - Cubs Over 8.5"),
  only([
    ["SHARP", "MLB", "MONEYLINE", "Yankees ML", ["yankees"]],
    ["SHARP", "MLB", "SPREAD", "Dodgers -1.5", ["dodgers"]],
    ["SHARP", "MLB", "TOTAL", "Cubs Over 8.5", ["cubs"]],
  ])
);
expect(
  'a saved capper followed by a bare team ("SHARP Tampa Bay Rays") is that capper\'s moneyline',
  run("Porter Picks\nSHARP Tampa Bay Rays", ["SHARP", "Porter Picks"]),
  only([["SHARP", "MLB", "MONEYLINE", "Tampa Bay Rays", ["rays"]]])
);
expect(
  'a new header that merely contains a nickname ("Tigers Kitchen") is still a header after a blank line',
  run("Porter Picks\nYankees ML\n\nTigers Kitchen\nDodgers ML", []).picks.map((p) => p[0]),
  ["Porter Picks", "Tigers Kitchen"]
);
expect(
  "an inline unsupported prop stays unresolved under the inline capper",
  run("Porter Picks\nSHARP NHL Brady Tkachuk over 3.5 hits").unresolved,
  [["SHARP", "SHARP NHL Brady Tkachuk over 3.5 hits"]]
);
expect(
  "pick-shaped line with no team is unresolved; a section label is skipped",
  run("Porter Picks\nFull Card\nFoo Bar over 3.5", []),
  only([], [["Porter Picks", "Foo Bar over 3.5"]])
);

// ---- isTeamPhrase (also drives scripts/report-team-named-cappers.ts) ----
for (const name of ["Tampa Bay Rays", "Rays", "rays", "The Rays", "Tampa Bay", "TBL", "UNC", "Dbacks", "RedSox", "LA Dodgers", "NY Yankees", "New Jersey Devils", "North Carolina Tar Heels", "St Louis Cardinals", "Miami (OH)", "Texas A&M"]) {
  expect(`isTeamPhrase("${name}")`, isTeamPhrase(name), true);
}
for (const name of ["SHARP", "Sharp University", "Porter Picks", "Tigers Kitchen", "Wild West", "North Stars", "Rays Fan", "James Cook", "Weber State", ""]) {
  expect(`isTeamPhrase("${name}") is false`, isTeamPhrase(name), false);
}
expect("isTeamPhrase reads the game feed: full name", isTeamPhrase("Weber State Wildcats", FEED), true);
expect("isTeamPhrase reads the game feed: school", isTeamPhrase("Weber State", FEED), true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
