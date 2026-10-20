// Proof for near-miss player names at catalog import - run with:
//   npx tsx src/lib/player-near-miss-acceptance-test.ts
//
// The bug (2026-10): the roster's fuzzy tier resolved any single player within
// the typo tolerance, silently. "Brad Thomas anytime TD" became Brian Thomas
// Jr. (Jaguars) with nothing to say that was the player meant. The rule now:
//   - an exact (case/punctuation/suffix-insensitive) name resolves as before;
//   - a near-miss (typo tolerance, plus MLB first-name short forms) resolves
//     silently only when the player's team is in the pick's game: the NBA line's
//     "@ Opponent" game, otherwise a game on a complete slate starting within
//     ~36 hours;
//   - any other near-miss goes to the "which player?" prompt with the
//     suggestion as its option; two players both within tolerance are settled
//     by the same game check, or both offered;
//   - confirming (or silently placing) a near-miss puts the roster's name in
//     the pick's text; `raw` keeps the capper's line.
//
// Pure - no network, no database, no auth: parseCatalog -> recoverUnresolvedLines
// -> resolveAmbiguousPick, with fixture rosters and a pinned clock.
import fs from "node:fs";
import path from "node:path";
import { extractMlbRosterPlayers, MLB_TEAM_IDS } from "@/server/data/mlb-roster";
import { parseCatalog, resolveAmbiguousPick, isPlayerAmbiguityKey, type ParsedPick } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { resolveNameAgainstRoster, withRosterName } from "@/lib/player-roster-fallback";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { LiveTeam } from "@/lib/live-team-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}

const JAX = "Jacksonville Jaguars";
const BUF = "Buffalo Bills";
const KC = "Kansas City Chiefs";
const ATL = "Atlanta Falcons";
const SF = "San Francisco 49ers";
const SEA = "Seattle Seahawks";
const NFL_ROSTER: RosterPlayer[] = [
  rp("4685720", "Brian Thomas Jr.", JAX, "WR"),
  rp("3918298", "Josh Allen", BUF, "QB"),
  rp("15847", "Travis Kelce", KC, "TE"),
  rp("4430807", "Bijan Robinson", ATL, "RB"),
  rp("4241474", "Brian Robinson Jr.", SF, "RB"),
  rp("4567048", "Kenneth Walker III", SEA, "RB"),
];

// The clock every import below runs at, and games relative to it.
const NOW = Date.parse("2026-10-25T12:00:00Z");
const hours = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const game = (sport: string, home: string, away: string, start: string): LiveTeam[] => [
  { sport, name: home, opponent: away, commenceTime: start },
  { sport, name: away, opponent: home, commenceTime: start },
];
// Bills, Chiefs and Falcons play today; the Jaguars and 49ers later in the week (on the slate, not in the window).
const WEEK: LiveTeam[] = [
  ...game("NFL", BUF, "Miami Dolphins", hours(5)),
  ...game("NFL", KC, "Las Vegas Raiders", hours(8)),
  ...game("NFL", ATL, "Carolina Panthers", hours(5)),
  ...game("NFL", JAX, "Tennessee Titans", hours(4 * 24)),
  ...game("NFL", SF, "Los Angeles Rams", hours(4 * 24)),
  ...game("NFL", SEA, "Arizona Cardinals", hours(4 * 24)),
];
// Both Robinsons' teams play today.
const BOTH_ROBINSONS = [...WEEK.filter((t) => t.name !== SF && t.opponent !== SF), ...game("NFL", SF, "Los Angeles Rams", hours(6))];

type Outcome = { pick: ParsedPick | undefined; stillUnresolved: string[] };
function importNfl(line: string, live: LiveTeam[], completeSports = ["NFL"]): Outcome {
  const parsed = parseCatalog("Godfather\n" + line, ["Godfather"], NFL_ROSTER.map((p) => p.playerName));
  const out = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, live, NFL_ROSTER, parsed.picks, [], [], completeSports, [], {}, NOW);
  return { pick: [...parsed.picks, ...out.recovered][0], stillUnresolved: out.stillUnresolved };
}
const placed = (o: Outcome) => (o.pick && !o.pick.ambiguous ? { team: o.pick.teamNicknames, description: o.pick.description, raw: o.pick.raw } : null);
const asked = (o: Outcome) =>
  o.pick?.ambiguous && isPlayerAmbiguityKey(o.pick.ambiguousKey ?? "") ? o.pick.ambiguous.map((a) => a.label) : null;

// ---------------------------------------------------------------- 1. Brad Thomas -> review
{
  const o = importNfl("Brad Thomas anytime TD", WEEK);
  check("'Brad Thomas anytime TD', no JAX game in the window -> not placed", placed(o), null);
  check("...it asks, with Brian Thomas Jr. as the one suggestion", asked(o), ["Brian Thomas Jr. — Jaguars WR"]);
  check("...the option carries the roster name and the typed name", o.pick?.ambiguous?.map((a) => [a.playerName, a.typedName]), [["Brian Thomas Jr.", "Brad Thomas"]]);
  const confirmed = resolveAmbiguousPick(o.pick!, o.pick!.ambiguous![0]);
  check(
    "confirming it stores the roster name for grading; raw keeps the capper's text",
    [confirmed.description, confirmed.teamNicknames, confirmed.sportName, confirmed.raw],
    ["Brian Thomas Jr. anytime TD", ["jacksonville jaguars"], "NFL", "Brad Thomas anytime TD"]
  );
  // The same slate known to be incomplete: still asks (nothing places a near-miss on a partial slate).
  check("an incomplete slate -> still asks", asked(importNfl("Brad Thomas anytime TD", WEEK, [])), ["Brian Thomas Jr. — Jaguars WR"]);
  // JAX playing today: the near-miss is in the game, so it places silently.
  const today = [...WEEK.filter((t) => t.name !== JAX && t.opponent !== JAX), ...game("NFL", JAX, "Tennessee Titans", hours(3))];
  check("JAX in the window -> placed on the Jaguars with the roster name", placed(importNfl("Brad Thomas anytime TD", today)), {
    team: ["jacksonville jaguars"],
    description: "Brian Thomas Jr. anytime TD",
    raw: "Brad Thomas anytime TD",
  });
}

// ---------------------------------------------------------------- 2. typos on a game in the window -> placed
check("'Josh Allan' on a BUF game -> Josh Allen", placed(importNfl("Josh Allan over 245.5 passing yards", WEEK)), {
  team: ["buffalo bills"],
  description: "Josh Allen over 245.5 passing yards",
  raw: "Josh Allan over 245.5 passing yards",
});
check("'Travis Kelsey' on a KC game -> Travis Kelce", placed(importNfl("Travis Kelsey over 55.5 receiving yards", WEEK)), {
  team: ["kansas city chiefs"],
  description: "Travis Kelce over 55.5 receiving yards",
  raw: "Travis Kelsey over 55.5 receiving yards",
});
// The passing-TD path: same rule over the quarterbacks.
check("passing TDs: 'Josh Allan' on a BUF game -> Josh Allen", placed(importNfl("Josh Allan over 1.5 passing TDs", WEEK)), {
  team: ["buffalo bills"],
  description: "Josh Allen over 1.5 passing TDs",
  raw: "Josh Allan over 1.5 passing TDs",
});
{
  const later = [...WEEK.filter((t) => t.name !== BUF && t.opponent !== BUF), ...game("NFL", BUF, "Miami Dolphins", hours(3 * 24))];
  check("passing TDs: BUF on the slate but not in the window -> asks", asked(importNfl("Josh Allan over 1.5 passing TDs", later)), ["Josh Allen — Bills QB"]);
  const bye = WEEK.filter((t) => t.name !== BUF && t.opponent !== BUF);
  const o = importNfl("Josh Allan over 1.5 passing TDs", bye);
  check("passing TDs: BUF not on a complete slate -> the existing no-game failure", [o.pick, o.stillUnresolved], [undefined, ["Josh Allan over 1.5 passing TDs"]]);
}

// ---------------------------------------------------------------- 3. two players within tolerance (Bijan / Brian Robinson)
// "Bian Robinson" is one edit from both "Bijan Robinson" and "Brian Robinson" (Jr. dropped).
check("Robinson pair, only ATL in the window -> Bijan Robinson", placed(importNfl("Bian Robinson over 70.5 rushing yards", WEEK)), {
  team: ["atlanta falcons"],
  description: "Bijan Robinson over 70.5 rushing yards",
  raw: "Bian Robinson over 70.5 rushing yards",
});
check("Robinson pair, both in the window -> asks with both", asked(importNfl("Bian Robinson over 70.5 rushing yards", BOTH_ROBINSONS)), [
  "Bijan Robinson — Falcons RB",
  "Brian Robinson Jr. — 49ers RB",
]);
check("Robinson pair, no slate -> asks with both", asked(importNfl("Bian Robinson over 70.5 rushing yards", [], [])), [
  "Bijan Robinson — Falcons RB",
  "Brian Robinson Jr. — 49ers RB",
]);

// ---------------------------------------------------------------- 4. exact matches (suffixes) are unchanged
check("'Brian Thomas' is Brian Thomas Jr. exactly - placed with no game in the window, text untouched", placed(importNfl("Brian Thomas anytime TD", WEEK)), {
  team: ["jacksonville jaguars"],
  description: "Brian Thomas anytime TD",
  raw: "Brian Thomas anytime TD",
});
check("'Brian Thomas Jr.' exact, no slate at all", placed(importNfl("Brian Thomas Jr. anytime TD", [], []))?.team, ["jacksonville jaguars"]);
check("'Kenneth Walker' is Kenneth Walker III exactly", placed(importNfl("Kenneth Walker over 60.5 rushing yards", [], []))?.team, ["seattle seahawks"]);
check("'Brian Robinson' is Brian Robinson Jr. exactly (not a pair with Bijan)", placed(importNfl("Brian Robinson over 50.5 rushing yards", [], []))?.team, ["san francisco 49ers"]);

// ---------------------------------------------------------------- 5. MLB short form (Alexander Cook -> the roster's Alex Cook)
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "server", "data", "__fixtures__", "mlb-roster-sample.json"), "utf8")) as Record<string, unknown>;
  const MLB: RosterPlayer[] = Object.entries(raw).flatMap(([id, resp]) => extractMlbRosterPlayers(MLB_TEAM_IDS.find(([t]) => t === id)![1], resp));
  const RAYS = "Tampa Bay Rays";
  const importMlb = (line: string, live: LiveTeam[]): Outcome => {
    const parsed = parseCatalog("Godfather\n" + line, ["Godfather"], []);
    const out = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, live, [], parsed.picks, [], MLB, ["MLB"], [], {}, NOW);
    return { pick: [...parsed.picks, ...out.recovered][0], stillUnresolved: out.stillUnresolved };
  };
  check("MLB short form, Rays in the game -> Alex Cook, roster name stored", placed(importMlb("Alexander Cook over 4.5 Ks", game("MLB", RAYS, "Boston Red Sox", hours(2)))), {
    team: ["tampa bay rays"],
    description: "Alex Cook over 4.5 Ks",
    raw: "Alexander Cook over 4.5 Ks",
  });
  const o = importMlb("Alexander Cook over 4.5 Ks", game("MLB", "New York Yankees", "Boston Red Sox", hours(2)));
  check("MLB short form, Rays not in a game -> asks with Alex Cook", asked(o), ["Alex Cook — Rays P"]);
  check("...confirming stores Alex Cook", o.pick ? resolveAmbiguousPick(o.pick, o.pick.ambiguous![0]).description : null, "Alex Cook over 4.5 Ks");
}

// ---------------------------------------------------------------- 6. NBA: the "@ Opponent" game, and exact beats near-miss across leagues
{
  const NYK = "New York Knicks";
  const NBA: RosterPlayer[] = [rp("3934672", "Jalen Brunson", NYK, "PG"), rp("3062679", "Josh Hart", NYK, "SG")];
  // A fictional hockey player one letter from Josh Hart, to test the cross-league rule.
  const NHL: RosterPlayer[] = [rp("9100001", "Josh Harte", "New Jersey Devils", "C")];
  // Knicks @ Celtics in three days: outside the 36-hour window, but it is the game the line names.
  const live = game("NBA", "Boston Celtics", NYK, hours(3 * 24));
  const importNba = (line: string, nhl: RosterPlayer[] = []): Outcome => {
    const parsed = parseCatalog("Godfather\n" + line, ["Godfather"], []);
    const out = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, live, [], parsed.picks, nhl, [], ["NBA"], NBA, {}, NOW);
    return { pick: [...parsed.picks, ...out.recovered][0], stillUnresolved: out.stillUnresolved };
  };
  check("NBA '@ Celtics': the Knicks play the Celtics -> Jalen Brunson", placed(importNba("Jalen Brunsen over 24.5 points @ Celtics"))?.team, ["new york knicks"]);
  check("NBA '@ Lakers': the Knicks don't play the Lakers -> asks", asked(importNba("Jalen Brunsen over 24.5 points @ Lakers")), ["Jalen Brunson — Knicks PG"]);
  check("NBA no opponent, Knicks not in the window -> asks", asked(importNba("Jalen Brunsen over 24.5 points")), ["Jalen Brunson — Knicks PG"]);
  check("exact NBA name beats a near-miss NHL one (assists both leagues have)", placed(importNba("Josh Hart over 4.5 assists", NHL))?.team, ["new york knicks"]);
}

// ---------------------------------------------------------------- 7. the pieces
check(
  "resolveNameAgainstRoster: a lone near-miss with no game known is a near-miss question",
  resolveNameAgainstRoster("Brad Thomas", NFL_ROSTER, undefined, "NFL"),
  { status: "ambiguous", tier: "near-miss", matches: [{ playerName: "Brian Thomas Jr.", team: JAX, position: "WR", externalPlayerId: "4685720" }] }
);
check("withRosterName replaces the typed name once, case-insensitively", withRosterName("josh allan o1.5 Pass TDs", "Josh Allan", "Josh Allen"), "Josh Allen o1.5 Pass TDs");
check("withRosterName leaves text without the name alone", withRosterName("Over 1.5 passing TDs", "Josh Allan", "Josh Allen"), "Over 1.5 passing TDs");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
