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
import { parseCatalog } from "./parse-catalog";

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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
