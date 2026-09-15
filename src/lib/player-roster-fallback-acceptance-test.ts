// Proof for player-roster-fallback.ts (the roster-based fallback for bare
// NFL player-prop lines with no team prefix), run with:
//   npx tsx src/lib/player-roster-fallback-acceptance-test.ts
//
// Same "never guess" posture as live-team-fallback-acceptance-test.ts: these
// tests lean hard on the non-resolving cases (ambiguous, unresolved,
// non-prop lines) as much as on the happy path.
//
// PART A reproduces the real rejected lines from the 2026-09 bulk-import
// investigation (patrick Mahomes/Jaylen Waddle/Travis Kelce/Courtland
// Sutton/Evan Engram - the six players; 8 of their 10 originally-rejected
// lines, since the other 2 used "Rushing Attempts", a market this app
// doesn't support yet - explicitly out of scope, see the investigation
// report) against the real KC/Denver rosters (extracted from the same
// fixtures nfl-roster-acceptance-test.ts verifies).
//
// PART B adds one real-roster case beyond the original 6 - Kenneth Walker
// III - specifically to cover ESPN's generational-suffix normalization
// (stripNameSuffix), using his real supported-market rushing-yards line (not
// his originally-reported, unsupported "Rushing Attempts" line).
//
// PART C is a constructed (not real-roster) same-name collision: two
// distinct players sharing an identical full name on two different teams -
// exercises the ambiguity mechanism itself, which a real current-NFL exact
// duplicate name isn't needed to prove.
import { extractRosterPlayers } from "@/server/data/nfl-roster";
import { resolvePlayerPropAgainstRoster } from "./player-roster-fallback";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const FIX = join(__dirname, "..", "server", "data", "__fixtures__");
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

const kc = extractRosterPlayers("Kansas City Chiefs", loadFixture("nfl-roster-kc.json"));
const den = extractRosterPlayers("Denver Broncos", loadFixture("nfl-roster-den.json"));
const roster: RosterPlayer[] = [...kc, ...den];

console.log("\n########## PART A: the real rejected lines (8 of 10 - supported markets only) ##########");
{
  const cases: [string, string][] = [
    ["Jaylen Waddle Over 55.5 Receiving Yards", "Denver Broncos"],
    ["Patrick Mahomes Over 13.5 Rushing Yards", "Kansas City Chiefs"],
    ["Travis Kelce Over 39.5 Receiving Yards", "Kansas City Chiefs"],
    ["Patrick Mahomes Over 225 Passing Yards", "Kansas City Chiefs"],
    ["Courtland Sutton Over 41.5 Receiving Yards", "Denver Broncos"],
    ["Evan Engram Over 22.5 Receiving Yards", "Denver Broncos"],
    ["Patrick Mahomes Under 15.5 Rushing Yards", "Kansas City Chiefs"],
    ["Jaylen Waddle Under 59.5 Receiving Yards", "Denver Broncos"],
  ];
  for (const [line, team] of cases) {
    const r = resolvePlayerPropAgainstRoster(line, roster);
    check(`'${line}' resolves NFL, ${team}, exact`, { status: r.status, sport: (r as any).sport, team: (r as any).team, via: (r as any).via }, {
      status: "resolved",
      sport: "NFL",
      team,
      via: "exact",
    });
  }
}

console.log("\n########## PART B: generational-suffix normalization (real roster, constructed line) ##########");
{
  // Kenneth Walker III's real, currently-listed team (per the KC roster
  // fixture) and a supported market (RUSH_YDS) - the original bug report's
  // own Kenneth Walker line used "Rushing Attempts", which this app doesn't
  // grade yet, so this substitutes the same real player/team on a market
  // this fallback can actually resolve, specifically to prove the "III"
  // suffix ESPN's roster carries doesn't block a capper's un-suffixed text
  // from matching.
  const r = resolvePlayerPropAgainstRoster("Kenneth Walker Over 45.5 Rushing Yards", roster);
  check("'Kenneth Walker Over 45.5 Rushing Yards' resolves NFL, Kansas City Chiefs, exact (suffix-stripped)", {
    status: r.status,
    sport: (r as any).sport,
    team: (r as any).team,
    playerName: (r as any).playerName,
    via: (r as any).via,
  }, {
    status: "resolved",
    sport: "NFL",
    team: "Kansas City Chiefs",
    playerName: "Kenneth Walker III",
    via: "exact",
  });
}

console.log("\n########## PART C: intentional same-name ambiguity - never guessed ##########");
{
  // Constructed, not from a real roster - two distinct players (different
  // espnPlayerId) sharing an identical full name across two teams. This is
  // the textbook case #4 of the roster-lookup task exists to protect
  // against: a lookup that guesses wrong on an ambiguous name reintroduces
  // the exact class of bug #83 fixed, just relocated to the new roster path
  // instead of parse-catalog.ts's team-name matching.
  const ambiguousRoster: RosterPlayer[] = [
    ...roster,
    { playerName: "Marcus Johnson", team: "Kansas City Chiefs", espnPlayerId: "9000001" },
    { playerName: "Marcus Johnson", team: "Denver Broncos", espnPlayerId: "9000002" },
  ];
  const r = resolvePlayerPropAgainstRoster("Marcus Johnson Over 45.5 Receiving Yards", ambiguousRoster);
  check("a name matching two distinct players on two different teams stays 'ambiguous', not guessed", r, {
    status: "ambiguous",
    matches: [
      { playerName: "Marcus Johnson", team: "Kansas City Chiefs" },
      { playerName: "Marcus Johnson", team: "Denver Broncos" },
    ],
  });
}

console.log("\n########## Negative controls ##########");
{
  const r1 = resolvePlayerPropAgainstRoster("Cowboys ML", roster);
  check("a non-player-prop-shaped line (no supported market) is untouched - stays 'unresolved', never routed through roster matching", r1, {
    status: "unresolved",
  });

  const r2 = resolvePlayerPropAgainstRoster("Some Guy Nobody Heard Of Over 5.5 Receiving Yards", roster);
  check("a player-prop-shaped line whose name isn't on either roster stays 'unresolved'", r2, { status: "unresolved" });

  // A team-prefixed player-prop line (the existing, documented shape) is
  // never even routed to this fallback in the real pipeline - parseCatalog
  // already resolves it directly - but confirms this function itself
  // doesn't choke on the extra "Chiefs" token: parsePlayerProp's own
  // extraction leaves the team word in playerName (see bulk-picks.ts's
  // stripTeamNamesFromPlayerName comment), so it correctly does NOT
  // exact/fuzzy-match "chiefs travis kelce" against "Travis Kelce" and stays
  // unresolved here - exactly why the real pipeline resolves this shape
  // earlier and never reaches this fallback for it.
  const r3 = resolvePlayerPropAgainstRoster("Chiefs Travis Kelce Over 42.5 Receiving Yards", roster);
  check("a team-prefixed line isn't (mis)resolved by this fallback either - it's handled earlier in the real pipeline", r3, {
    status: "unresolved",
  });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
