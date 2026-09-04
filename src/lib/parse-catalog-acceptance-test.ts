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
import { parseCatalog, inferSportFromPickContext, NCAAF_CANONICAL_SUFFIX, ambiguousOptionsFor } from "./parse-catalog";
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
  {
    const { picks, unresolved } = parseCatalog(
      `Bambino 19-0 NRFI Run \u{1F4AA}\n\nFull Card\nYankees vs Blue Jays NRFI\nRedSox ML\nAstros ML\nBraves ML\nCarrington o3.5 Rebounds`,
      []
    );
    check("Bambino: no unresolved lines", unresolved, []);
    check("Bambino: 5 real picks recovered", picks.length, 5);
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
    const carrington = picks.find((p) => p.description.includes("Carrington"));
    check(
      "Bambino: 'Carrington o3.5 Rebounds' resolves as a real TOTAL/over prop pick, not a fake capper header",
      { sport: carrington?.sportName, bet: carrington?.betType, side: carrington?.totalSide },
      { sport: "ATP", bet: "TOTAL", side: "over" }
    );
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
  // capitalized words per side, so this correctly stays unresolved instead
  // of being misread as a two-fighter MMA matchup - and, via the matchup-
  // shape signal in looksLikePick, does NOT fall through to becoming a fake
  // capper either.
  {
    const { picks, unresolved } = parseCatalog(`Gridiron Capper\n\nOttawa vs Winnipeg Over 56.5\nBraves ML`, []);
    check("Ottawa/Winnipeg: stays unresolved (not an MMA fighter match, not a pick)", unresolved, ["Ottawa vs Winnipeg Over 56.5"]);
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

  // The specific wrong-guess this round's inferSportFromPickContext fix
  // prevents: generic baseball wording ("ML") is NOT MLB-exclusive once KBO
  // is a candidate (KBO uses identical terminology) - before the fix this
  // returned "MLB" for all three baseball-worded cases below, silently
  // mis-resolving a real KBO pick. Genuinely sport-specific NFL wording, and
  // the pre-existing MLB-vs-NFL Cardinals case, are confirmed unaffected.
  {
    check(
      "Context fix: 'Tigers ML' vs [MLB, KBO] no longer guesses MLB",
      inferSportFromPickContext("Tigers ML", ["MLB", "KBO"]),
      null
    );
    check(
      "Context fix: 'Twins run line -1.5' vs [MLB, KBO] no longer guesses MLB",
      inferSportFromPickContext("Twins run line -1.5", ["MLB", "KBO"]),
      null
    );
    check(
      "Context fix: 'Giants ML' vs [MLB, NFL, KBO] no longer guesses MLB",
      inferSportFromPickContext("Giants ML", ["MLB", "NFL", "KBO"]),
      null
    );
    check(
      "Context fix: genuinely NFL-worded 'Eagles spread -3' vs [NFL, KBO] still resolves NFL",
      inferSportFromPickContext("Eagles spread -3", ["NFL", "KBO"]),
      "NFL"
    );
    check(
      "Context fix: pre-existing 'Cardinals ML' vs [MLB, NFL] (no KBO) is unaffected",
      inferSportFromPickContext("Cardinals ML", ["MLB", "NFL"]),
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
    // stray dupe or a dropped entry is caught.
    check("NCAAF list: 163 keys (138 FBS schools + capper-shorthand aliases)", keys.length, 163);
    check("NCAAF list: no duplicate keys", new Set(keys).size, keys.length);

    // (a) Every key resolves to NCAAF from realistic capper text (the key +
    // a bet keyword) - no mascot needed. "liberty" is the one deliberate
    // exception: it is shared with WNBA's New York Liberty, which wins the
    // bare form by list order (see NCAAF_SCHOOLS' comment) - "Liberty
    // Flames" and two-team lines still resolve NCAAF (covered in PART H).
    const misresolved = keys.filter((key) => {
      if (key === "liberty") return false;
      const pick = parseCatalog(`Capper\n${key} ML`, []).picks[0];
      return pick?.sportName !== "NCAAF";
    });
    check("NCAAF list: every key (except bare 'liberty') resolves to NCAAF from a bare pick", misresolved, []);

    const liberty = parseCatalog(`Capper\nLiberty ML`, []).picks[0];
    check("bare 'Liberty' resolves WNBA (New York Liberty wins the bare form), not NCAAF", liberty?.sportName, "WNBA");
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
    // any pro list, not in AMBIGUOUS_NICKNAMES) either before or after this
    // change - confirmed live that this already falls through to
    // findPlayerPick's ATP phantom-pick fallback (a single capitalized word
    // before "ML" looks like a one-word player name) - a pre-existing,
    // NCAAF-unrelated gap, not something this change creates OR fixes. The
    // only thing that matters here is that it's still ATP, never NCAAF.
    for (const word of ["Wildcats", "Bulldogs", "Knights", "Cougars"]) {
      const pick = parseCatalog(`Capper\n${word} ML`, []).picks[0];
      check(`in-sport collision '${word}': unaffected pre-existing behavior (ATP phantom fallback), never NCAAF`, pick?.sportName, "ATP");
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

    const bareWashington = parseCatalog(`Capper\nWashington ML`, []).picks[0];
    check("bare 'Washington' (no mascot) still resolves NCAAF", bareWashington?.sportName, "NCAAF");

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

    const { picks } = parseCatalog(text, []);
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
    check(
      "Hammering Hank: parenthetical-record header resolves to the capper",
      byCapper("Hammering Hank").map((p) => p.description),
      ["Coventry +2"]
    );
    check("Bet Labs: WNBA sub-header picks attributed correctly", byCapper("Bet Labs").length, 1);
    check("All 12 real picks recovered across the 5 sections", picks.length, 12);
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
    check("bare 'Miami -3' still resolves NCAAF as Miami FL (Hurricanes)", parseCatalog(`Cap\nMiami -3`, []).picks[0]?.teamNicknames, ["miami"]);

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
    // Season step of the disambiguation hierarchy (resolve-ambiguous-catalog.ts
    // step 1): in September only MLB is in season, so "Boston" resolves to the
    // Red Sox with no schedule call.
    check(
      "season step: on 2026-09-01 exactly one Boston option is in season (MLB / Red Sox)",
      ambiguousOptionsFor("boston").filter((o) => isSportLabelInSeason(o.sport, new Date("2026-09-01T12:00:00Z"))),
      [{ label: "Boston Red Sox (MLB)", sport: "MLB", nickname: "red sox" }]
    );
    // Overlap window: MLB (through Nov 5) and NHL (from Oct 7) are both in
    // season on Oct 15, so the season step correctly does NOT guess - it
    // defers to the schedule check.
    check(
      "season step: on 2026-10-15 two Boston options are in season (defers, no guess)",
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
    const ottawa = parseCatalog(`Sharp Sheet\nOttawa +7.5`, []);
    check("'Ottawa +7.5': routes to unresolved, no phantom ATP pick", { picks: ottawa.picks.length, unresolved: ottawa.unresolved }, { picks: 0, unresolved: ["Ottawa +7.5"] });

    const denver = parseCatalog(`Cap\nDenver -3.5`, []);
    check("'Denver -3.5': bare city routes to unresolved", denver.unresolved, ["Denver -3.5"]);

    const ny = parseCatalog(`Cap\nNew York Over 8.5`, []);
    check("'New York Over 8.5': multi-word city routes to unresolved (not ATP 'york')", ny.unresolved, ["New York Over 8.5"]);

    // The guard must not eat a following real pick.
    const mixed = parseCatalog(`Cap\nDenver -3.5\nYankees ML`, []);
    check(
      "'Denver -3.5' then 'Yankees ML': Denver unresolved, Yankees still resolves MLB for the same capper",
      {
        unresolved: mixed.unresolved,
        yanks: mixed.picks.map((p) => ({ capper: p.capperName, sport: p.sportName, teams: p.teamNicknames })),
      },
      { unresolved: ["Denver -3.5"], yanks: [{ capper: "Cap", sport: "MLB", teams: ["yankees"] }] }
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

    // Bare "Ottawa" (city, no nickname) still routes to unresolved, not a
    // phantom ATP pick - unchanged by this build.
    check("bare 'Ottawa +7.5' still routes to unresolved", parseCatalog(`Cap\nOttawa +7.5`, []).unresolved, ["Ottawa +7.5"]);

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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
