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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
