// Proof for classifyPickTeamGroup/shortTeamName - run with:
//   npx tsx src/lib/pick-team-group-acceptance-test.ts
//
// Written for the Twins/Tigers misgrouping bug: real live-page catalog
// picks against Twins and Tigers moneylines were landing under "Totals &
// Other Markets" instead of their own team header, while the same bet
// shape for Braves/Mets/Pirates/Padres grouped correctly. Root cause was
// the "Disambiguate bare KBO nicknames colliding with MLB/NFL teams" commit
// (d9bfe3c) - it moved twins/tigers/bears/lions/eagles out of the bare
// MLB_TEAMS/NFL_TEAMS lists (correctly, to stop import-time parsing from
// silently guessing which sport a bare "Twins ML" belongs to) but
// classifyPickTeamGroup shared that same lookup (findTeamNickname) for an
// unrelated purpose - matching a KNOWN, unambiguous live-schedule team
// against betDetail text - where the long disambiguated form it started
// returning ("minnesota twins") never appears in betDetail's short form
// ("Twins Moneyline").
//
// The fix is a separate lookup (findGroupingNickname, in parse-catalog.ts)
// used only here, never touching the import-parsing path. PART A proves the
// fix on the exact collision teams; PART B proves the previously-correct
// (non-collision) teams are unaffected; PART C proves the import-parsing
// path this must never touch is still exactly as before by re-asserting the
// same KBO-collision behavior parse-catalog-acceptance-test.ts's PART C
// already covers, from this file's own imports.
import { classifyPickTeamGroup, shortTeamName } from "./pick-team-group";
import { parseCatalog, teamGroupAliases } from "./parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  console.log("\n########## PART A: KBO-collision teams (Twins/Tigers) now group correctly ##########");

  // Real example from the live page: "Braves vs Twins", Twins picks reading
  // "Twins Moneyline - 8-14 (36%) on favorite moneyline picks".
  {
    const game = { homeTeam: "Minnesota Twins", awayTeam: "Atlanta Braves" };
    const group = classifyPickTeamGroup(
      { betType: "MONEYLINE", betDetail: "Twins Moneyline - 8-14 (36%) on favorite moneyline picks" },
      game,
      "MLB"
    );
    check("Twins moneyline (home side) groups HOME, not OTHER", group, "HOME");
    check("shortTeamName('Minnesota Twins') is the short header form", shortTeamName(game.homeTeam, "MLB"), "Twins");
  }

  // Real example: "Tigers Pirates" game, Tigers picks reading "Tigers
  // Moneyline - 0-1 (0%) on underdog moneyline picks".
  {
    const game = { homeTeam: "Pittsburgh Pirates", awayTeam: "Detroit Tigers" };
    const group = classifyPickTeamGroup(
      { betType: "MONEYLINE", betDetail: "Tigers Moneyline - 0-1 (0%) on underdog moneyline picks" },
      game,
      "MLB"
    );
    check("Tigers moneyline (away side) groups AWAY, not OTHER", group, "AWAY");
    check("shortTeamName('Detroit Tigers') is the short header form", shortTeamName(game.awayTeam, "MLB"), "Tigers");
  }

  // Same collision family, spread bet type (also team-tied) and F5/First
  // Half moneyline phrasing seen in the real catalog ("Twins First 5
  // Moneyline - 3-1 (75%)").
  {
    const game = { homeTeam: "Minnesota Twins", awayTeam: "Atlanta Braves" };
    const group = classifyPickTeamGroup(
      { betType: "MONEYLINE", betDetail: "Twins First 5 Moneyline - 3-1 (75%) on first-half moneyline picks" },
      game,
      "MLB"
    );
    check("Twins First 5 Moneyline still groups HOME", group, "HOME");
  }

  console.log("\n########## PART B: previously-correct (non-collision) teams unaffected ##########");

  {
    const game = { homeTeam: "New York Mets", awayTeam: "San Diego Padres" };
    check(
      "Padres moneyline still groups AWAY",
      classifyPickTeamGroup({ betType: "MONEYLINE", betDetail: "Padres Moneyline - 4-13 (24%) on favorite moneyline picks" }, game, "MLB"),
      "AWAY"
    );
    check(
      "Mets moneyline still groups HOME",
      classifyPickTeamGroup({ betType: "MONEYLINE", betDetail: "Mets Moneyline - 0-1 (0%) on underdog moneyline picks" }, game, "MLB"),
      "HOME"
    );
    check(
      "Mets total (not team-tied) still groups OTHER",
      classifyPickTeamGroup({ betType: "TOTAL", betDetail: "Mets Padres Over 8.5 - 1-1 (50%) on over picks" }, game, "MLB"),
      "OTHER"
    );
    check("shortTeamName('San Diego Padres') unaffected", shortTeamName(game.awayTeam, "MLB"), "Padres");
  }

  {
    const game = { homeTeam: "Pittsburgh Pirates", awayTeam: "Detroit Tigers" };
    check(
      "Pirates moneyline still groups HOME",
      classifyPickTeamGroup({ betType: "MONEYLINE", betDetail: "Pirates Moneyline - 1-5 (17%) on favorite moneyline picks" }, game, "MLB"),
      "HOME"
    );
  }

  console.log("\n########## PART C: import-parsing KBO-collision protection untouched ##########");

  // Re-asserts the exact behavior parse-catalog-acceptance-test.ts's PART C
  // already locks in (bare "Twins"/"Tigers"/"Bears" picks with no city stay
  // ambiguous rather than silently guessing MLB/NFL over KBO) - proves the
  // grouping fix didn't reach into the import path findGroupingNickname was
  // deliberately kept separate from.
  {
    const { picks } = parseCatalog("Porter Picks\nTwins ML\nTigers ML\nBears ML", []);
    const twins = picks.find((p) => p.description.toLowerCase().includes("twins"));
    const tigers = picks.find((p) => p.description.toLowerCase().includes("tigers"));
    const bears = picks.find((p) => p.description.toLowerCase().includes("bears"));
    check("bare 'Twins ML' import still ambiguous (MLB vs KBO), not silently guessed", twins?.ambiguousKey, "twins");
    check("bare 'Tigers ML' import still ambiguous (MLB vs KBO), not silently guessed", tigers?.ambiguousKey, "tigers");
    check("bare 'Bears ML' import still ambiguous (NFL vs KBO), not silently guessed", bears?.ambiguousKey, "bears");
  }

  // City-qualified KBO import still resolves directly and unambiguously -
  // the DISAMBIGUATED_TEAMS path this fix never touches.
  {
    const { picks } = parseCatalog("Porter Picks\nLG Twins ML\nKIA Tigers ML", []);
    const lgTwins = picks.find((p) => p.description.toLowerCase().includes("lg"));
    const kiaTigers = picks.find((p) => p.description.toLowerCase().includes("kia"));
    check("'LG Twins ML' import still resolves directly to KBO", lgTwins?.sportName, "KBO");
    check("'KIA Tigers ML' import still resolves directly to KBO", kiaTigers?.sportName, "KBO");
  }

  console.log("\n########## PART D: NCAAF multi-alias schools group under the right team ##########");

  // Reported bug: "Florida International Panthers @ South Florida Bulls" - a
  // "FIU +14.5" spread pick landed in "Totals & other markets" while a
  // "Florida International +14.5" pick on the same game grouped correctly.
  // Root cause: classifyPickTeamGroup derived ONE nickname from the schedule
  // name ("florida international", the longest NCAAF_SCHOOLS key in it) and
  // checked only that against betDetail - the school's other aliases ("fiu"),
  // which the alias table already knows, were invisible. Now it checks the
  // whole alias set (teamGroupAliases).
  {
    const game = { homeTeam: "South Florida Bulls", awayTeam: "Florida International Panthers" };
    check("teamGroupAliases(FIU) is the full set, not just one", teamGroupAliases(game.awayTeam, "NCAAF"), ["florida international", "fiu"]);
    check("teamGroupAliases(USF) is the full set", teamGroupAliases(game.homeTeam, "NCAAF"), ["south florida", "usf"]);
    check("'Florida International +14.5' still groups AWAY", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Florida International +14.5" }, game, "NCAAF"), "AWAY");
    check("'FIU +14.5' NOW groups AWAY (was OTHER)", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "FIU +14.5" }, game, "NCAAF"), "AWAY");
    check("'South Florida -14.5' groups HOME", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "South Florida -14.5" }, game, "NCAAF"), "HOME");
    check("'USF -14.5' NOW groups HOME (was OTHER)", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "USF -14.5" }, game, "NCAAF"), "HOME");
  }

  // The other alias-collision families from the investigation. Each row:
  // game away/home, then [betDetail, expected group] pairs mixing the
  // abbreviation and the full form on both sides.
  {
    const families: {
      game: { homeTeam: string; awayTeam: string };
      picks: [string, "AWAY" | "HOME" | "OTHER"][];
    }[] = [
      {
        // abbreviation misgroups (schedule name carries the full form)
        game: { homeTeam: "Central Michigan Chippewas", awayTeam: "Eastern Michigan Eagles" },
        picks: [
          ["EMU +7", "AWAY"],
          ["Eastern Michigan +7", "AWAY"],
          ["CMU -7", "HOME"],
          ["Central Michigan -7", "HOME"],
        ],
      },
      {
        game: { homeTeam: "James Madison Dukes", awayTeam: "Middle Tennessee Blue Raiders" },
        picks: [
          ["MTSU +10", "AWAY"],
          ["Middle Tennessee +10", "AWAY"],
          ["JMU -10", "HOME"],
          ["James Madison -10", "HOME"],
        ],
      },
      {
        // reverse direction: schedule name carries the abbreviation, capper
        // writes the full form
        game: { homeTeam: "UConn Huskies", awayTeam: "UMass Minutemen" },
        picks: [
          ["Connecticut -7", "HOME"],
          ["UConn -7", "HOME"],
          ["Massachusetts +7", "AWAY"],
          ["UMass +7", "AWAY"],
        ],
      },
    ];
    for (const f of families) {
      for (const [betDetail, expected] of f.picks) {
        check(
          `'${betDetail}' on ${f.game.awayTeam} @ ${f.game.homeTeam} -> ${expected}`,
          classifyPickTeamGroup({ betType: "SPREAD", betDetail }, f.game, "NCAAF"),
          expected
        );
      }
    }
  }

  // Bare mascot for NCAAF still groups OTHER (NCAAF_SCHOOLS has no mascot
  // keys - "Panthers" is shared by Pitt / Georgia State / FIU) - unchanged,
  // and confirms the fix didn't over-reach into mascot matching.
  {
    const game = { homeTeam: "South Florida Bulls", awayTeam: "Florida International Panthers" };
    check("bare 'Panthers +14.5' still groups OTHER for NCAAF", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Panthers +14.5" }, game, "NCAAF"), "OTHER");
  }

  console.log("\n########## PART E: accented / apostrophe team names now resolve ##########");

  // findGroupingNickname returned undefined for "San José State Spartans" and
  // "Hawai'i Rainbow Warriors" (the regex ran against the raw accented
  // string), so EVERY spread/ML pick on those teams fell to OTHER and the
  // group header showed the raw full name. normalizeForGrouping folds the
  // diacritics/apostrophe (same NFD + combining-mark strip as
  // team-name-match.ts) so the ascii keys ("san jose state", "hawaii") match.
  {
    const game = { homeTeam: "San José State Spartans", awayTeam: "Hawai'i Rainbow Warriors" };
    check("teamGroupAliases resolves the accented home name", teamGroupAliases(game.homeTeam, "NCAAF"), ["san jose state", "san jose st"]);
    check("teamGroupAliases resolves the apostrophe away name", teamGroupAliases(game.awayTeam, "NCAAF"), ["hawaii"]);
    check("shortTeamName folds the accent for the header (was raw 'San José State Spartans')", shortTeamName(game.homeTeam, "NCAAF"), "San Jose State");
    check("shortTeamName folds the apostrophe for the header", shortTeamName(game.awayTeam, "NCAAF"), "Hawaii");

    check("'San Jose State -3' (plain) groups HOME", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "San Jose State -3" }, game, "NCAAF"), "HOME");
    check("'San José State -3' (accented in betDetail too) groups HOME", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "San José State -3" }, game, "NCAAF"), "HOME");
    check("'Hawaii +3' groups AWAY", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Hawaii +3" }, game, "NCAAF"), "AWAY");
    check("'Hawai'i +3' (apostrophe in betDetail) groups AWAY", classifyPickTeamGroup({ betType: "SPREAD", betDetail: "Hawai'i +3" }, game, "NCAAF"), "AWAY");
  }

  console.log("\n########## PART F: non-NCAAF sports unaffected (single bare nickname, no reverse-map) ##########");

  // The whole-alias-set behavior is NCAAF-only. Every other sport's
  // teamGroupAliases is exactly the single nickname findGroupingNickname
  // returned - re-assert the KBO-collision teams from PART A and a couple of
  // plain ones, now through teamGroupAliases + the word-boundary match.
  {
    for (const [sport, name, expected] of [
      ["MLB", "Minnesota Twins", ["twins"]],
      ["MLB", "Detroit Tigers", ["tigers"]],
      ["NFL", "Chicago Bears", ["bears"]],
      ["NFL", "Philadelphia Eagles", ["eagles"]],
      ["MLB", "San Diego Padres", ["padres"]],
      ["NBA", "Sacramento Kings", ["kings"]],
      ["NHL", "Winnipeg Jets", ["jets"]],
      ["WNBA", "Las Vegas Aces", ["aces"]],
    ] as [string, string, string[]][]) {
      check(`teamGroupAliases('${name}', ${sport}) is the single nickname`, teamGroupAliases(name, sport), expected);
    }

    // Behavior parity with PART A: the exact Twins/Tigers/Bears moneyline
    // rows still group to their team, not OTHER.
    check(
      "Twins moneyline still groups HOME (KBO-collision handling intact)",
      classifyPickTeamGroup(
        { betType: "MONEYLINE", betDetail: "Twins Moneyline - 8-14 (36%) on favorite moneyline picks" },
        { homeTeam: "Minnesota Twins", awayTeam: "Atlanta Braves" },
        "MLB"
      ),
      "HOME"
    );
    check(
      "Bears moneyline groups AWAY",
      classifyPickTeamGroup(
        { betType: "MONEYLINE", betDetail: "Bears ML" },
        { homeTeam: "Green Bay Packers", awayTeam: "Chicago Bears" },
        "NFL"
      ),
      "AWAY"
    );
    check(
      "an MLB game total still groups OTHER",
      classifyPickTeamGroup(
        { betType: "TOTAL", betDetail: "Twins Braves Over 8.5 - 1-1 (50%) on over picks" },
        { homeTeam: "Minnesota Twins", awayTeam: "Atlanta Braves" },
        "MLB"
      ),
      "OTHER"
    );
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
