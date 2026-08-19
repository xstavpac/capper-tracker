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
import { parseCatalog } from "./parse-catalog";

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

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
