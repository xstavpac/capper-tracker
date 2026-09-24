// Proof for recoverUnresolvedLines (this file) plus parseCatalog's
// unresolvedCapperNames tracking (parse-catalog.ts) - run with:
//   npx tsx src/lib/recover-unresolved-lines-acceptance-test.ts
//
// Pure - no network, no database, no auth (constructs its own RosterPlayer/
// LiveTeam fixtures directly), same pattern as
// player-prop-odds-resolution-acceptance-test.ts. Proves the capper-
// attribution bug: a header line ("godfather") matches an existing capper
// correctly during parseCatalog's own pass, but the pick needing recovery
// (no team name, so it can't resolve directly) used to lose that
// attribution entirely and come back "Unknown" - because the only place it
// was ever known (parseCatalog's own currentCapper) was discarded the
// moment the line was pushed into `unresolved`, and the old recovery-side
// reconstruction (inferCapperFor, now deleted) could only search
// already-DIRECTLY-resolved picks, which don't exist for a single-pick or
// all-recovered-picks paste.
import { parseCatalog } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { parsePlayerProp } from "@/lib/bet-line";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { LiveTeam } from "@/lib/live-team-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const roster: RosterPlayer[] = [
  { playerName: "Mike Evans", firstName: "Mike", lastName: "Evans", team: "Tampa Bay Buccaneers", position: "WR", espnPlayerId: "1" },
  { playerName: "Caleb Williams", firstName: "Caleb", lastName: "Williams", team: "Chicago Bears", position: "QB", espnPlayerId: "2" },
  { playerName: "Bijan Robinson", firstName: "Bijan", lastName: "Robinson", team: "Atlanta Falcons", position: "RB", espnPlayerId: "3" },
];
const liveTeams: LiveTeam[] = [];

function main() {
  // Case 1: one capper + one team-less recoverable player prop -> the
  // recovered pick carries the real capper, not "Unknown" - the exact
  // originally-reported bug ("godfather" / Caleb Williams passing-yards prop).
  {
    const { unresolved, unresolvedCapperNames } = parseCatalog(
      "Godfather\ncaleb williams over 220.5 passing yard",
      ["Godfather"]
    );
    const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, roster);
    check("case1: recovers exactly one pick", recovered.length, 1);
    check("case1: capperName is 'Godfather', not 'Unknown'", recovered[0]?.capperName, "Godfather");
    check("case1: nothing left in stillUnresolved", stillUnresolved, []);
  }

  // Case 2: multiple cappers, each with their own team-less recoverable
  // prop - attribution must not collapse to whichever capper's pick (if
  // any) happened to resolve directly first. Capper B here has NO directly-
  // resolved pick at all, which is exactly the case the old inferCapperFor
  // got wrong (it could only search already-resolved picks).
  {
    const { unresolved, unresolvedCapperNames } = parseCatalog(
      "Capper A\nmike evans over 56.5 rec yards\n\nCapper B\nbijan robinson over 65.5 rushing yards",
      ["Capper A", "Capper B"]
    );
    const { recovered } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, roster);
    check("case2: recovers two picks", recovered.length, 2);
    check(
      "case2: each pick keeps its OWN capper, not collapsed to the first/only one",
      recovered.map((p) => p.capperName),
      ["Capper A", "Capper B"]
    );
  }

  // Case 3: existing directly-resolved picks are completely unaffected -
  // parseCatalog's `picks` array and its capperName attribution never
  // touch the unresolved/recovery path at all.
  {
    const { picks, unresolved } = parseCatalog("Capper A\nCubs -1.5", ["Capper A"]);
    check("case3: directly-resolved pick still attributes correctly", picks[0]?.capperName, "Capper A");
    check("case3: nothing pushed to unresolved for a directly-resolved pick", unresolved, []);
  }

  // Case 4: genuinely unattributed input (no header line at all) still
  // behaves as "Unknown" - not silently guessed at from an unrelated
  // nearby capper.
  {
    const { unresolved, unresolvedCapperNames } = parseCatalog("mike evans over 56.5 rec yards", []);
    check("case4: no header at all -> unresolvedCapperNames is 'Unknown'", unresolvedCapperNames, ["Unknown"]);
    const { recovered } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, roster);
    check("case4: recovered pick (roster still resolves the player) is attributed 'Unknown'", recovered[0]?.capperName, "Unknown");
  }

  // Case 5: a genuinely unmatched player (not on the fixture roster) stays
  // unresolved - never guessed, same policy as before this fix.
  {
    const { unresolved, unresolvedCapperNames } = parseCatalog(
      "Some Capper\nnobody realname over 10.5 rushing yards",
      ["Some Capper"]
    );
    const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, roster);
    check("case5: unmatched player -> nothing recovered", recovered.length, 0);
    check("case5: unmatched player -> stays in stillUnresolved", stillUnresolved, ["nobody realname over 10.5 rushing yards"]);
  }

  // Case 6 (2026-09, later, separate investigation): a bare surname with no
  // first name and no team ("Gibbs over 65.5 rushing yards") resolves
  // through this exact same real pipeline - parseCatalog leaves it
  // unresolved (same as any other team-less player prop), then
  // recoverUnresolvedLines's roster fallback resolves it via the new
  // bare-surname tier (player-roster-fallback.ts) - proving the fix isn't
  // just correct in isolation but actually reachable from a real catalog
  // paste, with capper attribution intact.
  {
    const bijanGibbsRoster: RosterPlayer[] = [
      ...roster,
      { playerName: "Jahmyr Gibbs", firstName: "Jahmyr", lastName: "Gibbs", team: "Detroit Lions", position: "RB", espnPlayerId: "4" },
    ];
    const { unresolved, unresolvedCapperNames } = parseCatalog(
      "godfather\nGibbs over 65.5 rushing yards",
      ["godfather"]
    );
    const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, bijanGibbsRoster);
    check("case6: bare surname recovers exactly one pick", recovered.length, 1);
    check("case6: capperName is 'godfather', not 'Unknown'", recovered[0]?.capperName, "godfather");
    check("case6: resolves to Jahmyr Gibbs's team (Detroit Lions)", recovered[0]?.teamNicknames, ["detroit lions"]);
    check("case6: nothing left in stillUnresolved", stillUnresolved, []);
  }

  // Case 7 (2026-09, later - "Allen anytime touchdown"/"Moore over 62.5
  // receiving yards" investigation): a genuine bare-surname collision
  // (multiple distinct roster players sharing a surname) that used to stay
  // unresolved no matter what now resolves when another pick in the SAME
  // paste already established a team that narrows it to exactly one of the
  // colliding players - see player-roster-fallback.ts's pasteTeamMentions
  // param. Reproduces the real Josh Allen (Buffalo Bills) vs Keenan Allen
  // (Indianapolis Colts) collision end-to-end through the real pipeline
  // (parseCatalog -> recoverUnresolvedLines), verified separately against
  // the live-DB-backed roster (747 real players, including this exact real
  // 2-way collision) before being written here as a fixture-based regression
  // test.
  {
    const allenRoster: RosterPlayer[] = [
      ...roster,
      { playerName: "Josh Allen", firstName: "Josh", lastName: "Allen", team: "Buffalo Bills", position: "QB", espnPlayerId: "5" },
      { playerName: "Keenan Allen", firstName: "Keenan", lastName: "Allen", team: "Indianapolis Colts", position: "WR", espnPlayerId: "6" },
    ];

    // 7a: no other context in the paste at all -> stays unresolved, same as
    // before this fix (the collision alone is never "close enough").
    {
      const { picks, unresolved, unresolvedCapperNames } = parseCatalog("Godfather\nAllen anytime touchdown", ["Godfather"]);
      const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, allenRoster, picks);
      check("case7a: no paste context -> nothing recovered", recovered.length, 0);
      check("case7a: no paste context -> stays unresolved", stillUnresolved, ["Allen anytime touchdown"]);
    }

    // 7b: an earlier pick in the SAME paste (same capper block) already
    // resolved the Colts directly (a real ParsedPick.teamNicknames entry,
    // not live-schedule data - liveTeams is still empty here) - narrows the
    // collision to exactly one player and resolves it.
    {
      const { picks, unresolved, unresolvedCapperNames } = parseCatalog(
        "Godfather\nColts -3\nAllen anytime touchdown",
        ["Godfather"]
      );
      const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, allenRoster, picks);
      check("case7b: recovers exactly one pick using paste-local context", recovered.length, 1);
      check("case7b: resolves to Keenan Allen's team (Indianapolis Colts)", recovered[0]?.teamNicknames, ["indianapolis colts"]);
      check("case7b: capper attribution intact", recovered[0]?.capperName, "Godfather");
      check("case7b: nothing left in stillUnresolved", stillUnresolved, []);
    }

    // 7c: the narrowing context comes from a line THIS SAME recovery pass
    // resolves (not an already-resolved `picks` entry, unlike 7b/7d) - both
    // lines start out unresolved, and the team line only resolves via the
    // live-team fallback (a fictitious "Springfield Isotopes" team with no
    // static NFL nickname at all, standing in for Keenan Allen's team here
    // specifically so this case is decoupled from real NFL nickname
    // coverage, which already resolves almost every real team name directly
    // via the static list - see 7b/7d for that path). Proves
    // nonPlayerPropResolutions, not just resolvedPicks, feeds
    // pasteTeamMentions.
    {
      const springfieldAllenRoster: RosterPlayer[] = [
        ...roster,
        { playerName: "Josh Allen", firstName: "Josh", lastName: "Allen", team: "Buffalo Bills", position: "QB", espnPlayerId: "5" },
        { playerName: "Keenan Allen", firstName: "Keenan", lastName: "Allen", team: "Springfield Isotopes", position: "WR", espnPlayerId: "6" },
      ];
      const { picks, unresolved, unresolvedCapperNames } = parseCatalog(
        "Godfather\nAllen anytime touchdown\nSpringfield ML",
        ["Godfather"]
      );
      check("case7c sanity: both lines start out unresolved (no static or already-resolved context)", unresolved.length, 2);
      const { recovered, stillUnresolved } = recoverUnresolvedLines(
        unresolved,
        unresolvedCapperNames,
        [{ sport: "NFL", name: "Springfield Isotopes" }],
        springfieldAllenRoster,
        picks
      );
      check("case7c: both lines recover", recovered.length, 2);
      check(
        "case7c: the Allen collision resolves to Keenan Allen's team, narrowed by the OTHER line's same-pass resolution",
        recovered.find((p) => p.description === "Allen anytime touchdown")?.teamNicknames,
        ["springfield isotopes"]
      );
      check("case7c: nothing left in stillUnresolved", stillUnresolved, []);
    }

    // 7d: context that narrows the field but NOT down to exactly one player
    // still stays unresolved - proves this never loosens into "any context
    // is enough," only "context that lands on exactly one player" is.
    {
      const twoOnSameTeamRoster: RosterPlayer[] = [
        ...allenRoster,
        { playerName: "Kyle Allen", firstName: "Kyle", lastName: "Allen", team: "Buffalo Bills", position: "QB", espnPlayerId: "7" },
      ];
      const { picks, unresolved, unresolvedCapperNames } = parseCatalog(
        "Godfather\nBills -3\nAllen anytime touchdown",
        ["Godfather"]
      );
      const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, twoOnSameTeamRoster, picks);
      check("case7d: paste context that still leaves 2 candidates (Josh Allen AND Kyle Allen, both Bills) stays unresolved, not guessed", recovered.length, 0);
      check("case7d: stays in stillUnresolved", stillUnresolved, ["Allen anytime touchdown"]);
    }
  }

  // Case 8 (2026-09, later - "Christian Watson Over 4.5 Receptions" catalog-
  // import bug): a bare NFL player-prop line whose surname collides with a
  // KNOWN_TENNIS_PLAYERS entry (parse-catalog.ts) used to get silently
  // stamped as a confident ATP pick and never even reach `unresolved`, so
  // this recovery pipeline never got a chance to run on it at all - see
  // parse-catalog-acceptance-test.ts's PART V for the findPlayerPick-level
  // fix. This proves the fix is reachable end-to-end from a real catalog
  // paste: the line now DOES reach `unresolved`, and this real roster-based
  // pipeline resolves it to a genuine NFL pick - reproducing the exact
  // repro (Christian Watson, Packers WR) plus every other supported prop
  // market, each paired with a player whose surname is a real
  // KNOWN_TENNIS_PLAYERS collision. `derivedFields` mirrors exactly what
  // bulk-picks.ts's createPicksAction does at save time (parsePlayerProp on
  // a PLAYER_PROP pick's description, populating the Pick.playerName/
  // propMarket columns) - not a second, parallel derivation - so this
  // proves the actual saved-row shape, not just this file's own
  // ParsedPick/sportName/betType fields.
  {
    const watsonRoster: RosterPlayer[] = [
      ...roster,
      { playerName: "Christian Watson", firstName: "Christian", lastName: "Watson", team: "Green Bay Packers", position: "WR", espnPlayerId: "10" },
      { playerName: "Kyler Murray", firstName: "Kyler", lastName: "Murray", team: "Arizona Cardinals", position: "QB", espnPlayerId: "11" },
      { playerName: "Derek Korda", firstName: "Derek", lastName: "Korda", team: "Springfield Isotopes", position: "QB", espnPlayerId: "12" },
      { playerName: "Marcus Paul", firstName: "Marcus", lastName: "Paul", team: "Springfield Isotopes", position: "RB", espnPlayerId: "13" },
      { playerName: "Xavier Fritz", firstName: "Xavier", lastName: "Fritz", team: "Springfield Isotopes", position: "RB", espnPlayerId: "14" },
      // "Mike Evans" is already in the base `roster` fixture (Tampa Bay Buccaneers).
    ];

    function derivedFields(description: string, betType: string) {
      const playerProp = betType === "PLAYER_PROP" ? parsePlayerProp(description) : null;
      return { playerName: playerProp?.playerName, propMarket: playerProp?.propMarket };
    }

    const cases: [string, string, string][] = [
      ["Christian Watson Over 4.5 Receptions", "Christian Watson", "RECEPTIONS"],
      ["Mike Evans Over 76.5 Receiving Yards", "Mike Evans", "REC_YDS"],
      ["Kyler Murray Over 35.5 Rushing Yards", "Kyler Murray", "RUSH_YDS"],
      ["Derek Korda Over 245.5 Passing Yards", "Derek Korda", "PASS_YDS"],
      ["Marcus Paul Anytime TD", "Marcus Paul", "TD"],
      ["Xavier Fritz Over 95.5 Rush + Rec Yards", "Xavier Fritz", "RUSH_REC_YDS"],
    ];
    for (const [text, expectedPlayerName, expectedMarket] of cases) {
      const { picks, unresolved, unresolvedCapperNames } = parseCatalog(`Todd Fuhrman\n${text}`, [], [
        "Christian Watson",
        "Mike Evans",
        "Kyler Murray",
        "Derek Korda",
        "Marcus Paul",
        "Xavier Fritz",
      ]);
      check(`'${text}': never resolved directly as a phantom ATP pick`, picks.length, 0);
      check(`'${text}': reaches unresolved`, unresolved, [text]);

      const { recovered, stillUnresolved } = recoverUnresolvedLines(unresolved, unresolvedCapperNames, liveTeams, watsonRoster);
      check(`'${text}': recovers exactly one pick`, recovered.length, 1);
      check(`'${text}': resolves NFL, not ATP`, recovered[0]?.sportName, "NFL");
      check(`'${text}': betType is PLAYER_PROP`, recovered[0]?.betType, "PLAYER_PROP");
      check(`'${text}': capper attribution intact`, recovered[0]?.capperName, "Todd Fuhrman");
      check(
        `'${text}': saved playerName/propMarket match the real Pick-row derivation`,
        derivedFields(recovered[0]?.description ?? "", recovered[0]?.betType ?? ""),
        { playerName: expectedPlayerName, propMarket: expectedMarket }
      );
      check(`'${text}': nothing left in stillUnresolved`, stillUnresolved, []);
    }
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
