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
//   PART D - NCAAF week-1 curated launch (Power 4 + Notre Dame, 68 schools),
//     keyed by school name rather than bare mascot (see NCAAF_SCHOOLS'
//     comment in parse-catalog.ts for why). Verifies all 68 resolve to
//     NCAAF from realistic capper text, and - the actual point of the
//     school-name design - that none of the 7 mascots shared by 2+ curated
//     schools (Tigers/Wildcats/Bulldogs/Knights/Devils/Cougars/Bears) or the
//     7 mascots already claimed by an existing NFL/NBA/NHL entry
//     (Ducks/Bruins/Devils/Cowboys/Raiders/Hurricanes/Cavaliers) resolve to
//     NCAAF, or to a different school than before, when typed bare. Where
//     that bare-mascot behavior was previously undocumented here, this
//     records what it actually verified to be (some are a pre-existing,
//     unrelated ATP phantom-pick fallback via findPlayerPick - not
//     "unresolved" - confirmed live before writing these assertions, not
//     assumed).
//   PART E - Washington/Mystics investigation: an NCAAF school name sharing
//     a word with a different sport's real team ("Washington Mystics" ->
//     WNBA, not NCAAF's Washington Huskies) was resolving to the wrong
//     sport because TEAM_SPORT_ENTRIES was matched purely longest-string-
//     first. Also covers the inverse - a school's OWN real mascot already
//     claimed bare by an NFL/NBA/NHL entry ("Oregon Ducks", "UCLA Bruins")
//     must still resolve NCAAF.
import { parseCatalog, inferSportFromPickContext, NCAAF_CANONICAL_SUFFIX } from "./parse-catalog";

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
      { sport: "CFL", teams: ["blue bombers", "redblacks"] }
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
    check("NCAAF curated list: exactly 68 schools", keys.length, 68);
    check("NCAAF curated list: no duplicate keys", new Set(keys).size, keys.length);

    // (a) Every one of the 68 schools resolves to NCAAF from realistic
    // capper text (school name + a bet keyword) - no mascot needed.
    const misresolved = keys.filter((key) => {
      const pick = parseCatalog(`Capper\n${key} ML`, []).picks[0];
      return pick?.sportName !== "NCAAF";
    });
    check("NCAAF curated list: all 68 schools resolve to NCAAF from a bare school-name pick", misresolved, []);
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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
