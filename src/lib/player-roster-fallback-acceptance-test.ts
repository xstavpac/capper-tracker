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
//
// PART D (2026-09, later) is the bare-surname tier added for the "Gibbs over
// 65.5 rushing yards" investigation - a capper-typed line with no first name
// and no team at all. D1/D2 reproduce the real reported line and the
// existing full-name case side by side against the real KC/DEN/DET rosters;
// D3 is a constructed multi-candidate collision (same shape as PART C, but
// for the new surname tier) proving a second same-surname player anywhere on
// the roster keeps the line unresolved rather than guessed; D4 confirms
// resolving never requires a network call (roster here is 100% fixture
// data, same as PART A-C).
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
const det = extractRosterPlayers("Detroit Lions", loadFixture("nfl-roster-det.json"));
const ind = extractRosterPlayers("Indianapolis Colts", loadFixture("nfl-roster-ind.json"));
const roster: RosterPlayer[] = [...kc, ...den, ...det, ...ind];

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
    { playerName: "Marcus Johnson", firstName: "Marcus", lastName: "Johnson", team: "Kansas City Chiefs", position: "WR", espnPlayerId: "9000001" },
    { playerName: "Marcus Johnson", firstName: "Marcus", lastName: "Johnson", team: "Denver Broncos", position: "WR", espnPlayerId: "9000002" },
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

console.log("\n########## PART D: bare-surname tier ('Gibbs over 65.5 rushing yards') ##########");
{
  const r1 = resolvePlayerPropAgainstRoster("Gibbs over 65.5 rushing yards", roster);
  check("D1: a bare surname with no first name and no team resolves via the roster's real, current NFL/Detroit Lions Jahmyr Gibbs", r1, {
    status: "resolved",
    sport: "NFL",
    team: "Detroit Lions",
    playerName: "Jahmyr Gibbs",
    via: "surname",
  });

  const r2 = resolvePlayerPropAgainstRoster("Jonathan Taylor over 65.5 rushing yards", roster);
  check("D2: existing full-name resolution is unaffected by the new surname tier - still resolves via 'exact'", r2, {
    status: "resolved",
    sport: "NFL",
    team: "Indianapolis Colts",
    playerName: "Jonathan Taylor",
    via: "exact",
  });

  // Constructed (not a real second NFL Gibbs) - proves the surname tier
  // never loosens into "one token is always enough": a second, distinct
  // player sharing the same surname anywhere on the roster keeps the line
  // 'ambiguous', exactly the same never-guess policy PART C already proved
  // for the full-name tiers.
  const twoGibbsRoster: RosterPlayer[] = [
    ...roster,
    { playerName: "Marcus Gibbs", firstName: "Marcus", lastName: "Gibbs", team: "Denver Broncos", position: "WR", espnPlayerId: "9000003" },
  ];
  const r3 = resolvePlayerPropAgainstRoster("Gibbs over 65.5 rushing yards", twoGibbsRoster);
  check("D3: two distinct players sharing a surname stays 'ambiguous', not guessed", r3, {
    status: "ambiguous",
    matches: [
      { playerName: "Jahmyr Gibbs", team: "Detroit Lions" },
      { playerName: "Marcus Gibbs", team: "Denver Broncos" },
    ],
  });

  // Same collision as D3, but now with slate context available (the Lions
  // are on the live board this week and the Broncos aren't) - the tie
  // breaks via relevantTeams instead of staying ambiguous, per the
  // "restrict to relevant/current slate teams when possible" behavior.
  const r4 = resolvePlayerPropAgainstRoster("Gibbs over 65.5 rushing yards", twoGibbsRoster, ["Detroit Lions"]);
  check("D3b: the same collision resolves when slate context narrows it to exactly one team", r4, {
    status: "resolved",
    sport: "NFL",
    team: "Detroit Lions",
    playerName: "Jahmyr Gibbs",
    via: "surname",
  });

  // A single typed word still isn't "always enough" on its own - a
  // multi-word typed name that fails both full-name tiers is a real miss
  // (wrong spelling / not on this roster), never re-tried as a surname.
  const r5 = resolvePlayerPropAgainstRoster("Jahmyr Nobody Over 65.5 Rushing Yards", roster);
  check("D4: a two-word typed name that matches no one stays 'unresolved' - never falls back to matching just the first word as a surname", r5, {
    status: "unresolved",
  });

  // Cached-data-only: resolvePlayerPropAgainstRoster takes a plain
  // RosterPlayer[] and makes no network call of its own - confirmed by
  // making any global fetch call throw for the duration of this check, then
  // re-running the exact D1 resolution above to prove it still succeeds
  // with zero network access.
  const realFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = () => {
    throw new Error("resolvePlayerPropAgainstRoster must never make a network request");
  };
  try {
    const r6 = resolvePlayerPropAgainstRoster("Gibbs over 65.5 rushing yards", roster);
    check("D5: resolution succeeds identically with fetch disabled - matching never touches the network", r6, r1);
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = realFetch;
  }
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
