// Proof for parseCatalog - run with:
//   npx tsx src/lib/parse-catalog-acceptance-test.ts
//
// No test framework exists in this repo (see the 7472338 commit); this is
// the persisted replacement for the ad-hoc regression scripts prior parser
// fixes were verified with and then threw away, so the NEXT parser change
// has a real safety net to re-run instead of reconstructing these cases from
// git history again. Two groups:
//   PART A - the Bambino/NRFI investigation's four coordinated fixes:
//     capper-name extraction from a record-bearing tagline, the boilerplate/
//     bare-sport-code skip list, whitespace-insensitive team matching, and
//     o3.5/u45.5 shorthand recognition.
//   PART B - reconstructed coverage of every previously-verified parser fix
//     (tennis player picks, reversed-word-order unit notes, the Ottawa/
//     Winnipeg and CFL_TEAMS cases, blank-line-headers, tagged units,
//     cross-disambiguation, "(TeamA/TeamB)" parenthetical survival) -
//     reconstructed from commit messages since no fixture file was ever
//     committed for them; if this ever drifts from what those commits
//     actually verified, trust a real repro over this file's comments.
//   PART C - the KBO team-support/collision-resolution round (791fc5b,
//     d9bfe3c, f4cd9ad): KBO team data, the Bears/Twins/Giants/Lions/Eagles/
//     Tigers nickname collisions this introduced, and the KT Wiz -> ATP
//     fallback bug. Includes an explicit regression check that removing the
//     6 bare nicknames from MLB_TEAMS/NFL_TEAMS didn't break resolving the
//     REAL (non-KBO) team on either side of each collision - the whole
//     point of routing through DISAMBIGUATED_TEAMS/AMBIGUOUS_NICKNAMES
//     instead of just deleting the entries outright.
//   PART D - NCAAF team data, keyed by school name rather than bare mascot
//     (see NCAAF_SCHOOLS' comment in parse-catalog.ts for why). Verifies
//     every key resolves to NCAAF from realistic capper text, and - the
//     actual point of the school-name design - that none of the mascots
//     shared by 2+ schools (Tigers/Wildcats/Bulldogs/Knights/Devils/Cougars/
//     Bears) or already claimed by an existing NFL/NBA/NHL entry
//     (Ducks/Bruins/Devils/Cowboys/Raiders/Hurricanes/Cavaliers) resolve to
//     NCAAF, or to a different school than before, when typed bare. Started
//     as a curated Power-4-plus-Notre-Dame 68; PART H widened it to full FBS.
//   PART E - Washington/Mystics investigation: an NCAAF school name sharing
//     a word with a different sport's real team ("Washington Mystics" ->
//     WNBA, not NCAAF's Washington Huskies) was resolving to the wrong
//     sport because TEAM_SPORT_ENTRIES was matched purely longest-string-
//     first. Also covers the inverse - a school's OWN real mascot already
//     claimed bare by an NFL/NBA/NHL entry ("Oregon Ducks", "UCLA Bruins")
//     must still resolve NCAAF.
import {
  parseCatalog,
  inferSportFromPickContext,
  NCAAF_CANONICAL_SUFFIX,
  TEAM_NICKNAME_CANONICAL,
  teamGroupAliases,
  ambiguousOptionsFor,
  resolveAmbiguousPick,
  findTeamNicknames,
} from "./parse-catalog";
import { isSportLabelInSeason } from "./sport-seasons";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // ==========================================================================
  // PART A - Bambino/NRFI investigation (this round's four fixes together)
  // ==========================================================================
  console.log("\n########## PART A: Bambino/NRFI coordinated fixes ##########");

  // Real tweet text, verbatim. Confirmed (before any fix) that this entire
  // catalog corrupted: "Bambino 19-0 NRFI Run" tripped looksLikePick via
  // BOTH the NRFI keyword and the "-0" in the record, failed to resolve to
  // any team/sport, and routed to unresolved - never setting currentCapper.
  // "Full Card" then became a fake capper. "RedSox ML" (no space) missed
  // the "red sox" team entry and got misread as an ATP player named
  // "RedSox". "Carrington o3.5 Rebounds" (o3.5 = over 3.5, unrecognized)
  // silently became ANOTHER fake capper header, swallowing itself.
  //
  // As of the ATP-phantom-fix (2026-09), "Carrington o3.5 Rebounds" no
  // longer becomes a phantom ATP pick either - "carrington" is not a known
  // tennis player and "rebounds" is not tennis vocabulary, so it now routes
  // to `unresolved` (the honest outcome for an NBA rebounds prop with an
  // unrecognized player). The block's real concern - that it must NOT be
  // misread as a fake capper header that hijacks the following picks - is
  // still satisfied: currentCapper stays "Bambino" and the other 4 picks
  // are unaffected.
  {
    const { picks, unresolved } = parseCatalog(
      `Bambino 19-0 NRFI Run \u{1F4AA}\n\nFull Card\nYankees vs Blue Jays NRFI\nRedSox ML\nAstros ML\nBraves ML\nCarrington o3.5 Rebounds`,
      []
    );
    check("Bambino: 'Carrington o3.5 Rebounds' routes to unresolved, not a phantom ATP pick", unresolved, ["Carrington o3.5 Rebounds"]);
    check("Bambino: 4 real picks recovered (Carrington unresolved)", picks.length, 4);
    check(
      "Bambino: every pick attributed to 'Bambino' (currentCapper set from the tagline, not lost, not 'Full Card')",
      picks.every((p) => p.capperName === "Bambino"),
      true
    );
    const nrfi = picks.find((p) => p.description.includes("Yankees"));
    check("Bambino: Yankees vs Blue Jays NRFI resolves MLB/NRFI", { sport: nrfi?.sportName, bet: nrfi?.betType }, { sport: "MLB", bet: "NRFI" });
    const redSox = picks.find((p) => p.description.includes("RedSox"));
    check(
      "Bambino: 'RedSox' (no space) resolves as MLB Red Sox, not a fabricated ATP player",
      { sport: redSox?.sportName, teamNicknames: redSox?.teamNicknames },
      { sport: "MLB", teamNicknames: ["red sox"] }
    );
    check("Bambino: 'Carrington o3.5 Rebounds' is not attributed as a capper (no pick under that name)", picks.some((p) => p.capperName.includes("Carrington")), false);
  }

  // KBO sub-header case: a bare sport/league code line on its own (no team,
  // no bet-type text) must be skipped exactly like a boilerplate label -
  // never a capper name. Real example: "Porter Picks" / "KBO" / "Doosan
  // Bears ML" - before this fix, the bare "KBO" line (not in KNOWN_SPORTS at
  // all) fell through to the name fallback and overwrote "Porter Picks".
  // Team/sport resolution for "Doosan Bears" itself is a separate, deferred
  // gap (this app has no KBO team list, so "Bears" collides with the NFL's
  // Chicago Bears nickname) - only capper ATTRIBUTION is asserted here.
  {
    const { picks, unresolved } = parseCatalog(`Porter Picks\nKBO\nDoosan Bears ML`, []);
    check("KBO: no unresolved lines", unresolved, []);
    const doosan = picks.find((p) => p.description.includes("Doosan"));
    check("KBO: bare 'KBO' line skipped, capper attribution survives as 'Porter Picks'", doosan?.capperName, "Porter Picks");
  }

  // Adversarial case for the tagline-extraction boundary: a name-shaped
  // lead-in before a real bet-type keyword, but NO won-loss record anywhere
  // - this must NOT be read as a capper announcing themselves. "Berlin
  // Wolves" isn't a tracked team/nickname (not even an AMBIGUOUS_NICKNAMES
  // entry, unlike "Giants"), so it's a genuinely unresolvable pick that
  // happens to share the same "name-shaped words + keyword" shape as
  // "Bambino 19-0 NRFI Run" - the record requirement is what tells them
  // apart. Also confirms it doesn't corrupt the next real pick's attribution.
  {
    const { picks, unresolved } = parseCatalog(`Real Capper\n\nBerlin Wolves NRFI\nAstros ML`, []);
    check("Adversarial: name-shaped-but-recordless line stays unresolved, not extracted as a capper", unresolved, ["Berlin Wolves NRFI"]);
    const astros = picks.find((p) => p.description.includes("Astros"));
    check("Adversarial: following real pick still attributed to 'Real Capper' (not corrupted)", astros?.capperName, "Real Capper");
  }

  // Record-bearing tagline mid-catalog (not just at the very start of the
  // paste) - the same extraction must fire wherever it appears.
  {
    const { picks, unresolved } = parseCatalog(`Real Capper\nCubs ML\n\nSharp Sam 12-2 ML Run\nBraves ML`, []);
    check("Mid-catalog tagline: no unresolved lines", unresolved, []);
    check(
      "Mid-catalog tagline: capper switches from 'Real Capper' to 'Sharp Sam' at the tagline, both sets of picks correctly split",
      picks.map((p) => ({ capper: p.capperName, desc: p.description })),
      [
        { capper: "Real Capper", desc: "Cubs ML" },
        { capper: "Sharp Sam", desc: "Braves ML" },
      ]
    );
  }

  // ==========================================================================
  // PART B - reconstructed coverage of every previously-verified parser fix
  // ==========================================================================
  console.log("\n########## PART B: prior fixes, regression coverage ##########");

  // Tennis player picks (7472338) - no team to match against, so the name
  // before ML/spread/total is extracted directly and keyed on its last word
  // so a later bare surname resolves to the same player.
  {
    const { picks } = parseCatalog(`Some Capper\n\nTallon Griekspoor ML\nGriekspoor -150`, []);
    check(
      "Tennis: 'Tallon Griekspoor ML' resolves as an ATP player pick keyed on 'griekspoor'",
      { sport: picks[0]?.sportName, key: picks[0]?.teamNicknames[0] },
      { sport: "ATP", key: "griekspoor" }
    );
    check("Tennis: bare 'Griekspoor -150' resolves to the same playerKey", picks[1]?.teamNicknames[0], "griekspoor");
    check(
      "Tennis: both attributed to 'Some Capper'",
      picks.every((p) => p.capperName === "Some Capper"),
      true
    );
  }

  // Reversed-word-order unit note (e8c2aff) - "Units: 1 each" is digit-AFTER-
  // word, the opposite order from a capper's own "1u"/"2 units" shorthand.
  // Must still route to unresolved, not become a phantom capper that
  // swallows the real capper announced right after it.
  {
    const { picks, unresolved } = parseCatalog(`Capper One\nCubs ML\n\nUnits: 1 each\n\nCapper Two\nBraves ML`, []);
    check("Reversed unit note: lands in unresolved", unresolved, ["Units: 1 each"]);
    check(
      "Reversed unit note: Cubs ML (before) attributed to Capper One, Braves ML (after) to Capper Two",
      picks.map((p) => ({ capper: p.capperName, desc: p.description })),
      [
        { capper: "Capper One", desc: "Cubs ML" },
        { capper: "Capper Two", desc: "Braves ML" },
      ]
    );
  }

  // Ottawa vs Winnipeg (a81d565) - single-word CITY names, not in CFL_TEAMS
  // (which only has nicknames like "redblacks"/"blue bombers"). The
  // documented fix tightened findMatchupPlayerPick to require 2-4
  // capitalized words per side, so this is never misread as a two-fighter
  // MMA matchup - and, via the matchup-shape signal in looksLikePick, does
  // NOT fall through to becoming a fake capper either. Both cities are now
  // AMBIGUOUS_NICKNAMES keys (PART I below), so - rather than unresolved -
  // this surfaces ambiguous: their common sports (NHL + CFL, both cities
  // have a team in each) don't intersect to exactly one, so
  // resolveAmbiguousPair can't narrow the pair either, and it falls through
  // to findAmbiguousNickname picking up "ottawa" (checked first, insertion
  // order) with its own 2 candidates - a real ambiguity prompt, not a guess.
  {
    const { picks, unresolved } = parseCatalog(`Gridiron Capper\n\nOttawa vs Winnipeg Over 56.5\nBraves ML`, []);
    const ottawa = picks.find((p) => p.raw.startsWith("Ottawa"));
    check(
      "Ottawa/Winnipeg: surfaces ambiguous ('ottawa', not an MMA fighter match), no unresolved line",
      { unresolved, key: ottawa?.ambiguousKey, labels: ottawa?.ambiguous?.map((o) => o.label) },
      { unresolved: [], key: "ottawa", labels: ["Ottawa Senators (NHL)", "Ottawa Redblacks (CFL)"] }
    );
    const braves = picks.find((p) => p.description.includes("Braves"));
    check("Ottawa/Winnipeg: following real pick still attributed to Gridiron Capper", braves?.capperName, "Gridiron Capper");
  }

  // Real CFL_TEAMS nickname resolution (a81d565) - the positive case Ottawa/
  // Winnipeg is deliberately NOT: an actual tracked CFL nickname pair
  // resolves cleanly to sportName "CFL", same "untracked-sport" bucket ATP
  // occupies for tennis.
  {
    const { picks } = parseCatalog(`Capper\nRedblacks vs Blue Bombers Over 45.5`, []);
    check(
      "CFL_TEAMS: 'Redblacks vs Blue Bombers Over 45.5' resolves as a real CFL pick",
      { sport: picks[0]?.sportName, teams: picks[0]?.teamNicknames.sort() },
      // "redblacks" also matches the "red blacks" CFL_TEAMS entry added for the
      // CFL grading build (The Odds API's Ottawa spelling was unconfirmed) -
      // extra nickname, same CFL resolution, game matching tries each.
      { sport: "CFL", teams: ["blue bombers", "red blacks", "redblacks"] }
    );
  }

  // Blank line between a capper's name and their first pick (7472338,
  // Twitter-paste shape) - looksLikePick overrides the after-blank "assume
  // it's a header" caution so the first pick isn't misread as a name.
  {
    const { picks } = parseCatalog(`Twitter Capper\n\nCubs ML 2u`, []);
    check(
      "Blank-line header: first pick right after the blank still attributes correctly, with units parsed",
      { capper: picks[0]?.capperName, units: picks[0]?.units },
      { capper: "Twitter Capper", units: 2 }
    );
  }

  // "(10u POTD)" - unit extraction shouldn't require the parenthetical to
  // contain ONLY the unit size (7472338).
  {
    const { picks } = parseCatalog(`Capper\nCubs ML (10u POTD)`, []);
    check("Tagged units: '(10u POTD)' extracts 10 units, not the 1u default", picks[0]?.units, 10);
  }

  // Cross-disambiguation (9959e1f) - "Cardinals" and "Panthers" are both
  // individually ambiguous, but their possible sports intersect at exactly
  // one (NFL), so this resolves cleanly instead of prompting the user.
  {
    const { picks, unresolved } = parseCatalog(`Capper\nCardinals vs Panthers Over 45.5`, []);
    check("Cross-disambiguation: no unresolved lines", unresolved, []);
    check(
      "Cross-disambiguation: Cardinals+Panthers resolves to NFL with no ambiguous prompt",
      { sport: picks[0]?.sportName, ambiguous: picks[0]?.ambiguous },
      { sport: "NFL", ambiguous: undefined }
    );
  }

  // "(TeamA/TeamB)" parenthetical survives the odds/units paren-stripper
  // (9959e1f) - a Total pick whose only team info lives in the annotation
  // still resolves both teams.
  {
    const { picks } = parseCatalog(`Capper\nOver 9.5 (Angels/Orioles)`, []);
    check(
      "Paren team survival: 'Over 9.5 (Angels/Orioles)' resolves as TOTAL/over with both teams captured",
      { bet: picks[0]?.betType, side: picks[0]?.totalSide, teams: picks[0]?.teamNicknames.sort() },
      { bet: "TOTAL", side: "over", teams: ["angels", "orioles"] }
    );
  }

  // ==========================================================================
  // PART C - KBO team support + nickname collision resolution
  // ==========================================================================
  console.log("\n########## PART C: KBO team support + collision resolution ##########");

  // The 4 real screenshot lines that were mis-tagged before this round - all
  // must now resolve to KBO.
  {
    const { picks, unresolved } = parseCatalog(
      `Porter Picks\nKBO\nDoosan Bears ML\nLotte Giants -1.5\nKT Wiz ML\nKIA Tigers vs Hanwha Eagles Over 9.5`,
      []
    );
    check("KBO screenshots: no unresolved lines", unresolved, []);
    check(
      "KBO screenshots: all 4 resolve to KBO",
      picks.map((p) => p.sportName),
      ["KBO", "KBO", "KBO", "KBO"]
    );
    const kiaVsHanwha = picks.find((p) => p.description.includes("Hanwha"));
    check(
      "KBO screenshots: 'KIA Tigers vs Hanwha Eagles' captures both KBO teams",
      kiaVsHanwha?.teamNicknames.sort(),
      ["hanwha eagles", "kia tigers"]
    );
  }

  // Regression check: removing "bears"/"tigers"/"twins"/"lions"/"eagles" from
  // NFL_TEAMS/MLB_TEAMS (to route them through the KBO collision instead)
  // must NOT break resolving the real, non-KBO team on the other side of
  // each collision when its full city-qualified name is stated - the whole
  // point of DISAMBIGUATED_TEAMS over just deleting the bare entries.
  {
    const cases: [string, string, string][] = [
      ["Chicago Bears -3.5", "NFL", "chicago bears"],
      ["Detroit Tigers ML", "MLB", "detroit tigers"],
      ["Minnesota Twins ML", "MLB", "minnesota twins"],
      ["Detroit Lions -3.5", "NFL", "detroit lions"],
      ["Philadelphia Eagles ML", "NFL", "philadelphia eagles"],
      ["San Francisco Giants ML", "MLB", "san francisco giants"],
      ["New York Giants ML", "NFL", "new york giants"],
    ];
    for (const [line, expectedSport, expectedNickname] of cases) {
      const { picks } = parseCatalog(`Capper\n${line}`, []);
      check(
        `Regression: real full team name '${line}' still resolves to ${expectedSport}, not KBO or ambiguous`,
        { sport: picks[0]?.sportName, teams: picks[0]?.teamNicknames, ambiguous: picks[0]?.ambiguous },
        { sport: expectedSport, teams: [expectedNickname], ambiguous: undefined }
      );
    }
  }

  // A genuinely bare nickname (no city, no other context) for one of the 6
  // collisions must surface as ambiguous with both the real US-league team
  // AND the KBO team offered - not silently resolve to either one.
  {
    const bears = parseCatalog(`Capper\nBears ML`, []).picks[0];
    check(
      "Bare 'Bears ML': surfaces ambiguous (NFL + KBO), not silently resolved",
      { sport: bears?.sportName, options: bears?.ambiguous?.map((o) => o.label).sort() },
      { sport: "", options: ["Chicago Bears (NFL)", "Doosan Bears (KBO)"] }
    );
    const tigers = parseCatalog(`Capper\nTigers ML`, []).picks[0];
    check(
      "Bare 'Tigers ML': surfaces ambiguous (MLB + KBO), not silently resolved",
      { sport: tigers?.sportName, options: tigers?.ambiguous?.map((o) => o.label).sort() },
      { sport: "", options: ["Detroit Tigers (MLB)", "KIA Tigers (KBO)"] }
    );
  }

  // Generic baseball wording ("ML") is not MLB-exclusive: KBO uses identical
  // terminology, and so does the NFL. "ML" / "money line" were removed from
  // the MLB context signals entirely (the "bucs" round) - a bare "ML" pick on
  // any MLB-ambiguous nickname now stays ambiguous for a one-click choice
  // instead of silently guessing MLB. Genuinely MLB-only wording (run line,
  // NRFI, F5) still resolves MLB where MLB is a candidate and there's no KBO;
  // genuinely NFL-only wording still resolves NFL.
  {
    check(
      "Context: 'Tigers ML' vs [MLB, KBO] -> ambiguous (not MLB)",
      inferSportFromPickContext("Tigers ML", ["MLB", "KBO"]),
      null
    );
    check(
      "Context: 'Twins run line -1.5' vs [MLB, KBO] -> ambiguous (KBO uses run line too)",
      inferSportFromPickContext("Twins run line -1.5", ["MLB", "KBO"]),
      null
    );
    check(
      "Context: 'Giants ML' vs [MLB, NFL, KBO] -> ambiguous",
      inferSportFromPickContext("Giants ML", ["MLB", "NFL", "KBO"]),
      null
    );
    check(
      "Context: 'Cardinals ML' vs [MLB, NFL] -> ambiguous ('ML' is not an MLB signal)",
      inferSportFromPickContext("Cardinals ML", ["MLB", "NFL"]),
      null
    );
    check(
      "Context: genuinely NFL-worded 'Eagles spread -3' vs [NFL, KBO] still resolves NFL",
      inferSportFromPickContext("Eagles spread -3", ["NFL", "KBO"]),
      "NFL"
    );
    check(
      "Context: genuinely MLB-worded 'Cardinals NRFI' vs [MLB, NFL] still resolves MLB",
      inferSportFromPickContext("Cardinals NRFI", ["MLB", "NFL"]),
      "MLB"
    );
    check(
      "Context: 'Cardinals F5 -1.5' vs [MLB, NFL] still resolves MLB",
      inferSportFromPickContext("Cardinals F5 -1.5", ["MLB", "NFL"]),
      "MLB"
    );
  }

  // The KT Wiz -> ATP fallback bug: an unlisted team shaped like
  // "abbreviation + word" must land in `unresolved`, not get silently
  // guessed as a tennis player. Tested against a team NOT in any list (KT
  // Wiz itself is now in KBO_TEAMS as of this same round, so it no longer
  // exercises this path) - this is the general case the fix actually covers.
  {
    const { picks, unresolved } = parseCatalog(`Capper\nAB Wolves ML`, []);
    check("ATP fallback fix: unlisted abbreviation-shaped team stays unresolved", unresolved, ["AB Wolves ML"]);
    check("ATP fallback fix: no phantom ATP pick created", picks.length, 0);
  }

  // Real tennis and MMA picks must still resolve after the ATP fallback fix
  // - the guard only rejects abbreviation-shaped candidates, not real names.
  {
    const tennis = parseCatalog(`Capper\nTallon Griekspoor ML`, []).picks[0];
    check("ATP fallback fix: real tennis pick unaffected", tennis?.sportName, "ATP");
    const mma = parseCatalog(`Capper\nIslam Makhachev vs Ian Machado Garry ML`, []).picks[0];
    check("ATP fallback fix: real MMA matchup unaffected", mma?.sportName, "MMA");
  }

  // ==========================================================================
  // PART D - NCAAF week-1 curated launch (Power 4 + Notre Dame)
  // ==========================================================================
  console.log("\n########## PART D: NCAAF curated team data (school-name keyed) ##########");

  {
    const keys = Object.keys(NCAAF_CANONICAL_SUFFIX);
    // 138 FBS schools, several with more than one key (abbreviations /
    // alternate spellings a capper types) - see NCAAF_SCHOOLS in
    // parse-catalog.ts. Assert the total rather than a school count so a
    // stray dupe or a dropped entry is caught. 167 -> 174: bama, uga, mizzou,
    // tamu, wvu, cuse, pitt added in the pro-team short-alias round (PART O).
    // 174 -> 176: alabama state, montana state added as FCS money-game
    // opponents (PART Q - the Alabama State / Troy schedule-match bug).
    // 176 -> 178: "n texas"/"n. texas" added as North Texas abbreviations
    // (PART T - the N. Texas mis-resolving-to-Longhorns bug).
    check("NCAAF list: 178 keys (138 FBS schools + capper-shorthand aliases + FCS money-game opponents)", keys.length, 178);
    check("NCAAF list: no duplicate keys", new Set(keys).size, keys.length);

    // (a) Every key resolves to NCAAF from realistic capper text (the key +
    // a bet keyword) - no mascot needed. "liberty" is a deliberate
    // exception: it's shared with WNBA's New York Liberty, so a bare
    // "Liberty" is now routed to the schedule-first ambiguous hierarchy
    // (see PART N) rather than resolving to either sport directly. "Liberty
    // Flames" and two-team lines still resolve NCAAF (covered in PART H).
    //
    // The 16 keys below are the SAME exception for the SAME reason - each is
    // ALSO a real, currently-tracked pro franchise's own brand name (Texas
    // Rangers, Pittsburgh Pirates/Steelers/Penguins, Florida Panthers,
    // Washington's five DC teams, etc. - see PART S, the Texas/Pittsburgh
    // mis-import fix). A bare pick with one of these words alone is
    // genuinely ambiguous and must NOT resolve to NCAAF with no signal;
    // each school's own full mascot name ("Texas Longhorns", "Pittsburgh
    // Panthers") still resolves NCAAF directly, exactly like "Liberty
    // Flames" does for "liberty".
    const AMBIGUOUS_CITY_SCHOOL_KEYS = new Set([
      "liberty", "arizona", "buffalo", "charlotte", "cincinnati", "colorado",
      "houston", "indiana", "memphis", "miami", "minnesota", "pittsburgh",
      "tennessee", "texas", "utah", "washington", "florida",
    ]);
    const misresolved = keys.filter((key) => {
      if (AMBIGUOUS_CITY_SCHOOL_KEYS.has(key)) return false;
      const pick = parseCatalog(`Capper\n${key} ML`, []).picks[0];
      return pick?.sportName !== "NCAAF";
    });
    check("NCAAF list: every key (except the 17 pro-franchise-collision cities) resolves to NCAAF from a bare pick", misresolved, []);

    // (a2) ...and each of those 17 IS genuinely ambiguous from a bare pick
    // (not silently dropped or misresolved some OTHER way) - it surfaces
    // with the school itself as one of the real candidates.
    const notAmbiguous = Array.from(AMBIGUOUS_CITY_SCHOOL_KEYS).filter((key) => {
      const pick = parseCatalog(`Capper\n${key} ML`, []).picks[0];
      const canonical = NCAAF_CANONICAL_SUFFIX[key];
      return !(pick?.ambiguousKey === key && pick.ambiguous?.some((o) => o.nickname === canonical));
    });
    check("every pro-franchise-collision city surfaces ambiguous with its NCAAF school as a candidate", notAmbiguous, []);

    const liberty = parseCatalog(`Capper\nLiberty ML`, []).picks[0];
    check("bare 'Liberty' surfaces the ambiguous prompt (WNBA + NCAAF), not a direct resolve", {
      sport: liberty?.sportName,
      key: liberty?.ambiguousKey,
      labels: liberty?.ambiguous?.map((o) => o.label),
    }, {
      sport: "",
      key: "liberty",
      labels: ["New York Liberty (WNBA)", "Liberty Flames (NCAAF)"],
    });
  }

  // (b) The 7 mascots shared by 2+ curated NCAAF schools - typed bare, none
  // of them may resolve to NCAAF, and none of them may change behavior from
  // whatever they already did before NCAAF existed. Each expectation below
  // was confirmed against the actual parser (not assumed) before being
  // written - see the PART D header comment for what "unresolved" turned
  // out to really mean for 4 of these 7.
  {
    const tigers = parseCatalog(`Capper\nTigers ML`, []).picks[0];
    check("in-sport collision 'tigers': still the pre-existing MLB/KBO ambiguous prompt, not NCAAF", tigers?.ambiguousKey, "tigers");
    check(
      "in-sport collision 'tigers': NCAAF is not among the ambiguous options",
      tigers?.ambiguous?.some((o) => o.sport === "NCAAF"),
      false
    );

    const bears = parseCatalog(`Capper\nBears ML`, []).picks[0];
    check("in-sport collision 'bears': still the pre-existing NFL/KBO ambiguous prompt, not NCAAF", bears?.ambiguousKey, "bears");
    check(
      "in-sport collision 'bears': NCAAF is not among the ambiguous options",
      bears?.ambiguous?.some((o) => o.sport === "NCAAF"),
      false
    );

    const devils = parseCatalog(`Capper\nDevils ML`, []).picks[0];
    check("in-sport collision 'devils': still resolves directly to NHL, not NCAAF", devils?.sportName, "NHL");

    // Wildcats/Bulldogs/Knights/Cougars are registered nowhere bare (not in
    // any pro list, not in AMBIGUOUS_NICKNAMES). Before the ATP-phantom-fix
    // they fell through to findPlayerPick and were silently stamped ATP (a
    // single capitalized word before "ML" reads as a one-word player name);
    // as of that fix they route to `unresolved` instead - none of them is a
    // known tennis player and there's no tennis vocabulary. Still never
    // NCAAF (the only thing this NCAAF-collision block ever cared about).
    for (const word of ["Wildcats", "Bulldogs", "Knights", "Cougars"]) {
      const { picks, unresolved } = parseCatalog(`Capper\n${word} ML`, []);
      check(`in-sport collision '${word}': no phantom ATP pick, routes to unresolved`, { picks: picks.length, unresolved }, { picks: 0, unresolved: [`${word} ML`] });
    }
  }

  // (c) The 7 mascots already claimed by an existing NFL/NBA/NHL entry -
  // typed bare, still resolve to that existing pro team, completely
  // unaffected by NCAAF_TEAMS being appended to TEAM_SPORT_ENTRIES.
  {
    const expected: [string, string][] = [
      ["Ducks", "NHL"],
      ["Bruins", "NHL"],
      ["Cowboys", "NFL"],
      ["Raiders", "NFL"],
      ["Hurricanes", "NHL"],
      ["Cavaliers", "NBA"],
    ];
    for (const [word, sport] of expected) {
      const pick = parseCatalog(`Capper\n${word} ML`, []).picks[0];
      check(`cross-sport collision '${word}': still resolves to ${sport}, unaffected by NCAAF`, pick?.sportName, sport);
    }
  }

  // A capper naming both teams in a two-word matchup shape still works for
  // NCAAF the same way it does for every other sport - not part of the
  // curated-collision story, just confirming the ordinary multi-team path
  // wasn't disturbed by NCAAF_TEAMS being appended.
  {
    const pick = parseCatalog(`Capper\nOhio State vs Michigan Over 45.5`, []).picks[0];
    check("NCAAF matchup shape: sport resolves correctly", pick?.sportName, "NCAAF");
    check("NCAAF matchup shape: both team nicknames captured", pick?.teamNicknames?.sort(), ["michigan", "ohio state"]);
  }

  // ==========================================================================
  // PART E - Washington/Mystics investigation: a city/state name shared by an
  // NCAAF school and a DIFFERENT sport's real team ("Washington Mystics")
  // was resolving to the NCAAF school instead of the real team, because
  // TEAM_SPORT_ENTRIES was tried purely longest-string-first and the NCAAF
  // school key ("washington", 10 chars) outranked the WNBA mascot key
  // ("mystics", 7 chars) with no regard for which one was the text's real
  // identity. Fixed in detectSport by preferring a match nothing else
  // recognized trails, with a canonical-full-name carve-out (pass 0) for
  // when the trailing word actually is that SAME school's own real mascot
  // (e.g. "Oregon Ducks", "UCLA Bruins") even though that mascot is also
  // separately claimed bare by an NFL/NBA/NHL entry.
  // ==========================================================================
  console.log("\n########## PART E: NCAAF-school/other-sport word collision (Washington/Mystics) ##########");

  {
    const mystics = parseCatalog(`Capper\nWashington Mystics ML`, []).picks[0];
    check("'Washington Mystics' resolves WNBA, not NCAAF", mystics?.sportName, "WNBA");

    const huskies = parseCatalog(`Capper\nWashington Huskies ML`, []).picks[0];
    check("real NCAAF 'Washington Huskies' still resolves NCAAF", huskies?.sportName, "NCAAF");

    // Bare "Washington" (no mascot) USED to resolve straight to the Huskies
    // (NCAAF) - a real, known gap flagged when this fix originally shipped
    // (see the AMBIGUOUS_NICKNAMES comment in parse-catalog.ts) and closed
    // together with the Texas/Pittsburgh mis-import fix in PART S: DC's five
    // pro franchises are just as real a reading of bare "Washington" as the
    // Huskies, so it now surfaces ambiguous instead of silently guessing.
    const bareWashington = parseCatalog(`Capper\nWashington ML`, []).picks[0];
    check("bare 'Washington' (no mascot) is now ambiguous, not a silent NCAAF guess", { sport: bareWashington?.sportName, key: bareWashington?.ambiguousKey }, { sport: "", key: "washington" });

    const bareMystics = parseCatalog(`Capper\nMystics ML`, []).picks[0];
    check("bare 'Mystics' (no city) still resolves WNBA, unaffected", bareMystics?.sportName, "WNBA");

    // Same collision class, different pair - a school name (Miami) sharing a
    // word with a real pro team elsewhere in TEAM_SPORT_ENTRIES (Miami Heat,
    // NBA), confirming the fix isn't specific to Washington/Mystics.
    const heat = parseCatalog(`Capper\nMiami Heat ML`, []).picks[0];
    check("'Miami Heat' resolves NBA, not NCAAF", heat?.sportName, "NBA");

    // The inverse shape: the school's OWN real mascot happens to already be
    // claimed bare by an NFL/NBA/NHL entry (documented in NCAAF_SCHOOLS'
    // comment) - typed together with its school, it must still resolve
    // NCAAF, not the pro team, even though the pro mascot word is longer
    // than the school abbreviation and would otherwise win pass 1 outright.
    const ownMascot: [string, string][] = [
      ["Oregon Ducks", "NCAAF"],
      ["UCLA Bruins", "NCAAF"],
      ["Duke Blue Devils", "NCAAF"],
      ["Arizona State Sun Devils", "NCAAF"],
      ["Oklahoma State Cowboys", "NCAAF"],
    ];
    for (const [text, sport] of ownMascot) {
      const pick = parseCatalog(`Capper\n${text} ML`, []).picks[0];
      check(`school's own real mascot '${text}' still resolves ${sport}`, pick?.sportName, sport);
    }
  }

  // A follow-up to the Washington/Mystics fix: a NESTED-name variant of the
  // same collision class. "West Virginia" contains "Virginia" as a whole
  // word, and Virginia is itself a separate curated NCAAF school whose own
  // real mascot is "Cavaliers" - the same word NBA's Cleveland Cavaliers
  // uses bare. Before this guard, "West Virginia Cavaliers" matched
  // Virginia's canonical "Virginia Cavaliers" embedded inside the longer
  // name, even though West Virginia's real mascot is the Mountaineers and
  // has nothing to do with Cavaliers. Decided this resolves to NBA, not
  // NCAAF: West Virginia has no genuine "Cavaliers" identity of its own, so
  // (like Miami+Heat and Washington+Mystics before it) the real matching
  // pro team wins rather than a school name that only coincidentally
  // contains another, unrelated school's name as a trailing word. Checked
  // against every school in the curated 68 that could have the same shape
  // (Michigan State/Michigan, Kansas State/Kansas, Iowa State/Iowa,
  // Oklahoma State/Oklahoma, Georgia Tech/Georgia, Texas Tech or Texas A&M/
  // Texas, Arizona State/Arizona) - West Virginia/Virginia turned out to be
  // the ONLY one where the shorter name is a true trailing-word SUFFIX of
  // the longer one; the others are all prefixes ("Michigan" + " State"),
  // which never collided in the first place since a real mascot word can't
  // sit contiguously right after a school name with another word in between.
  console.log("\n########## PART F: nested NCAAF school-name collision (West Virginia/Virginia) ##########");

  {
    const westVirginiaCavaliers = parseCatalog(`Capper\nWest Virginia Cavaliers ML`, []).picks[0];
    check("'West Virginia Cavaliers' resolves NBA (West Virginia has no real Cavaliers identity)", westVirginiaCavaliers?.sportName, "NBA");

    const westVirginiaMountaineers = parseCatalog(`Capper\nWest Virginia Mountaineers ML`, []).picks[0];
    check("'West Virginia Mountaineers' (its real mascot) still resolves NCAAF", westVirginiaMountaineers?.sportName, "NCAAF");

    const virginiaCavaliers = parseCatalog(`Capper\nVirginia Cavaliers ML`, []).picks[0];
    check("'Virginia Cavaliers' (Virginia's own real mascot) still resolves NCAAF", virginiaCavaliers?.sportName, "NCAAF");

    const bareCavaliers = parseCatalog(`Capper\nCavaliers ML`, []).picks[0];
    check("bare 'Cavaliers' (no school) still resolves NBA, unaffected", bareCavaliers?.sportName, "NBA");

    // The other prefix-shaped compound schools that could plausibly have
    // hit the same class of bug - none of them actually did (verified
    // above they're prefixes, not suffixes, of their embedded shorter
    // school name), but each must still resolve NCAAF from its OWN real
    // mascot after this guard was added, same as before it.
    const compoundSchools: [string, string][] = [
      ["Michigan State Spartans", "NCAAF"],
      ["Kansas State Wildcats", "NCAAF"],
      ["Iowa State Cyclones", "NCAAF"],
      ["Georgia Tech Yellow Jackets", "NCAAF"],
      ["Texas Tech Red Raiders", "NCAAF"],
      ["Arizona State Sun Devils", "NCAAF"],
    ];
    for (const [text, sport] of compoundSchools) {
      const pick = parseCatalog(`Capper\n${text} ML`, []).picks[0];
      check(`compound school's own real mascot '${text}' still resolves ${sport}`, pick?.sportName, sport);
    }
  }

  // ==========================================================================
  // PART G - "Play of the Month" / parenthetical-record header misattribution
  // ==========================================================================
  // Real catalog post, verbatim (5 sections, one capper each). Before the
  // fix: "Play of the Month" (an intermediate label line between the
  // "Out of Line Bets" header and its real pick) fell through every
  // pick-detection check, hit the generic "unrecognized line -> new capper"
  // fallback, and silently became the active capper - so "Lorenzo Musetti ML
  // (6u)" was misattributed to "Play of the Month" instead of "Out of Line
  // Bets". Separately, "⚾ Bambino Bets (24-6 NRFI Run)" and "⚽ Hammering Hank
  // (9-2 Soccer Run)" - headers with a won-loss record inside a trailing
  // parenthetical rather than directly after the name - tripped looksLikePick
  // (the record's dash-digit shape plus NRFI/"Run" wording) and then failed
  // extractCapperNameFromTagline (whose lead capture ran up to the record,
  // landing on "Bambino Bets (" - trailing "(" fails NAME_SHAPE), so both
  // headers were pushed to `unresolved` and never became the active capper.
  console.log("\n########## PART G: Play of the Month / parenthetical-record headers ##########");

  {
    const text = `\u{1F410} Nicky Cashin

Jets ML
Brewers under 6
Yankees -1.5
Orioles ML
White Sox ML
Mariners ML
(1.5u each)

\u{1F3BE} Out of Line Bets

Play of the Month
Lorenzo Musetti ML (6u)

\u{26BE} Bambino Bets (24-6 NRFI Run)

Braves vs Brewers NRFI + under 7.5
Giants vs Red Sox NRFI
Mets vs White Sox NRFI

⚽ Hammering Hank (9-2 Soccer Run)

Coventry +2 (3u)

\u{1F3C0} Bet Labs

WNBA
Mystics +4.5 (1u)`;

    const { picks, unresolved } = parseCatalog(text, []);
    const byCapper = (name: string) => picks.filter((p) => p.capperName === name);

    check("Nicky Cashin: 6 picks attributed correctly", byCapper("Nicky Cashin").length, 6);
    check(
      "Out of Line Bets: 'Play of the Month' is a skipped label, not a capper - Musetti pick attributed to 'Out of Line Bets'",
      byCapper("Out of Line Bets").map((p) => p.description),
      ["Lorenzo Musetti ML"]
    );
    check("No pick is ever attributed to 'Play of the Month'", byCapper("Play of the Month").length, 0);
    check(
      "Bambino Bets: parenthetical-record header resolves to the capper, all 3 NRFI picks attributed",
      byCapper("Bambino Bets").length,
      3
    );
    // "⚽ Hammering Hank (9-2 Soccer Run)" is still consumed as a capper
    // header (not pushed to unresolved) - the PART G fix. Its one pick
    // "Coventry +2" is an English-soccer team this app can't resolve; before
    // the ATP-phantom-fix it was silently stamped as a tennis player
    // ("coventry"), now it routes to `unresolved` (no soccer team list /
    // schedule to place it against, and no tennis signal). No pick is ever
    // attributed to a fake capper, which is what this block guards.
    check("Hammering Hank: never attributed a phantom-ATP pick", byCapper("Hammering Hank").length, 0);
    check("Coventry +2: routes to unresolved (unsupported soccer team), not a phantom ATP pick", unresolved.some((u) => u.startsWith("Coventry +2")), true);
    check("Coventry +2: not a phantom ATP pick anywhere in results", picks.some((p) => p.description.includes("Coventry")), false);
    check("Bet Labs: WNBA sub-header picks attributed correctly", byCapper("Bet Labs").length, 1);
    check("11 real picks recovered across the sections (Coventry -> unresolved)", picks.length, 11);
  }

  // ==========================================================================
  // PART H - NCAAF widened from the curated 68 to full FBS (138 schools)
  // ==========================================================================
  // A real "Porter PICKS" slate mixed Group-of-5 games in with Power-4 ones.
  // Two coordinated bugs:
  //   1. Schools outside the curated 68 ("Hawaii +5.5", "UNLV -5.5",
  //      "Louisiana Tech -3") matched no NCAAF key and fell through to
  //      findPlayerPick's ATP tennis-phantom fallback (a lone capitalized
  //      word before a spread number looks like "Djokovic -1.5").
  //   2. "Florida State" also matched the shorter key "florida" (a whole
  //      word inside it), so a one-team pick produced the nickname pair
  //      ["florida state","florida"] -> canonicals ["florida state
  //      seminoles","florida gators"] -> lookupGame treated it as an
  //      FSU-vs-Florida matchup and found no such game today, failing 4
  //      real picks with "couldn't match to today's schedule". Fixed by a
  //      span-subsumption filter in findTeamNicknames (a shorter match
  //      wholly inside a longer one at the same spot is the same team, not
  //      an opponent).
  console.log("\n########## PART H: full-FBS widening (Porter PICKS slate) ##########");

  {
    // Bug 1 - the three schools that were mistagged ATP, verbatim from the
    // reported import.
    for (const [text, nick] of [
      ["Hawaii +5.5", "hawaii"],
      ["UNLV -5.5", "unlv"],
      ["Louisiana Tech -3", "louisiana tech"],
    ] as [string, string][]) {
      const pick = parseCatalog(`Porter PICKS\n${text}`, []).picks[0];
      check(`'${text}' resolves NCAAF, not ATP`, pick?.sportName, "NCAAF");
      check(`'${text}' captures the right school nickname`, pick?.teamNicknames, [nick]);
    }

    // Bug 2 - "Florida State" must produce exactly one nickname, not the
    // phantom ["florida state","florida"] pair that broke schedule matching.
    const fsuSpread = parseCatalog(`ALGOPICKS\nFlorida State -31`, []).picks[0];
    check("'Florida State -31' -> single nickname (no phantom 'florida')", fsuSpread?.teamNicknames, ["florida state"]);
    check(
      "'Florida State' canonical is the exact ESPN displayName",
      NCAAF_CANONICAL_SUFFIX["florida state"],
      "florida state seminoles"
    );

    const fsuMatchup = parseCatalog(`Porter PICKS\nNew Mexico State vs Florida State over 53`, []).picks[0];
    check("'New Mexico State vs Florida State' -> both real teams, in order", fsuMatchup?.teamNicknames, [
      "new mexico state",
      "florida state",
    ]);
    check(
      "New Mexico State canonical is the exact ESPN displayName",
      NCAAF_CANONICAL_SUFFIX["new mexico state"],
      "new mexico state aggies"
    );

    // Subsumption filter - a shorter school name nested in a longer one is
    // dropped (it was previously double-reported, working only by luck of
    // TEAM_SPORT_ENTRIES ordering).
    const nested: [string, string[]][] = [
      ["Middle Tennessee +7", ["middle tennessee"]],
      ["West Virginia Mountaineers -3", ["west virginia"]],
      ["Eastern Michigan -9.5", ["eastern michigan"]],
      ["Michigan State vs Ohio State over 45", ["michigan state", "ohio state"]],
    ];
    for (const [text, expected] of nested) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`nested-name subsumption: '${text}'`, pick?.teamNicknames, expected);
    }

    // Miami (OH) - the one FBS name with parentheses. The key must not
    // collide with Miami FL, and the parenthesised canonical must still be
    // matchable (teamPhraseRegex now escapes metacharacters).
    check("'Miami OH -3' resolves NCAAF via the paren-free alias", parseCatalog(`Cap\nMiami OH -3`, []).picks[0]?.sportName, "NCAAF");
    check(
      "'Miami (OH) RedHawks -3' resolves NCAAF (canonical with literal parens)",
      parseCatalog(`Cap\nMiami (OH) RedHawks -3`, []).picks[0]?.sportName,
      "NCAAF"
    );
    // Bare "Miami -3" (no "OH"/mascot) is genuinely ambiguous among the
    // Dolphins/Heat/Marlins/Hurricanes - see PART S below (the
    // Texas/Pittsburgh mis-import fix) for why this no longer silently
    // guesses NCAAF the way it used to.
    {
      const bareMiami = parseCatalog(`Cap\nMiami -3`, []).picks[0];
      check("bare 'Miami -3' is now ambiguous, not a silent NCAAF guess", { sport: bareMiami?.sportName, key: bareMiami?.ambiguousKey }, { sport: "", key: "miami" });
    }

    // Liberty (see PART D) - the NCAAF entry still covers the non-bare forms.
    check("'Liberty Flames -7' resolves NCAAF", parseCatalog(`Cap\nLiberty Flames -7`, []).picks[0]?.sportName, "NCAAF");
    check(
      "'Liberty vs Sam Houston over 50' resolves NCAAF via the opponent",
      parseCatalog(`Cap\nLiberty vs Sam Houston over 50`, []).picks[0]?.sportName,
      "NCAAF"
    );

    // Prefix-match guard: a school name we list that is only the FRONT of a
    // school the capper actually named (NC A&T, NC Central - both FCS, not
    // in the list) must NOT silently resolve to the listed school's game.
    // findTeamNicknames returns [] -> the pick surfaces as "add manually".
    for (const text of ["North Carolina A&T +7", "North Carolina Central -3"]) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`prefix-match guard: '${text}' captures no nickname`, pick?.teamNicknames, []);
    }
    // ...but the real listed schools, their mascots, sides and periods are
    // all still fine after the guard.
    for (const [text, nick] of [
      ["North Carolina -7", "north carolina"],
      ["North Carolina Tar Heels ML", "north carolina"],
      ["North Carolina First Half -3", "north carolina"],
      ["Ohio State Buckeyes -7", "ohio state"],
      ["Sam Houston State +6", "sam houston state"],
      ["Boise State Broncos ML", "boise state"],
    ] as [string, string][]) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`prefix-match guard: '${text}' still resolves`, pick?.teamNicknames, [nick]);
    }

    // The reported slate as one paste - every pick lands on NCAAF (or its
    // capper), none on ATP.
    const slate = `Porter PICKS
Eastern Michigan -9.5
Hawaii +5.5
UNLV -5.5
New Mexico State vs Florida State over 53
NC State +4.5`;
    const slatePicks = parseCatalog(slate, []).picks;
    check("Porter slate: 5 picks, all NCAAF", slatePicks.map((p) => p.sportName), ["NCAAF", "NCAAF", "NCAAF", "NCAAF", "NCAAF"]);
  }

  // ==========================================================================
  // PART I - "sport not tracked" pending-page investigation (2026-09):
  //   1. "Boston" (bare city) -> AMBIGUOUS_NICKNAMES entry resolving via the
  //      season/schedule/pick-context hierarchy, like rangers/kings/cardinals.
  //   2. SPORTS_PLACE_NAMES guard in findPlayerPick: any OTHER bare city/
  //      state/region name routes to `unresolved` instead of the phantom-ATP
  //      tennis-player fallback ("Sharp Sheet - Ottawa +7.5" was a CFL pick
  //      mistagging as ATP).
  // ==========================================================================
  console.log("\n########## PART I: bare-city resolution (Boston ambiguous + place-name guard) ##########");
  {
    // --- Fix 1: "Boston" as an ambiguous nickname ---
    const boston = parseCatalog(`Cap\nBoston Over 7.5`, []).picks[0];
    check(
      "'Boston Over 7.5': surfaces ambiguous (MLB + NBA + NHL), not a phantom ATP pick",
      { sport: boston?.sportName, key: boston?.ambiguousKey, labels: boston?.ambiguous?.map((o) => o.label) },
      { sport: "", key: "boston", labels: ["Boston Red Sox (MLB)", "Boston Celtics (NBA)", "Boston Bruins (NHL)"] }
    );
    check(
      "ambiguousOptionsFor('boston') carries the disambiguated nicknames game resolution needs",
      ambiguousOptionsFor("boston"),
      [
        { label: "Boston Red Sox (MLB)", sport: "MLB", nickname: "red sox" },
        { label: "Boston Celtics (NBA)", sport: "NBA", nickname: "celtics" },
        { label: "Boston Bruins (NHL)", sport: "NHL", nickname: "bruins" },
      ]
    );
    // Calendar-fallback step of the disambiguation hierarchy (see
    // ambiguous-hierarchy.ts - reached only when the live schedule check is
    // inconclusive or errors): in September only MLB is in season, so
    // "Boston" narrows to the Red Sox on the calendar alone.
    check(
      "calendar fallback: on 2026-09-01 exactly one Boston option is in season (MLB / Red Sox)",
      ambiguousOptionsFor("boston").filter((o) => isSportLabelInSeason(o.sport, new Date("2026-09-01T12:00:00Z"))),
      [{ label: "Boston Red Sox (MLB)", sport: "MLB", nickname: "red sox" }]
    );
    // Overlap window: MLB (through Nov 5) and NHL (from Oct 7) are both in
    // season on Oct 15, so the calendar fallback correctly does NOT guess -
    // only the schedule check (which runs first) could tell them apart.
    check(
      "calendar fallback: on 2026-10-15 two Boston options are in season (no guess)",
      ambiguousOptionsFor("boston")
        .filter((o) => isSportLabelInSeason(o.sport, new Date("2026-10-15T12:00:00Z")))
        .map((o) => o.sport),
      ["MLB", "NHL"]
    );
    // Full name and the NCAAF school are unaffected by the new bare-city key.
    check(
      "'Boston Red Sox Over 7.5' still resolves straight to MLB (full name unaffected)",
      { sport: parseCatalog(`Cap\nBoston Red Sox Over 7.5`, []).picks[0]?.sportName, teams: parseCatalog(`Cap\nBoston Red Sox Over 7.5`, []).picks[0]?.teamNicknames },
      { sport: "MLB", teams: ["red sox"] }
    );
    check(
      "'Boston College +7.5' still resolves NCAAF (school not shadowed by the 'boston' key)",
      parseCatalog(`Cap\nBoston College +7.5`, []).picks[0]?.sportName,
      "NCAAF"
    );
  }
  {
    // --- Fix 2: SPORTS_PLACE_NAMES guard -> unresolved, not phantom ATP ---
    // "Ottawa"/"Denver"/"New York" (the original examples here) are now
    // AMBIGUOUS_NICKNAMES city keys themselves (Fix 3 below). SPORTS_PLACE_NAMES
    // itself is now empty (see its own comment): the 14 cities that used to
    // live there as NCAAF-collision negative guards (arizona/buffalo/.../
    // washington), plus "texas"/"florida" which were misfiled in
    // US_STATE_NAMES, are ALL promoted to real AMBIGUOUS_NICKNAMES keys now
    // (PART S, the Texas/Pittsburgh mis-import fix) - closing the exact gap
    // this comment used to describe as "already succeeds" and therefore
    // untouched.
    //
    // A real, currently-reachable `unresolved` case still needs a place name
    // that ISN'T an NCAAF school AND wasn't promoted - the state names in
    // US_STATE_NAMES (a separate guard, untouched by this build) cover that;
    // "Mississippi -6.5" is exercised in PART... (the phantom-ATP guard
    // tests) with the same expectation.
    check(
      "'Mississippi -6.5' (US_STATE_NAMES guard, untouched by this build) still routes to unresolved",
      parseCatalog(`Cap\nMississippi -6.5`, []).unresolved,
      ["Mississippi -6.5"]
    );

    // City + real nickname is still fine - the guard only fires on the bare city.
    check(
      "'Ottawa Redblacks +7.5' still resolves CFL (guard only hits the bare city)",
      parseCatalog(`Cap\nOttawa Redblacks +7.5`, []).picks[0]?.sportName,
      "CFL"
    );

    // Real individual-sport picks are unaffected - the guard rejects place
    // names, never personal names (including bare surnames).
    check("'Tallon Griekspoor ML' still resolves ATP", parseCatalog(`Cap\nTallon Griekspoor ML`, []).picks[0]?.sportName, "ATP");
    check("'Alcaraz Over 22.5' (bare surname) still resolves ATP", parseCatalog(`Cap\nAlcaraz Over 22.5`, []).picks[0]?.sportName, "ATP");
    check("'Sinner ML' (bare surname) still resolves ATP", parseCatalog(`Cap\nSinner ML`, []).picks[0]?.sportName, "ATP");
  }
  {
    // --- Fix 3 (this build): bare CITY names promoted to real
    // AMBIGUOUS_NICKNAMES candidates, generalizing Fix 1's "boston" to every
    // other pro-sports city this app tracks (except the NCAAF-collision
    // cities Fix 2 above still guards). Same hierarchy, same shape of
    // candidate list as any nickname collision - just sourced from a city
    // instead of a shared mascot.

    // Single-candidate city ("Green Bay" has exactly one tracked franchise):
    // still goes through the ambiguous candidate list/hierarchy rather than
    // being special-cased, but with only one real option to land on.
    const greenBay = parseCatalog(`Cap\nGreen Bay -6.5`, []).picks[0];
    check(
      "'Green Bay -6.5': single-candidate city surfaces its one real option (Packers/NFL)",
      { sport: greenBay?.sportName, key: greenBay?.ambiguousKey, labels: greenBay?.ambiguous?.map((o) => o.label) },
      { sport: "", key: "green bay", labels: ["Green Bay Packers (NFL)"] }
    );
    check(
      "calendar fallback: 'green bay' resolves to its one option whenever NFL is in season",
      ambiguousOptionsFor("green bay").filter((o) => isSportLabelInSeason(o.sport, new Date("2026-11-01T12:00:00Z"))),
      [{ label: "Green Bay Packers (NFL)", sport: "NFL", nickname: "green bay packers" }]
    );

    // Genuinely multi-candidate city - Chicago has 6 real, currently-tracked
    // franchises across 4 sports (2 of them, MLB's Cubs/White Sox, share a
    // sport) - not just the Detroit-style 1-per-sport case.
    const chicago = parseCatalog(`Cap\nChicago -6.5`, []).picks[0];
    check(
      "'Chicago -6.5': genuinely multi-candidate city (6 franchises, 4 sports)",
      { sport: chicago?.sportName, key: chicago?.ambiguousKey, labels: chicago?.ambiguous?.map((o) => o.label).sort() },
      {
        sport: "",
        key: "chicago",
        labels: [
          "Chicago Bears (NFL)", "Chicago Blackhawks (NHL)", "Chicago Bulls (NBA)",
          "Chicago Cubs (MLB)", "Chicago Sky (WNBA)", "Chicago White Sox (MLB)",
        ].sort(),
      }
    );
    // Calendar fallback can't narrow this one on 2026-09-01 either - MLB
    // (Cubs/White Sox), NFL (Bears), and WNBA (Sky) are all in season
    // simultaneously in early September, so "exactly one in-season
    // candidate" never holds for Chicago the way it does for a single-team
    // city; a real answer here needs the schedule check (see
    // ambiguous-hierarchy-acceptance-test.ts) or a manual choice.
    check(
      "calendar fallback alone can never narrow 'chicago' to one option (multiple sports in season at once)",
      ambiguousOptionsFor("chicago")
        .filter((o) => isSportLabelInSeason(o.sport, new Date("2026-09-01T12:00:00Z")))
        .map((o) => o.sport)
        .sort(),
      ["MLB", "MLB", "NFL", "WNBA"]
    );

    // Full, city-qualified team names are unaffected by the new bare-city key.
    check(
      "'Chicago Cubs ML' still resolves straight to MLB (full name unaffected)",
      parseCatalog(`Cap\nChicago Cubs ML`, []).picks[0]?.sportName,
      "MLB"
    );
    check(
      "'Chicago Bulls ML' still resolves straight to NBA (full name unaffected)",
      parseCatalog(`Cap\nChicago Bulls ML`, []).picks[0]?.sportName,
      "NBA"
    );

    // NCAAF-collision cities ARE now promoted too (PART S, the Texas/
    // Pittsburgh mis-import fix) - detectSport no longer claims them for
    // their school with no signal; each surfaces ambiguous instead.
    {
      const houston = parseCatalog(`Cap\nHouston -6.5`, []).picks[0];
      check("'Houston -6.5' is now ambiguous, not a silent NCAAF guess (Cougars is one candidate)", { sport: houston?.sportName, key: houston?.ambiguousKey }, { sport: "", key: "houston" });
      const miami = parseCatalog(`Cap\nMiami -6.5`, []).picks[0];
      check("'Miami -6.5' is now ambiguous, not a silent NCAAF guess (Hurricanes is one candidate)", { sport: miami?.sportName, key: miami?.ambiguousKey }, { sport: "", key: "miami" });
    }
  }

  // ==========================================================================
  // PART J: NHL team coverage (for the NHL grading build). NHL parser support
  // was added earlier with NHL odds display; this is the persisted regression
  // net for it - every one of the 32 teams resolves, the 4 that collide with
  // another league surface as ambiguous rather than silently guessing, and the
  // city-qualified form of each of those 4 resolves straight to NHL.
  // ==========================================================================
  console.log("\n########## PART J: NHL team coverage ##########");
  {
    // The 28 current franchises (+ "coyotes" legacy alias for Utah Mammoth)
    // whose bare mascot is NHL-unambiguous - NOT rangers/kings/panthers/jets,
    // which collide with an MLB/NBA/NFL team and are checked separately below.
    const bareNhlNicknames = [
      "ducks", "coyotes", "bruins", "sabres", "flames", "hurricanes", "blackhawks",
      "avalanche", "blue jackets", "stars", "red wings", "oilers", "wild",
      "canadiens", "predators", "devils", "islanders", "senators", "flyers",
      "penguins", "sharks", "kraken", "blues", "lightning", "maple leafs",
      "canucks", "golden knights", "capitals", "mammoth",
    ];
    for (const nick of bareNhlNicknames) {
      const title = nick.replace(/\b\w/g, (c) => c.toUpperCase());
      check(
        `bare '${title} ML' resolves to NHL`,
        parseCatalog(`Cap\n${title} ML`, []).picks[0]?.sportName,
        "NHL"
      );
    }

    // The 4 collisions: a bare mascot must surface ambiguous with the NHL team
    // among the options, never silently resolve to one league.
    const collisions: [string, string[]][] = [
      ["Rangers", ["New York Rangers (NHL)", "Texas Rangers (MLB)"]],
      ["Kings", ["Los Angeles Kings (NHL)", "Sacramento Kings (NBA)"]],
      ["Panthers", ["Florida Panthers (NHL)", "Carolina Panthers (NFL)"]],
      ["Jets", ["Winnipeg Jets (NHL)", "New York Jets (NFL)"]],
    ];
    for (const [nick, expectedLabels] of collisions) {
      const pick = parseCatalog(`Cap\n${nick} ML`, []).picks[0];
      check(
        `bare '${nick} ML' surfaces ambiguous (incl. the NHL team), does not silently resolve`,
        { sport: pick?.sportName, options: pick?.ambiguous?.map((o: { label: string }) => o.label).sort() },
        { sport: "", options: [...expectedLabels].sort() }
      );
    }

    // The city-qualified form of each collision resolves straight to NHL.
    check("'New York Rangers ML' resolves straight to NHL", parseCatalog(`Cap\nNew York Rangers ML`, []).picks[0]?.sportName, "NHL");
    check("'Los Angeles Kings ML' resolves straight to NHL", parseCatalog(`Cap\nLos Angeles Kings ML`, []).picks[0]?.sportName, "NHL");
    check("'Florida Panthers ML' resolves straight to NHL", parseCatalog(`Cap\nFlorida Panthers ML`, []).picks[0]?.sportName, "NHL");
    check("'Winnipeg Jets ML' resolves straight to NHL", parseCatalog(`Cap\nWinnipeg Jets ML`, []).picks[0]?.sportName, "NHL");
  }

  // ==========================================================================
  // PART K: CFL team coverage (for the CFL grading build). CFL parser support
  // was mostly in place from earlier work; this build fixed two gaps - "BC
  // Lions" (couldn't resolve to CFL at all, since bare "lions" is NFL/KBO-
  // ambiguous) and "Ottawa Red Blacks" as two words (mis-parsed as a tennis
  // player). This is the persisted regression net for all 9 teams.
  // ==========================================================================
  console.log("\n########## PART K: CFL team coverage ##########");
  {
    // The 7 bare nicknames that resolve straight to CFL.
    const bareCflNicknames = [
      ["Redblacks", ["red blacks", "redblacks"]],
      ["Blue Bombers", ["blue bombers"]],
      ["Roughriders", ["roughriders"]],
      ["Argonauts", ["argonauts"]],
      ["Elks", ["elks"]],
      ["Alouettes", ["alouettes"]],
      ["Stampeders", ["stampeders"]],
      ["Tiger-Cats", ["tiger-cats"]],
    ] as const;
    for (const [nick, teams] of bareCflNicknames) {
      const pick = parseCatalog(`Cap\n${nick} ML`, []).picks[0];
      check(
        `bare '${nick} ML' resolves to CFL`,
        { sport: pick?.sportName, teams: pick?.teamNicknames.slice().sort() },
        { sport: "CFL", teams: [...teams].sort() }
      );
    }

    // Gap fix 1: "BC Lions" - explicit city form resolves to CFL, bare "Lions"
    // stays NFL/KBO-ambiguous (unchanged - no CFL schedule data to break the
    // tie until enable).
    check("'BC Lions ML' resolves to CFL", parseCatalog(`Cap\nBC Lions ML`, []).picks[0]?.sportName, "CFL");
    check(
      "bare 'Lions ML' still surfaces NFL/KBO ambiguous, NOT silently CFL",
      {
        sport: parseCatalog(`Cap\nLions ML`, []).picks[0]?.sportName,
        options: parseCatalog(`Cap\nLions ML`, []).picks[0]?.ambiguous?.map((o: { label: string }) => o.label).sort(),
      },
      { sport: "", options: ["Detroit Lions (NFL)", "Samsung Lions (KBO)"] }
    );

    // Gap fix 2: Ottawa's team, both spellings (The Odds API's is unconfirmed),
    // no longer mis-parses as a tennis player.
    check("'Red Blacks ML' (two words) resolves to CFL, not a phantom ATP pick", parseCatalog(`Cap\nRed Blacks ML`, []).picks[0]?.sportName, "CFL");
    check("'Ottawa Red Blacks +3' resolves to CFL", parseCatalog(`Cap\nOttawa Red Blacks +3`, []).picks[0]?.sportName, "CFL");
    check("'Ottawa Redblacks +3' (one word) still resolves to CFL", parseCatalog(`Cap\nOttawa Redblacks +3`, []).picks[0]?.sportName, "CFL");

    // Bare "Ottawa" (city, no nickname): never a phantom ATP pick. As of the
    // city-name promotion (PART I below) it's no longer left `unresolved`
    // either - it surfaces ambiguous (NHL Senators / CFL Redblacks) through
    // the same hierarchy every other AMBIGUOUS_NICKNAMES key uses.
    check(
      "bare 'Ottawa +7.5' surfaces ambiguous (NHL/CFL), not unresolved and not ATP",
      (() => {
        const r = parseCatalog(`Cap\nOttawa +7.5`, []);
        return { unresolved: r.unresolved, sport: r.picks[0]?.sportName, key: r.picks[0]?.ambiguousKey };
      })(),
      { unresolved: [], sport: "", key: "ottawa" }
    );

    // City-qualified forms of the other 8 teams all resolve to CFL.
    const cityQualified = [
      "Saskatchewan Roughriders ML", "Toronto Argonauts ML", "Hamilton Tiger-Cats ML",
      "Winnipeg Blue Bombers ML", "Montreal Alouettes ML", "Edmonton Elks ML",
      "Calgary Stampeders ML",
    ];
    for (const text of cityQualified) {
      check(`'${text}' resolves to CFL`, parseCatalog(`Cap\n${text}`, []).picks[0]?.sportName, "CFL");
    }
  }

  // ==========================================================================
  // PART L - NCAAF abbreviation gaps: EMU/CMU/WMU/ECU (2026-09)
  // ==========================================================================
  // Reported bug: "EMU -3" failed to resolve even though Eastern Michigan has
  // been in NCAAF_SCHOOLS since the PART H full-FBS widening. Investigation
  // found the school's own full name ("eastern michigan") was already
  // present and resolved fine - only its 3-letter acronym was missing, and
  // it didn't collide with anything else in the app (unlike the earlier
  // same-mascot/cross-sport collisions elsewhere in this file) - it just
  // wasn't in the list, so it landed in `unresolved` (a safe failure, not
  // the ATP phantom-pick fallback from PART H).
  //
  // Not a one-off: Central Michigan and Western Michigan - the other two
  // "directional Michigan" MAC schools in the exact same list section - had
  // the identical gap, while siblings in the same section (Western Kentucky
  // -> wku, Middle Tennessee -> mtsu) already had theirs. East Carolina, in
  // a different conference, had the same kind of gap too. All four are
  // collision-free (confirmed no other entry anywhere claims emu/cmu/wmu/ecu)
  // and are now added to NCAAF_SCHOOLS alongside their existing full names.
  //
  // Deliberately NOT added: MSU/OSU/PSU/ASU/ISU-style acronyms for the
  // several "___ State" schools (Michigan State, Ohio State, Penn State,
  // Arizona State, Iowa State, etc.) - several of those genuinely collide
  // across real schools (MSU = Michigan State or Mississippi State; OSU =
  // Ohio State or Oklahoma State), so adding them would trade a safe
  // "unresolved" gap for a real wrong-school risk. This file's PART D
  // key-count assertion (159 -> 163) is the forcing function that makes any
  // future addition to NCAAF_SCHOOLS a deliberate, reviewed change here too.
  console.log("\n########## PART L: NCAAF abbreviation gaps (EMU/CMU/WMU/ECU) ##########");

  {
    const abbreviations: [string, string, string][] = [
      ["EMU -3", "emu", "eastern michigan eagles"],
      ["CMU -3", "cmu", "central michigan chippewas"],
      ["WMU -3", "wmu", "western michigan broncos"],
      ["ECU -3", "ecu", "east carolina pirates"],
    ];
    for (const [text, nick, canonical] of abbreviations) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`'${text}' resolves to NCAAF (previously unresolved)`, pick?.sportName, "NCAAF");
      check(`'${text}' captures the school nickname, not the bare abbreviation`, pick?.teamNicknames, [nick]);
      check(`'${nick}' canonical is the exact ESPN displayName`, NCAAF_CANONICAL_SUFFIX[nick], canonical);
    }
  }

  // ==========================================================================
  // PART M - rejected-batch investigation: Trojans + 4 FCS schools (2026-09)
  // ==========================================================================
  // A capper batch had 5 real picks stuck "Unmatched - sport not tracked":
  // "Trojans -22.5", "Merrimack +28.5", "Albany +24.5", "Samford +23",
  // "Lindenwood +4.5". Investigation found two distinct causes, both
  // instances of the pre-existing phantom-ATP fallback (docs/resolver-
  // team-gap-followups.md #1), not a new failure mode:
  //   1. "Trojans" is shared by two real, tracked FBS schools (USC, Troy)
  //      but was registered nowhere as a bare nickname - added to
  //      AMBIGUOUS_NICKNAMES (same mechanism as Tigers/Bears/Cardinals/
  //      etc), since no text-based heuristic can pick USC vs Troy.
  //   2. Merrimack/Albany/Samford/Lindenwood are real FCS schools - genuinely
  //      out of NCAAF's tracked scope (both live sources are FBS-only,
  //      docs/resolver-team-gap-followups.md #3), so adding them to
  //      NCAAF_SCHOOLS would not make them resolvable to a real game. Added
  //      to KNOWN_OUT_OF_SCOPE_SCHOOLS instead, so they land in a clean
  //      `unresolved` ("add manually") the same safe way EMU originally
  //      needed to, rather than a false ATP tag.
  console.log("\n########## PART M: Trojans ambiguity + FCS out-of-scope schools ##########");

  {
    // Bare "Trojans" now surfaces the same kind of manual-choice prompt as
    // Tigers/Bears/Cardinals, instead of mistagging ATP.
    const trojans = parseCatalog(`Cap\nTrojans -22.5`, []).picks[0];
    check("'Trojans -22.5' is NOT mistagged ATP", trojans?.sportName, "");
    check("'Trojans -22.5' surfaces the ambiguous prompt", trojans?.ambiguousKey, "trojans");
    check("'Trojans -22.5' offers exactly USC and Troy, both NCAAF", trojans?.ambiguous, [
      { label: "USC Trojans (NCAAF)", sport: "NCAAF", nickname: "usc trojans" },
      { label: "Troy Trojans (NCAAF)", sport: "NCAAF", nickname: "troy trojans" },
    ]);

    // School name stated (no ambiguity) is untouched by the new entry -
    // detectSport's NCAAF pass already resolves these directly and never
    // reaches AMBIGUOUS_NICKNAMES.
    const uscTrojans = parseCatalog(`Cap\nUSC Trojans -22.5`, []).picks[0];
    check("'USC Trojans -22.5' still resolves straight to NCAAF", uscTrojans?.sportName, "NCAAF");
    check("'USC Trojans -22.5' still captures the 'usc' key", uscTrojans?.teamNicknames, ["usc"]);
    const troyTrojans = parseCatalog(`Cap\nTroy Trojans -22.5`, []).picks[0];
    check("'Troy Trojans -22.5' still resolves straight to NCAAF", troyTrojans?.sportName, "NCAAF");
    check("'Troy Trojans -22.5' still captures the 'troy' key", troyTrojans?.teamNicknames, ["troy"]);

    // Choosing either option round-trips to a normal NCAAF pick, the same
    // shape lookupGame (bulk-picks.ts) already handles for every other NCAAF
    // pick - proves the AMBIGUOUS_NICKNAMES nickname field (now the canonical
    // ESPN suffix "usc trojans", so the schedule check and lookupGame's
    // endsWith-match hit the live feed directly with no NCAAF_CANONICAL_SUFFIX
    // round-trip) is wired through.
    const uscChoice = ambiguousOptionsFor("trojans").find((o) => o.nickname === "usc trojans")!;
    const resolvedUsc = resolveAmbiguousPick(trojans!, uscChoice);
    check("choosing 'USC Trojans' resolves to NCAAF with the canonical suffix", resolvedUsc.sportName, "NCAAF");
    check("choosing 'USC Trojans' resolves to NCAAF with the canonical suffix (nicknames)", resolvedUsc.teamNicknames, ["usc trojans"]);

    // The 4 rejected FCS schools: real team names, no longer a false ATP
    // tag - land in `unresolved` instead, same safe failure as any other
    // not-yet-recognized team.
    for (const text of ["Merrimack +28.5", "Albany +24.5", "Samford +23", "Lindenwood +4.5"]) {
      const { picks, unresolved } = parseCatalog(`Cap\n${text}`, []);
      check(`'${text}' is NOT mistagged ATP`, picks[0]?.sportName, undefined);
      check(`'${text}' routes to unresolved (real team, out of tracked scope)`, unresolved, [text]);
    }

    // Guard didn't overreach: real ATP picks (bare surname) are unaffected.
    const djokovic = parseCatalog(`Cap\nDjokovic ML`, []).picks[0];
    check("'Djokovic ML' still resolves ATP (guard is name-specific, not shape-based)", djokovic?.sportName, "ATP");
  }

  // ==========================================================================
  // PART N - the 2026-09 catalog-import "20 skipped picks" investigation,
  //   items 2-4 (item 1, the bare-"Liberty" WNBA/NCAAF collision, is the
  //   schedule-first hierarchy - see ambiguous-hierarchy-acceptance-test.ts).
  //   Every line below is verbatim from a real rejected import that named a
  //   game live on that day's ESPN scoreboard.
  //     2. "vs Liberty" two-team NCAAF lines were being hijacked into a
  //        single-team WNBA pick (bare "liberty" resolved WNBA before the
  //        two-team NCAAF parse ran). Fixed by removing "liberty" from
  //        WNBA_TEAMS + the detectSport ambiguous-key skip.
  //     3. "Miami, Ohio" (comma form) was not a recognized alias for Miami
  //        (OH) RedHawks - only "Miami (OH)" / "Miami OH" / "Miami Ohio" were.
  //     4. The NCAAF trailing-token guard dropped the whole team for
  //        "Tennessee State" (State is the front of a longer real school) and
  //        "West Virginia University" (University is a generic institutional
  //        suffix, not a different school).
  // ==========================================================================
  console.log("\n########## PART N: catalog-import 'skipped picks' items 2-4 ##########");
  {
    // --- Item 2: "vs Liberty" two-team NCAAF lines ---
    const jmVsLib = parseCatalog(`Cody covers spreads\nJames Madison vs Liberty under 51`, []).picks[0];
    check("'James Madison vs Liberty under 51' -> NCAAF two-team, not a WNBA single-team pick", {
      sport: jmVsLib?.sportName,
      teams: jmVsLib?.teamNicknames,
      bet: jmVsLib?.betType,
      side: jmVsLib?.totalSide,
      ambiguous: jmVsLib?.ambiguousKey,
    }, { sport: "NCAAF", teams: ["james madison", "liberty"], bet: "TOTAL", side: "under", ambiguous: undefined });
    // ...and both nicknames map to the ESPN canonical forms lookupGame
    // (bulk-picks.ts) resolves a matchup with.
    check("'James Madison vs Liberty' nicknames -> ESPN canonicals", jmVsLib?.teamNicknames?.map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n), [
      "james madison dukes",
      "liberty flames",
    ]);

    const libVsJmu = parseCatalog(`Dirty Bubble\nLiberty vs JMU under 51.5`, []).picks[0];
    check("'Liberty vs JMU under 51.5' -> NCAAF two-team via the 'jmu' alias", {
      sport: libVsJmu?.sportName,
      teams: libVsJmu?.teamNicknames?.map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n),
      bet: libVsJmu?.betType,
      side: libVsJmu?.totalSide,
    }, { sport: "NCAAF", teams: ["liberty flames", "james madison dukes"], bet: "TOTAL", side: "under" });

    // --- Item 3: "Miami, Ohio" comma form ---
    for (const text of ["Miami, Ohio", "Miami, OH"]) {
      const pick = parseCatalog(`SHARP\n${text}`, []).picks[0];
      check(`'${text}' -> NCAAF Miami (OH) RedHawks`, {
        sport: pick?.sportName,
        canonical: (pick?.teamNicknames ?? []).map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n),
      }, { sport: "NCAAF", canonical: ["miami (oh) redhawks"] });
    }
    const miamiVsPitt = parseCatalog(`Sharp Sheet\nMiami, Ohio vs Pittsburgh under 47.5`, []).picks[0];
    check("'Miami, Ohio vs Pittsburgh under 47.5' -> NCAAF two-team (RedHawks + Panthers)", {
      sport: miamiVsPitt?.sportName,
      teams: (miamiVsPitt?.teamNicknames ?? []).map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n),
      bet: miamiVsPitt?.betType,
      side: miamiVsPitt?.totalSide,
    }, { sport: "NCAAF", teams: ["miami (oh) redhawks", "pittsburgh panthers"], bet: "TOTAL", side: "under" });
    // The bare "Miami -3" (no state) is unaffected by the comma alias either
    // way - it's ambiguous among the Dolphins/Heat/Marlins/Hurricanes now
    // (PART S), same as the other bare 'Miami -3' check above.
    {
      const bareMiami2 = parseCatalog(`Cap\nMiami -3`, []).picks[0];
      check("bare 'Miami -3' is ambiguous, not shadowed by the comma alias", { sport: bareMiami2?.sportName, key: bareMiami2?.ambiguousKey }, { sport: "", key: "miami" });
    }

    // --- Item 4: trailing-token guard on "State" and institutional suffixes ---
    const tnState = parseCatalog(`BEEZOWINS\nTennessee State +47.5`, []).picks[0];
    check("'Tennessee State +47.5' -> NCAAF, keeps the full 'tennessee state' (not dropped, not bare 'tennessee')", {
      sport: tnState?.sportName,
      teams: tnState?.teamNicknames,
      bet: tnState?.betType,
    }, { sport: "NCAAF", teams: ["tennessee state"], bet: "SPREAD" });

    const tnStateVs = parseCatalog(`Vinny\nTennessee State vs George over 54.5`, []).picks[0];
    check("'Tennessee State vs George over 54.5' -> NCAAF, 'tennessee state' captured (opponent typo ignored)", {
      sport: tnStateVs?.sportName,
      teams: tnStateVs?.teamNicknames,
      side: tnStateVs?.totalSide,
    }, { sport: "NCAAF", teams: ["tennessee state"], side: "over" });

    const wvu = parseCatalog(`BET LABS\nWest Virginia University Moneyline`, []).picks[0];
    check("'West Virginia University Moneyline' -> NCAAF, 'University' stripped not read as a different school", {
      sport: wvu?.sportName,
      teams: wvu?.teamNicknames,
      bet: wvu?.betType,
    }, { sport: "NCAAF", teams: ["west virginia"], bet: "MONEYLINE" });

    // Guard still protects the case it was built for: "North Carolina A&T" is
    // a real, longer school we DON'T list - it must NOT silently resolve to
    // the North Carolina Tar Heels. (Also covered at PART H; re-asserted here
    // as the explicit item-4 regression guard.)
    check("'North Carolina A&T +6.5' still captures no nickname (no false Tar Heels match)", parseCatalog(`Cap\nNorth Carolina A&T +6.5`, []).picks[0]?.teamNicknames, []);
    check("'West Virginia +7' (bare, no suffix) still resolves as itself", parseCatalog(`Cap\nWest Virginia +7`, []).picks[0]?.teamNicknames, ["west virginia"]);
  }

  // ==========================================================================
  // PART O - pro-team short-form aliases + a few more NCAAF ones (2026-09)
  // ==========================================================================
  // The Mississippi/Red investigation surfaced that a capper's shorthand
  // often isn't the canonical name we match ("Halos", "Dbacks", "Cubbies",
  // "Bama", "Pitt"). This round adds a CURATED, low-collision set - each
  // token is not an ordinary word in capper text AND maps to exactly one
  // tracked team. The mechanism change: pro aliases aren't a suffix of the
  // real team name (unlike a bare mascot), so like NCAAF school keys they go
  // through TEAM_NICKNAME_CANONICAL before bulk-picks.ts's endsWith
  // game-resolution.
  //
  // Explicitly EXCLUDED from PRO_TEAM_ALIASES (asserted below): tokens that
  // double as a common word or collide across teams - "sox" (Red Sox + White
  // Sox), "red" (Reds + Red Sox + Red Wings + ...), "mississippi" (Ole Miss +
  // Miss State + Southern Miss), "canes" (Hurricanes + Miami), "wings" (Red
  // Wings + Dallas Wings), "bolts" (Lightning + Chargers), "cards"/"cavs"
  // (already ambiguous / cross-sport), "boys"/"caps" (common words). "bucs"
  // (Buccaneers + Pirates) is likewise not a direct alias, but is now an
  // AMBIGUOUS_NICKNAMES key resolved by the schedule/season hierarchy - see
  // the bucs assertions below. The Mississippi/Red picks themselves are a
  // SEPARATE bug (the ATP phantom-pick fallback silently stamping unresolved
  // lines as confident tennis picks - docs/resolver-team-gap-followups.md
  // #1) and are deliberately untouched here.
  console.log("\n########## PART O: pro-team short-form aliases ##########");

  {
    // [alias, expectedSport, expectedCanonicalMascot, realFullScheduleName]
    // The 4th column is the actual live-schedule team name; the canonical must
    // be a suffix of it (what bulk-picks.ts's endsWith game-resolution needs).
    const proAliases: [string, string, string, string][] = [
      // --- original batch (PR #31) ---
      ["dbacks", "MLB", "diamondbacks", "Arizona Diamondbacks"], ["d-backs", "MLB", "diamondbacks", "Arizona Diamondbacks"],
      ["bosox", "MLB", "red sox", "Boston Red Sox"], ["sawx", "MLB", "red sox", "Boston Red Sox"],
      ["chisox", "MLB", "white sox", "Chicago White Sox"],
      ["stros", "MLB", "astros", "Houston Astros"], ["halos", "MLB", "angels", "Los Angeles Angels"],
      ["yanks", "MLB", "yankees", "New York Yankees"], ["nats", "MLB", "nationals", "Washington Nationals"],
      ["cubbies", "MLB", "cubs", "Chicago Cubs"], ["cub", "MLB", "cubs", "Chicago Cubs"],
      ["phils", "MLB", "phillies", "Philadelphia Phillies"],
      ["mavs", "NBA", "mavericks", "Dallas Mavericks"],
      ["iggles", "NFL", "eagles", "Philadelphia Eagles"], ["jags", "NFL", "jaguars", "Jacksonville Jaguars"],
      ["habs", "NHL", "canadiens", "Montreal Canadiens"], ["preds", "NHL", "predators", "Nashville Predators"],
      ["nucks", "NHL", "canucks", "Vancouver Canucks"], ["yotes", "NHL", "coyotes", "Arizona Coyotes"],
      ["leafs", "NHL", "maple leafs", "Toronto Maple Leafs"],
      // --- Tier 1 batch 2 (2026-09), verified below ---
      ["brew crew", "MLB", "brewers", "Milwaukee Brewers"],
      ["pads", "MLB", "padres", "San Diego Padres"],
      ["o's", "MLB", "orioles", "Baltimore Orioles"], ["os", "MLB", "orioles", "Baltimore Orioles"],
      ["jays", "MLB", "blue jays", "Toronto Blue Jays"],
      ["tigs", "MLB", "detroit tigers", "Detroit Tigers"],
      ["m's", "MLB", "mariners", "Seattle Mariners"],
      ["bravos", "MLB", "braves", "Atlanta Braves"],
      ["redlegs", "MLB", "reds", "Cincinnati Reds"],
      ["rox", "MLB", "rockies", "Colorado Rockies"],
      ["cavs", "NBA", "cavaliers", "Cleveland Cavaliers"],
      ["grizz", "NBA", "grizzlies", "Memphis Grizzlies"],
      ["pels", "NBA", "pelicans", "New Orleans Pelicans"],
      ["dubs", "NBA", "warriors", "Golden State Warriors"],
      ["nugs", "NBA", "nuggets", "Denver Nuggets"],
      ["sixers", "NBA", "76ers", "Philadelphia 76ers"],
      ["raps", "NBA", "raptors", "Toronto Raptors"],
      ["niners", "NFL", "49ers", "San Francisco 49ers"],
      ["commies", "NFL", "commanders", "Washington Commanders"],
      ["pats", "NFL", "patriots", "New England Patriots"],
      ["vikes", "NFL", "vikings", "Minnesota Vikings"],
      ["fins", "NFL", "dolphins", "Miami Dolphins"],
      ["falcs", "NFL", "falcons", "Atlanta Falcons"],
      ["avs", "NHL", "avalanche", "Colorado Avalanche"],
      ["isles", "NHL", "islanders", "New York Islanders"],
      ["sens", "NHL", "senators", "Ottawa Senators"],
    ];
    for (const [alias, sport, canonical, fullName] of proAliases) {
      const pick = parseCatalog(`Cap\n${alias} -1.5`, []).picks[0];
      check(`pro alias '${alias}' -> ${sport}`, pick?.sportName, sport);
      check(`pro alias '${alias}' captures itself as the nickname`, pick?.teamNicknames, [alias]);
      check(`pro alias '${alias}' translates to '${canonical}'`, TEAM_NICKNAME_CANONICAL[alias], canonical);
      check(`'${alias}' -> a suffix of "${fullName}"`, fullName.toLowerCase().endsWith(canonical), true);
    }

    // Full names still resolve unchanged, and the alias never fires inside the
    // full name (word boundary) - spot-check across the new batch.
    const fullNameChecks: [string, string, string[]][] = [
      ["Cubs ML", "MLB", ["cubs"]],
      ["Cleveland Cavaliers -3", "NBA", ["cavaliers"]],
      ["Blue Jays -1.5", "MLB", ["blue jays"]],
      ["76ers +2.5", "NBA", ["76ers"]],
      ["49ers -3", "NFL", ["49ers"]],
      ["Guardians ML", "MLB", ["guardians"]],
      ["Cincinnati Reds -1.5", "MLB", ["reds"]],
      ["Colorado Rockies +1.5", "MLB", ["rockies"]],
    ];
    for (const [text, sport, nicks] of fullNameChecks) {
      const p = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`'${text}' still resolves ${sport}, nick ${JSON.stringify(nicks)}`, { s: p?.sportName, n: p?.teamNicknames }, { s: sport, n: nicks });
    }

    // A short alias must not fire as a substring inside a longer team phrase
    // or another team's alias.
    check("'Mavs -3' is 'mavs', not 'avs' (Avalanche)", parseCatalog(`Cap\nMavs -3`, []).picks[0]?.teamNicknames, ["mavs"]);
    check("'Stros ML' is 'stros', not 'os' (Orioles)", parseCatalog(`Cap\nStros ML`, []).picks[0]?.teamNicknames, ["stros"]);

    // teamGroupAliases (the /live grouping match) returns the new slang forms
    // too, including "tigs" whose canonical is the full name.
    check("teamGroupAliases('Chicago Cubs','MLB')", teamGroupAliases("Chicago Cubs", "MLB").sort(), ["cub", "cubbies", "cubs"]);
    check("teamGroupAliases('Cleveland Cavaliers','NBA')", teamGroupAliases("Cleveland Cavaliers", "NBA").sort(), ["cavaliers", "cavs"]);
    check("teamGroupAliases('Detroit Tigers','MLB') includes 'tigs' (full-name canonical)", teamGroupAliases("Detroit Tigers", "MLB").sort(), ["tigers", "tigs"]);
    check("teamGroupAliases('Philadelphia 76ers','NBA')", teamGroupAliases("Philadelphia 76ers", "NBA").sort(), ["76ers", "sixers"]);
    check("teamGroupAliases for a team with no alias is unchanged", teamGroupAliases("New York Mets", "MLB"), ["mets"]);

    // The three verification drops must NOT resolve as a direct pro alias.
    check("'wiz' stays KBO (KT Wiz), not added as an NBA alias", parseCatalog(`Cap\nWiz -3`, []).picks[0]?.sportName, "KBO");
    check("'guards' -> unresolved (common word, not added)", parseCatalog(`Cap\nGuards -1.5`, []).picks[0], undefined);
    check("bare 'ms' -> unresolved (MS/Mississippi abbrev, not added)", parseCatalog(`Cap\nMs -1.5`, []).picks[0], undefined);
    check("'m's' (apostrophe form) IS added -> MLB Mariners", parseCatalog(`Cap\nM's -1.5`, []).picks[0]?.teamNicknames, ["m's"]);

    // Post-translation dedup (bulk-picks.ts): a capper writing both forms
    // must not hand lookupGame a phantom two-team matchup.
    for (const [full, alias] of [["diamondbacks", "dbacks"], ["76ers", "sixers"], ["49ers", "niners"], ["cavaliers", "cavs"]]) {
      const both = [...new Set([full, alias].map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n))];
      check(`'${full}' + '${alias}' collapse to one nickname after translation`, both.length, 1);
    }
  }

  {
    // The 7 added NCAAF school aliases (school-keyed, so no mechanism change).
    const ncaafAliases: [string, string, string][] = [
      ["bama", "alabama crimson tide", "Bama -7"],
      ["uga", "georgia bulldogs", "UGA -14"],
      ["mizzou", "missouri tigers", "Mizzou +3"],
      ["tamu", "texas a&m aggies", "TAMU ML"],
      ["wvu", "west virginia mountaineers", "WVU +7"],
      ["cuse", "syracuse orange", "Cuse -2.5"],
      ["pitt", "pittsburgh panthers", "Pitt -6.5"],
    ];
    for (const [nick, canonical, text] of ncaafAliases) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`NCAAF alias '${text}' -> NCAAF`, pick?.sportName, "NCAAF");
      check(`NCAAF alias '${nick}' captured as the school key`, pick?.teamNicknames, [nick]);
      check(`NCAAF alias '${nick}' canonical is the exact ESPN displayName`, NCAAF_CANONICAL_SUFFIX[nick], canonical);
    }
    // The alias must not fire inside the school's own full name.
    check("'Alabama Crimson Tide -7' still just 'alabama' (no spurious 'bama')", parseCatalog(`Cap\nAlabama Crimson Tide -7`, []).picks[0]?.teamNicknames, ["alabama"]);
  }

  {
    // Excluded tokens: not in the alias translation table, so no bare pick
    // with one newly resolves to a pro team via a Tier 1 alias. Covers the
    // long-standing common-word / cross-team excludes, the three dropped from
    // the Tier 1 batch-2 list during verification (wiz -> KT Wiz KBO
    // collision; guards -> basketball-position common word; bare "ms" -> the
    // "MS"/Mississippi State abbreviation), and every Tier 2/3 / real-collision
    // item held out of this pass. (A bare NBA/NFL nickname like "blazers" is
    // still resolvable as a mascot - this only asserts it was not ADDED as a
    // canonical-translated alias here.)
    const excluded = [
      "sox", "red", "mississippi", "bucs", "canes", "wings", "bolts", "cards", "boys", "caps",
      "wiz", "guards", "ms",
      "wolves", "blazers", "clips", "okc", "cs", "c's", "g-men", "gang green", "pack", "da bears",
      "as", "a's", "fish", "pens", "cats", "rags", "hawks", "jets", "giants", "rangers", "panthers",
    ];
    for (const token of excluded) {
      check(`excluded '${token}': absent from the alias translation table`, TEAM_NICKNAME_CANONICAL[token], undefined);
    }
    // "Sox" / "Red" as a bare pick still do not resolve to MLB.
    check("bare 'Sox -1.5' does not resolve to MLB", parseCatalog(`Cap\nSox -1.5`, []).picks[0]?.sportName === "MLB", false);
    check("bare 'Red -1.5' does not resolve to MLB", parseCatalog(`Cap\nRed -1.5`, []).picks[0]?.sportName === "MLB", false);
    // "bucs" no longer just drops to `unresolved`: it's an AMBIGUOUS_NICKNAMES
    // key now (Buccaneers NFL / Pirates MLB), resolved by the schedule->season
    // ->context hierarchy - see the bucs section in ambiguous-hierarchy-
    // acceptance-test.ts. It still doesn't resolve to a sport directly here.
    {
      const p = parseCatalog(`Cap\nBucs ML`, []).picks[0];
      check("bare 'Bucs ML' -> ambiguous key 'bucs', not a direct sport", { sport: p?.sportName, key: p?.ambiguousKey }, { sport: "", key: "bucs" });
      check("bare 'Bucs ML' options are Buccaneers/Pirates", p?.ambiguous?.map((o) => o.sport), ["NFL", "MLB"]);
    }
    check("'Buccaneers ML' still resolves NFL directly", parseCatalog(`Cap\nBuccaneers ML`, []).picks[0]?.sportName, "NFL");
    check("'Pirates ML' still resolves MLB directly", parseCatalog(`Cap\nPirates ML`, []).picks[0]?.sportName, "MLB");
    // Full "Red Sox" / "White Sox" still resolve (regression).
    check("'Red Sox -1.5' still resolves MLB", parseCatalog(`Cap\nRed Sox -1.5`, []).picks[0]?.teamNicknames, ["red sox"]);
    check("'White Sox -1.5' still resolves MLB", parseCatalog(`Cap\nWhite Sox -1.5`, []).picks[0]?.teamNicknames, ["white sox"]);
  }

  // ==========================================================================
  // PART P - the ATP phantom-pick fix (docs/resolver-team-gap-followups.md #1)
  // ==========================================================================
  // findPlayerPick used to accept ANY 1-4 Title-Case word candidate before a
  // bet keyword as a confident ATP tennis pick, purely because every other
  // resolver failed. Real data corruption: the two 2026-09-06 stuck picks
  // "Mississippi -6.5" and "Red +1.5" were both stamped ATP with the raw bet
  // text left in the pick's homeTeam, ungradeable forever. The fix requires
  // POSITIVE tennis evidence - a known player, tennis bet vocabulary, or an
  // explicit "tennis" word - otherwise the line routes to `unresolved`
  // (where the recover-unresolved-picks pass then re-checks it against the
  // real live schedule).
  console.log("\n########## PART P: ATP phantom-pick fix ##########");

  {
    // --- The two real stuck picks: now unresolved, never phantom ATP ---
    for (const text of ["Mississippi -6.5", "Red +1.5"]) {
      const { picks, unresolved } = parseCatalog(`SomeCapper\n${text}`, []);
      check(`'${text}': no phantom ATP pick`, picks.length, 0);
      check(`'${text}': routes to unresolved for manual review`, unresolved, [text]);
    }

    // In a tennis-context batch, the real tennis picks still resolve and only
    // the non-tennis lines fall out - the "sibling picks are ATP" context
    // does NOT drag Mississippi/Red along.
    const { picks: mixed, unresolved: mixedUnresolved } = parseCatalog(
      `TennisCapper\nSinner ML\nAlcaraz -1.5\nMississippi -6.5\nRed +1.5`,
      []
    );
    check("tennis batch: only the real ATP picks resolve", mixed.map((p) => `${p.sportName}:${p.teamNicknames[0]}`), ["ATP:sinner", "ATP:alcaraz"]);
    check("tennis batch: the non-tennis lines are unresolved", mixedUnresolved, ["Mississippi -6.5", "Red +1.5"]);

    // --- Genuine ATP picks MUST still resolve (positive test cases) ---
    const validAtp: [string, string][] = [
      ["Tallon Griekspoor ML", "griekspoor"],
      ["Griekspoor -150", "griekspoor"],
      ["Sinner ML", "sinner"],
      ["Alcaraz Over 22.5", "alcaraz"],
      ["Djokovic ML", "djokovic"],
      ["Lorenzo Musetti ML", "musetti"],
      ["Coco Gauff ML", "gauff"],
      ["Sabalenka -3.5", "sabalenka"],
    ];
    for (const [text, key] of validAtp) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`valid ATP '${text}' still resolves`, { sport: pick?.sportName, key: pick?.teamNicknames[0] }, { sport: "ATP", key });
    }

    // An unlisted player is still accepted when the line carries tennis
    // vocabulary - the vocabulary is the safety valve so the player list
    // doesn't have to be exhaustive. (Player name still first, vocab after,
    // the way a real tennis prop is written.)
    const gamesTotal = parseCatalog(`Cap\nKrueger over 21.5 games`, []).picks[0];
    check("unlisted name + 'over N games' vocab still resolves ATP", gamesTotal?.sportName, "ATP");
    const gamesWon = parseCatalog(`Cap\nHartono -4.5 total games won`, []).picks[0];
    check("unlisted name + 'games won' vocab still resolves ATP", gamesWon?.sportName, "ATP");
    const straightSets = parseCatalog(`Cap\nVanhicksville ML in straight sets`, []).picks[0];
    check("unlisted name + 'straight sets' vocab still resolves ATP", straightSets?.sportName, "ATP");

    // --- The guard: non-tennis mystery names route to unresolved ---
    // ("Carolina" is deliberately excluded - it has an AMBIGUOUS_NICKNAMES
    //  entry via "panthers"/"hurricanes" and its own resolution path.)
    for (const text of [
      "Wildcats ML",
      "Bulldogs -7",
      "Coventry +2",
      "Vermont -3.5",
      "Springfield ML",
    ]) {
      const { picks, unresolved } = parseCatalog(`Cap\n${text}`, []);
      check(`guard: '${text}' does not become a phantom ATP pick`, picks.some((p) => p.sportName === "ATP"), false);
      check(`guard: '${text}' routes to unresolved`, unresolved, [text]);
    }

    // A recognized team phrase that somehow reaches findPlayerPick is still
    // never tennis (defense in depth - normally resolved far upstream).
    const cardinals = parseCatalog(`Cap\nCardinals ML`, []).picks[0];
    check("guard: bare 'Cardinals' is the ambiguous prompt, never phantom ATP", { sport: cardinals?.sportName, key: cardinals?.ambiguousKey }, { sport: "", key: "cardinals" });
  }

  // ==========================================================================
  // PART Q - Alabama State / Montana State FCS gap (2026-09 3-bug report)
  // ==========================================================================
  // Two reported bugs, same root cause: neither school was in NCAAF_SCHOOLS,
  // even though both are FCS "money game" opponents that DO appear on ESPN's
  // FBS scoreboard (same shape as Tennessee State, PART L/comment above).
  // Confirmed live against ESPN's FCS team list (groups=81) before fixing:
  // both display as "Alabama State Hornets" / "Montana State Bobcats"
  // verbatim, so the plain school-name key is safe to add the same way.
  //
  // Bug 2 ("Ben Burns - Alabama State moneyline" -> "Couldn't match 1 pick to
  // today's schedule" despite Alabama State @ Troy being live): NOT a
  // truncation bug, NOT an ambiguity/disambiguation issue, NOT an FBS/FCS
  // data-source gap - purely a missing list entry. Troy (the FBS side) was
  // already resolvable; only "alabama state" was absent.
  //
  // Bug 3 ("Ben burns" (lowercase) resolved to "Unknown", and the pick landed
  // under "Totals & other markets" instead of grouped by team): investigation
  // disproved the task's own case-sensitivity theory (byte-identical output
  // parsing "Ben Burns" vs "Ben burns" against the same unresolved line) -
  // capper-name matching is already case-insensitive everywhere it's
  // compared (normalizeName / .toLowerCase()). The REAL cause: "Montana
  // State" wasn't in NCAAF_SCHOOLS, so the pick fell into `unresolved` with
  // no chance to carry its header's capper name forward, and separately
  // NCAAF_TEAMS/GROUPING_TEAM_NICKNAMES (both derived FROM NCAAF_SCHOOLS)
  // had no entry either, so team-grouping fell back to "OTHER". One fix -
  // adding the missing school - closes both symptoms, since GROUPING_TEAM_
  // NICKNAMES/NCAAF_CANONICAL_SUFFIX/TEAM_NICKNAME_CANONICAL all cascade from
  // NCAAF_SCHOOLS (see parse-catalog.ts).
  console.log("\n########## PART Q: Alabama State / Montana State FCS gap ##########");
  {
    // --- Bug 2's exact reported text ---
    const benBurnsAlState = parseCatalog(`Ben Burns\nAlabama State moneyline`, []).picks[0];
    check("'Ben Burns - Alabama State moneyline' resolves (was 'Couldn't match to schedule')", {
      sport: benBurnsAlState?.sportName,
      teams: benBurnsAlState?.teamNicknames,
      bet: benBurnsAlState?.betType,
      capper: benBurnsAlState?.capperName,
      canonical: (benBurnsAlState?.teamNicknames ?? []).map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n),
    }, { sport: "NCAAF", teams: ["alabama state"], bet: "MONEYLINE", capper: "Ben Burns", canonical: ["alabama state hornets"] });

    // --- Bug 3's exact reported shape: lowercase header + a Montana State pick ---
    const benBurnsLowerMtState = parseCatalog(`Ben burns\nMontana State ML`, []).picks[0];
    check("'Ben burns' (lowercase) + 'Montana State ML' now resolves - capper is 'Ben burns', NOT 'Unknown'", {
      sport: benBurnsLowerMtState?.sportName,
      teams: benBurnsLowerMtState?.teamNicknames,
      bet: benBurnsLowerMtState?.betType,
      capper: benBurnsLowerMtState?.capperName,
      canonical: (benBurnsLowerMtState?.teamNicknames ?? []).map((n) => NCAAF_CANONICAL_SUFFIX[n] ?? n),
    }, { sport: "NCAAF", teams: ["montana state"], bet: "MONEYLINE", capper: "Ben burns", canonical: ["montana state bobcats"] });

    // Case never mattered (the disproven theory) - the properly-capitalized
    // header resolves identically once the team itself is resolvable.
    const benBurnsUpperMtState = parseCatalog(`Ben Burns\nMontana State ML`, []).picks[0];
    check("properly-capitalized 'Ben Burns' + Montana State resolves the same way (case was never the cause)", {
      capper: benBurnsUpperMtState?.capperName,
      teams: benBurnsUpperMtState?.teamNicknames,
    }, { capper: "Ben Burns", teams: ["montana state"] });

    // Both new schools also work as a bet-line target, not just moneyline.
    const alStateSpread = parseCatalog(`Cap\nAlabama State +6.5`, []).picks[0];
    check("'Alabama State +6.5' resolves NCAAF spread", { sport: alStateSpread?.sportName, teams: alStateSpread?.teamNicknames, bet: alStateSpread?.betType }, { sport: "NCAAF", teams: ["alabama state"], bet: "SPREAD" });
    const mtStateTotal = parseCatalog(`Cap\nMontana State over 51.5`, []).picks[0];
    check("'Montana State over 51.5' resolves NCAAF total", { sport: mtStateTotal?.sportName, teams: mtStateTotal?.teamNicknames, side: mtStateTotal?.totalSide }, { sport: "NCAAF", teams: ["montana state"], side: "over" });
  }

  // ==========================================================================
  // PART R - surname/school collision guard (2026-09 bulk-import NFL prop
  // investigation): a bare player-prop line with no team prefix ("Rashee Rice
  // Over 59.5 Receiving Yards") was silently importing as NCAAF - "Rice" (the
  // Rice Owls' NCAAF_SCHOOLS key) matched inside the player's own surname,
  // and nothing about detectSport's team-matching had any notion that the
  // word right before a matched team key could be a person's first name
  // rather than a qualifier. This wasn't a "wrong sport" guess so much as a
  // false-positive team match - a real Rice Owls game genuinely existed on
  // the live schedule, so the pick "resolved" and imported cleanly, just
  // tagged to the wrong player's wrong sport entirely.
  //
  // The fix (isPlayerPropSurnameCollision in parse-catalog.ts) reuses
  // parsePlayerProp (bet-line.ts) to check whether the matched single-word
  // team key is the LAST word of a genuine player-prop name it already
  // extracted - deliberately narrow: multi-word team phrases are exempt (no
  // realistic surname collides word-for-word with "west virginia"), and a
  // team total's "Over N.N Points/Goals" text never triggers it at all since
  // neither is one of parsePlayerProp's five recognized stat markets. This
  // guard only stops the FALSE match; it doesn't (and isn't meant to) resolve
  // these lines to NFL - that requires an actual player->team roster lookup,
  // a separate, larger gap tracked outside this fix. Un-prefixed player-prop
  // lines correctly land in `unresolved` here, same as any other pick this
  // parser has no way to identify a team for - "couldn't match" instead of
  // "matched to the wrong sport" is the whole point of this guard.
  console.log("\n########## PART R: surname/school collision guard (Rashee Rice -> NCAAF) ##########");
  {
    // --- The exact reported bug: silently mistagged NCAAF, not just wrong. ---
    const rashee = parseCatalog(`Cap\nRashee Rice Over 59.5 Receiving Yards`, []);
    check("'Rashee Rice Over 59.5 Receiving Yards' no longer resolves NCAAF (Rice Owls false match)", rashee.picks.length, 0);
    check("'Rashee Rice Over 59.5 Receiving Yards' routes to unresolved instead of a wrong-sport pick", rashee.unresolved, ["Rashee Rice Over 59.5 Receiving Yards"]);

    // --- Same collision shape, a different real player + supported market. ---
    const jerry = parseCatalog(`Cap\nJerry Rice Over 2.5 Receptions`, []);
    check("'Jerry Rice Over 2.5 Receptions' also no longer resolves NCAAF", jerry.picks.length, 0);
    check("'Jerry Rice Over 2.5 Receptions' routes to unresolved", jerry.unresolved, ["Jerry Rice Over 2.5 Receptions"]);

    // --- Negative controls: the guard must not touch REAL team matches for
    // the exact same collision-prone school keys the bug report flagged
    // (Rice, Houston, Duke), bare or team-prefixed, with no preceding surname
    // in front of them. ---
    const riceOwls = parseCatalog(`Cap\nRice Owls -3.5`, []).picks[0];
    check("'Rice Owls -3.5' still resolves NCAAF (Rice Owls, unaffected)", { sport: riceOwls?.sportName, teams: riceOwls?.teamNicknames }, { sport: "NCAAF", teams: ["rice"] });

    const houstonCougars = parseCatalog(`Cap\nHouston Cougars -6.5`, []).picks[0];
    check("'Houston Cougars -6.5' still resolves NCAAF (unaffected)", { sport: houstonCougars?.sportName, teams: houstonCougars?.teamNicknames }, { sport: "NCAAF", teams: ["houston"] });

    const dukeBlueDevils = parseCatalog(`Cap\nDuke Blue Devils -3.5`, []).picks[0];
    check("'Duke Blue Devils -3.5' still resolves NCAAF (unaffected)", { sport: dukeBlueDevils?.sportName, teams: dukeBlueDevils?.teamNicknames }, { sport: "NCAAF", teams: ["duke"] });

    // --- Negative control: a real, correctly team-prefixed player-prop line
    // (the app's documented shape for this feature) must still resolve NFL -
    // the guard only fires when the matched key is the LAST word of the
    // extracted name, never the first, so "Chiefs" here is untouched. ---
    const kelce = parseCatalog(`Cap\nChiefs Travis Kelce Over 42.5 Receiving Yards`, []).picks[0];
    check("'Chiefs Travis Kelce Over 42.5 Receiving Yards' still resolves NFL (team-prefixed prop, unaffected)", { sport: kelce?.sportName, teams: kelce?.teamNicknames }, { sport: "NFL", teams: ["chiefs"] });

    // --- Negative control: a real team total using a stat word outside
    // parsePlayerProp's five recognized markets must still resolve normally -
    // proves the guard can't be fooled into suppressing a genuine team pick
    // just because "Over N.N" is present. ---
    const heat = parseCatalog(`Cap\nMiami Heat ML`, []).picks[0];
    check("'Miami Heat ML' still resolves NBA (unaffected)", { sport: heat?.sportName, teams: heat?.teamNicknames }, { sport: "NBA", teams: ["heat"] });
  }

  // --- "o"/"u" shorthand with a space before the number ("o 8.5", not just
  // flush "o8.5") is a first-class betting format, not an edge case - real
  // cappers write both. Confirms the classification actually changes for a
  // team total (TOTAL/over, not the MONEYLINE default a spaced shorthand
  // used to silently fall through to), and that flush/spaced/spelled-out
  // forms are all equivalent. ---
  {
    const flushOver = parseCatalog(`Cap\nCubs o8.5`, []).picks[0];
    check("'Cubs o8.5' (flush shorthand, unaffected) -> TOTAL/over", { betType: flushOver?.betType, totalSide: flushOver?.totalSide }, { betType: "TOTAL", totalSide: "over" });

    const spacedOver = parseCatalog(`Cap\nCubs o 8.5`, []).picks[0];
    check("'Cubs o 8.5' (spaced shorthand) -> TOTAL/over, same as flush", { betType: spacedOver?.betType, totalSide: spacedOver?.totalSide }, { betType: "TOTAL", totalSide: "over" });

    const flushUnder = parseCatalog(`Cap\nCubs u8.5`, []).picks[0];
    check("'Cubs u8.5' (flush shorthand, unaffected) -> TOTAL/under", { betType: flushUnder?.betType, totalSide: flushUnder?.totalSide }, { betType: "TOTAL", totalSide: "under" });

    const spacedUnder = parseCatalog(`Cap\nCubs u 8.5`, []).picks[0];
    check("'Cubs u 8.5' (spaced shorthand) -> TOTAL/under, same as flush", { betType: spacedUnder?.betType, totalSide: spacedUnder?.totalSide }, { betType: "TOTAL", totalSide: "under" });

    // The real reported case: a two-team total with no other bet-type
    // keyword. Before the fix this fell all the way through parsePickText's
    // branch chain to the MONEYLINE default - a genuine misclassification,
    // not just a missed recognition.
    const lakersWarriors = parseCatalog(`Cap\nLakers Warriors o 221.5`, []).picks[0];
    check(
      "'Lakers Warriors o 221.5' classifies as TOTAL/over, not MONEYLINE",
      { betType: lakersWarriors?.betType, totalSide: lakersWarriors?.totalSide },
      { betType: "TOTAL", totalSide: "over" }
    );
  }

  // --- Bug 1: unresolvedCapperNames stays parallel to `unresolved` and
  // carries the real capper header, never reconstructed after the fact from
  // text position. ---
  {
    const single = parseCatalog("Godfather\ncaleb williams over 220.5 passing yard", ["Godfather"]);
    check("single-capper bare prop: still lands in unresolved (picks stays empty)", single.picks.length, 0);
    check(
      "single-capper bare prop: unresolvedCapperNames carries 'Godfather', not lost/blank",
      single.unresolvedCapperNames,
      ["Godfather"]
    );

    const multi = parseCatalog(
      "Capper A\nCubs -1.5\nBare Player Prop A Over 1.5 Passing Yards\n\nCapper B\nBare Player Prop B Over 2.5 Rushing Yards",
      ["Capper A", "Capper B"]
    );
    check(
      "multi-capper paste: each unresolved line keeps its OWN header capper, in order",
      multi.unresolvedCapperNames,
      ["Capper A", "Capper B"]
    );

    const noHeader = parseCatalog("Bare Player Prop Over 3.5 Rushing Yards", []);
    check("no header at all -> unresolvedCapperNames is 'Unknown'", noHeader.unresolvedCapperNames, ["Unknown"]);
  }

  // ==========================================================================
  // PART S - Texas/Pittsburgh mis-import fix (2026-09): two real reported
  // cases where a bare city/state-name pick silently attached to the WRONG
  // game entirely and imported cleanly, with no warning and no ambiguity
  // flag - the same shape of bug the AMBIGUOUS_NICKNAMES table exists to
  // prevent for shared NICKNAMES (Cardinals, Bucs, Jets...), but that a
  // hardcoded "these 14 cities collide with an NCAAF school, leave them
  // alone" exclusion list (plus "texas"/"florida" separately misfiled as
  // non-pro-franchise states) had accidentally carved out entirely:
  //   1. "Frankie Diamonds - Texas Moneyline" (meant the MLB Texas Rangers,
  //      a game from the day before) silently attached to a Texas Longhorns
  //      (NCAAF) game days in the future.
  //   2. "TIGERS KITCHEN - Pittsburgh Moneyline" (meant the MLB Pittsburgh
  //      Pirates, a game from days before) silently attached to a
  //      Pittsburgh Panthers (NCAAF) game days in the future.
  // Root cause: detectSport's pass 1 resolves a bare word straight to
  // whichever TEAM_SPORT_ENTRIES phrase matches it with total confidence,
  // and "texas"/"pittsburgh" (and 14 similar cities) were NCAAF_SCHOOLS
  // keys but were never also AMBIGUOUS_NICKNAMES keys - so pass 1 found
  // exactly one candidate (the NCAAF school) and returned immediately,
  // never reaching findAmbiguousNickname/the schedule-first hierarchy at
  // all. The fix promotes all 16 affected cities (see the AMBIGUOUS_NICKNAMES
  // "Bare CITY names" comment in parse-catalog.ts) into real
  // AMBIGUOUS_NICKNAMES keys, so they run the exact same
  // schedule -> season -> pick-context hierarchy every other ambiguous
  // nickname already does - never a silent guess.
  // ==========================================================================
  console.log("\n########## PART S: Texas/Pittsburgh mis-import fix (bare city/state collides with an NCAAF school) ##########");
  {
    // --- The exact two reported cases: bare city/state name is now flagged
    // ambiguous (not silently resolved), and the real, live-schedule name of
    // the intended pro team AND the NCAAF school it was wrongly attaching to
    // are both present as real candidates. ---
    const texasPick = parseCatalog(`Frankie Diamonds\nTexas Moneyline`, []).picks[0];
    check(
      "'Texas Moneyline' is flagged ambiguous, not silently attached to the Longhorns",
      { sport: texasPick?.sportName, key: texasPick?.ambiguousKey, labels: texasPick?.ambiguous?.map((o) => o.label).sort() },
      { sport: "", key: "texas", labels: ["Texas Longhorns (NCAAF)", "Texas Rangers (MLB)"].sort() }
    );

    const pittsburghPick = parseCatalog(`Tigers Kitchen\nPittsburgh Moneyline`, []).picks[0];
    check(
      "'Pittsburgh Moneyline' is flagged ambiguous, not silently attached to the Panthers",
      { sport: pittsburghPick?.sportName, key: pittsburghPick?.ambiguousKey, labels: pittsburghPick?.ambiguous?.map((o) => o.label).sort() },
      {
        sport: "",
        key: "pittsburgh",
        labels: [
          "Pittsburgh Pirates (MLB)", "Pittsburgh Steelers (NFL)",
          "Pittsburgh Penguins (NHL)", "Pittsburgh Panthers (NCAAF)",
        ].sort(),
      }
    );

    // --- Negative controls: an explicit, unambiguous nickname for either
    // side of each collision still resolves immediately, exactly as before -
    // this fix is scoped to the bare city/state word only. ---
    const rangersExplicit = parseCatalog(`Cap\nTexas Rangers Moneyline`, []).picks[0];
    check("'Texas Rangers Moneyline' (explicit MLB nickname) still resolves MLB immediately", { sport: rangersExplicit?.sportName, teams: rangersExplicit?.teamNicknames }, { sport: "MLB", teams: ["texas rangers"] });

    const longhornsExplicit = parseCatalog(`Cap\nTexas Longhorns Moneyline`, []).picks[0];
    check("'Texas Longhorns Moneyline' (explicit NCAAF school) still resolves NCAAF immediately", longhornsExplicit?.sportName, "NCAAF");

    const piratesExplicit = parseCatalog(`Cap\nPittsburgh Pirates Moneyline`, []).picks[0];
    check("'Pittsburgh Pirates Moneyline' (explicit MLB nickname) still resolves MLB immediately", { sport: piratesExplicit?.sportName, teams: piratesExplicit?.teamNicknames }, { sport: "MLB", teams: ["pirates"] });

    const steelersExplicit = parseCatalog(`Cap\nPittsburgh Steelers Moneyline`, []).picks[0];
    check("'Pittsburgh Steelers Moneyline' (explicit NFL nickname) still resolves NFL immediately", { sport: steelersExplicit?.sportName, teams: steelersExplicit?.teamNicknames }, { sport: "NFL", teams: ["steelers"] });

    const panthersExplicit = parseCatalog(`Cap\nPittsburgh Panthers Moneyline`, []).picks[0];
    check("'Pittsburgh Panthers Moneyline' (explicit NCAAF school) still resolves NCAAF immediately", panthersExplicit?.sportName, "NCAAF");

    // --- A third real ambiguous city/state name found while scoping this
    // bug (Florida: NHL's Florida Panthers vs NCAAF's Florida Gators, same
    // shape as Texas/Pittsburgh - was misfiled in US_STATE_NAMES on the
    // wrong assumption Florida had no state-branded pro franchise). ---
    const floridaPick = parseCatalog(`Cap\nFlorida Moneyline`, []).picks[0];
    check(
      "'Florida Moneyline' is flagged ambiguous (Panthers vs Gators), not silently attached to the Gators",
      { sport: floridaPick?.sportName, key: floridaPick?.ambiguousKey, labels: floridaPick?.ambiguous?.map((o) => o.label).sort() },
      { sport: "", key: "florida", labels: ["Florida Gators (NCAAF)", "Florida Panthers (NHL)"].sort() }
    );
  }

  // ==========================================================================
  // PART T - N. Texas mis-resolving to Texas Longhorns (2026-09 3-bug report,
  // catalog-import investigation).
  // ==========================================================================
  // Reported bug: "N. Texas versus Texas State over 62.5" didn't resolve to
  // North Texas at all - "n. texas" / "n texas" weren't recognized NCAAF_
  // SCHOOLS keys (only the spelled-out "north texas" was), so findTeamNicknames
  // fell through PAST a safe "no match" and instead matched the bare "texas"
  // substring embedded inside "N. Texas", silently resolving the pick to the
  // Texas Longhorns instead of the North Texas Mean Green - a confident WRONG
  // match, not the safe "lands unmatched" failure this class of gap normally
  // produces (contrast PART L's EMU/CMU/WMU/ECU gaps, which were genuinely
  // collision-free and just missing). Fixed the same way PART L did: added
  // "n texas" and "n. texas" as NCAAF_SCHOOLS keys pointing at the same
  // canonical ("north texas mean green") as "north texas" already does.
  //
  // Systemic-gap check done alongside this fix (not auto-applied): North
  // Carolina and South Carolina share the same "directional-word, no
  // abbreviated form" shape and are real risk candidates for a future pass,
  // but weren't touched here - no confirmed real-capper-text evidence for
  // them yet, and this fix is scoped to the one confirmed report. South
  // Florida/East Carolina/West Virginia/etc. already have their most-common
  // abbreviation covered (usf/ecu/wvu), so they're lower risk and also left
  // alone.
  console.log("\n########## PART T: N. Texas abbreviation fix (mis-resolved to Texas Longhorns) ##########");
  {
    // --- The exact reported case: North Texas's own nickname is captured,
    // not the bare "texas" substring embedded inside "N. Texas". ---
    const reported = parseCatalog(`Cap\nN. Texas versus Texas State over 62.5`, []).picks[0];
    check(
      "'N. Texas versus Texas State over 62.5' resolves NCAAF with North Texas's own key (not 'texas')",
      { sport: reported?.sportName, teams: reported?.teamNicknames?.slice().sort() },
      { sport: "NCAAF", teams: ["n. texas", "texas state"].sort() }
    );

    // --- Both abbreviation spellings resolve directly, same as PART L's
    // EMU/CMU/WMU/ECU additions. ---
    for (const [text, nick] of [["N. Texas -3", "n. texas"], ["N Texas -3", "n texas"]] as const) {
      const pick = parseCatalog(`Cap\n${text}`, []).picks[0];
      check(`'${text}' resolves to NCAAF`, pick?.sportName, "NCAAF");
      check(`'${text}' captures North Texas's own key, not bare 'texas'`, pick?.teamNicknames, [nick]);
      check(`'${nick}' canonical is North Texas's exact ESPN displayName`, NCAAF_CANONICAL_SUFFIX[nick], "north texas mean green");
    }

    // --- Negative control: the spelled-out form and the bare Longhorns
    // nickname are both untouched by this fix. ---
    const spelledOut = findTeamNicknames("North Texas -3", "NCAAF");
    check("'North Texas -3' (spelled out, unchanged) still resolves via 'north texas'", spelledOut, ["north texas"]);
    const longhorns = findTeamNicknames("Texas -3", "NCAAF");
    check("bare 'Texas -3' (unchanged) still resolves via 'texas', not affected by the N. Texas fix", longhorns, ["texas"]);

    // --- Regression: the FCS "no match" safety guard (PART M/Q's Portland
    // State / Northern Iowa class) is untouched - a merged/no-separator
    // matchup naming an untracked FCS school still comes back with NO team
    // nicknames captured, rather than this fix's canonical-suffix lookup
    // somehow making it guess a wrong school the way the pre-fix "texas"
    // substring match used to. ---
    check(
      "FCS guard still fires: 'Oregon Portland State -14.5' captures no team (Portland State is FCS, untracked)",
      findTeamNicknames("Oregon Portland State -14.5", "NCAAF"),
      []
    );
    check(
      "FCS guard still fires: 'Iowa Northern Iowa over 49.45' captures no team (Northern Iowa is FCS, untracked)",
      findTeamNicknames("Iowa Northern Iowa over 49.45", "NCAAF"),
      []
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
