// PASS_ATTEMPTS / PASS_COMPLETIONS / PASS_INTERCEPTIONS / RUSH_ATTEMPTS grading (grading.ts resolvePlayerProp
// -> resolveYardageOrReceptionsProp). Saved real ESPN box scores, no network, roster injected. Ground truth
// (passing C/ATT + INT columns, rushing CAR column):
//   401873022 KC @ SEA   Sam Darnold (SEA) 20/28, 1 INT;  Patrick Mahomes (KC) 19/33, 1 INT
//   401873019 DEN @ ARI  Bo Nix (DEN) 15/29, 0 INT, 7 car; J.K. Dobbins (DEN) 6 car
//   401873010 NE @ CHI   Drake Maye (NE) 24/31, 1 INT, 4 car; Caleb Williams (CHI) 22/33, 0 INT, 5 car;
//                        Kyle Williams (NE) is a WR (receiving row only); D'Marco Jackson (CHI) made the INT
//   401873021 LAR @ LV   Kyren Williams (LAR) 16 car / 99 rush yds + 22 rec yds = 121
//   401872658 PIT @ ATL  Aaron Rodgers (PIT) 24/40, 0 INT, 3 car (captured 2026-09-30)
//
// Run with: npx tsx src/server/data/nfl-attempts-interceptions-prop-grading-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { resolvePlayerProp, type NflPropDeps } from "@/server/data/grading";
import { parsePlayerProp, normalizeNPlusPlayerProp } from "@/lib/bet-line";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const load = (file: string): any => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", file), "utf8"));

const KC_SEA = { id: "401873022", file: "nfl-boxscore-401873022-kc-sea.json", home: "Seattle Seahawks", away: "Kansas City Chiefs" };
const DEN_ARI = { id: "401873019", file: "nfl-boxscore-401873019-den-ari.json", home: "Arizona Cardinals", away: "Denver Broncos" };
const NE_CHI = { id: "401873010", file: "nfl-boxscore-401873010-ne-chi.json", home: "Chicago Bears", away: "New England Patriots" };
const LAR_LV = { id: "401873021", file: "nfl-boxscore-401873021-lar-lv.json", home: "Las Vegas Raiders", away: "Los Angeles Rams" };
const PIT_ATL = { id: "401872658", file: "nfl-boxscore-401872658-pit-atl.json", home: "Atlanta Falcons", away: "Pittsburgh Steelers" };

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}
const ROSTER: RosterPlayer[] = [
  rp("3912547", "Sam Darnold", "Seattle Seahawks", "QB"),
  rp("4426338", "Bo Nix", "Denver Broncos", "QB"),
  rp("4241985", "J.K. Dobbins", "Denver Broncos", "RB"),
  rp("4431452", "Drake Maye", "New England Patriots", "QB"),
  rp("8439", "Aaron Rodgers", "Pittsburgh Steelers", "QB"),
  rp("9100001", "Jarrett Stidham", "Denver Broncos", "QB"), // on a team in DEN @ ARI, absent from its box score
  rp("9100002", "Tyler Badie", "Denver Broncos", "RB"), // same, a back
  rp("9100003", "Joshua Dobbs", "New England Patriots", "QB"), // not on either team in DEN @ ARI
];

type Game = typeof KC_SEA;
// Mirrors what the importer stores: propMarket + playerName from parsePlayerProp on the (N+-normalized) text.
// stored: false leaves both columns null (a legacy / manual row), so grading re-parses betDetail itself.
async function run(game: Game, betDetail: string, opts: { data?: any; roster?: RosterPlayer[]; stored?: boolean } = {}) {
  const data = opts.data ?? load(game.file);
  const deps: NflPropDeps = { fetchSummary: async () => data, getRoster: async () => opts.roster ?? ROSTER };
  const parsed = parsePlayerProp(normalizeNPlusPlayerProp(betDetail));
  return resolvePlayerProp(
    {
      betDetail: normalizeNPlusPlayerProp(betDetail),
      propMarket: opts.stored === false ? null : (parsed?.propMarket ?? null),
      playerName: opts.stored === false ? null : (parsed?.playerName ?? null),
      homeTeam: game.home,
      awayTeam: game.away,
    },
    game.id,
    "NFL",
    deps
  );
}

async function main() {
  // ---- the requested lines, against the real box score of the player's game ----
  check("Sam Darnold over 0.5 interceptions (1 INT) -> WIN", await run(KC_SEA, "Sam Darnold over 0.5 interceptions"), { outcome: "WIN" });
  check("Bo Nix over 0.5 interceptions (0 INT) -> LOSS", await run(DEN_ARI, "Bo Nix over 0.5 interceptions"), { outcome: "LOSS" });
  // ESPN spells him "J.K. Dobbins"; the capper typed "JK".
  check("JK Dobbins over 13.5 rushing attempts (6 car) -> LOSS", await run(DEN_ARI, "JK Dobbins over 13.5 rushing attempts"), { outcome: "LOSS" });
  check("Drake Maye Over 5.5 Rushing Attempts (4 car, a QB) -> LOSS", await run(NE_CHI, "Drake Maye Over 5.5 Rushing Attempts"), { outcome: "LOSS" });
  check("Rodgers Over 34.5 Pass Attempts (40 att, bare surname) -> WIN", await run(PIT_ATL, "Rodgers Over 34.5 Pass Attempts"), { outcome: "WIN" });
  check("Kyren Williams over 89.5 rush + receive yards (99+22) -> WIN", await run(LAR_LV, "Kyren Williams over 89.5 rush + receive yards"), { outcome: "WIN" });

  // ---- each market: win / loss / push (a whole-number line equal to the stat) ----
  check("PASS_COMPLETIONS over 19.5 (Darnold 20) -> WIN", await run(KC_SEA, "Sam Darnold over 19.5 completions"), { outcome: "WIN" });
  check("PASS_COMPLETIONS under 19.5 (Darnold 20) -> LOSS", await run(KC_SEA, "Sam Darnold under 19.5 pass completions"), { outcome: "LOSS" });
  check("PASS_COMPLETIONS over 20 (Darnold 20) -> PUSH", await run(KC_SEA, "Sam Darnold over 20 completions"), { outcome: "PUSH" });
  check("PASS_ATTEMPTS under 34.5 (Rodgers 40) -> LOSS", await run(PIT_ATL, "Aaron Rodgers under 34.5 pass attempts"), { outcome: "LOSS" });
  check("PASS_ATTEMPTS over 40 (Rodgers 40) -> PUSH", await run(PIT_ATL, "Aaron Rodgers over 40 passing attempts"), { outcome: "PUSH" });
  check("PASS_ATTEMPTS 'pass att' shorthand, under 30.5 (Nix 29) -> WIN", await run(DEN_ARI, "Bo Nix u30.5 pass att"), { outcome: "WIN" });
  check("PASS_INTERCEPTIONS under 0.5 (Nix 0) -> WIN", await run(DEN_ARI, "Bo Nix under 0.5 interceptions"), { outcome: "WIN" });
  check("PASS_INTERCEPTIONS over 1 (Maye 1) -> PUSH", await run(NE_CHI, "Drake Maye over 1 INT"), { outcome: "PUSH" });
  check("PASS_INTERCEPTIONS '1+ interceptions' (Darnold 1) -> WIN", await run(KC_SEA, "Sam Darnold 1+ interceptions"), { outcome: "WIN" });
  check("RUSH_ATTEMPTS under 13.5 (Dobbins 6) -> WIN", await run(DEN_ARI, "J.K. Dobbins under 13.5 rushing attempts"), { outcome: "WIN" });
  check("RUSH_ATTEMPTS over 6.5 (Nix 7, a QB) -> WIN", await run(DEN_ARI, "Bo Nix over 6.5 rush attempts"), { outcome: "WIN" });
  check("RUSH_ATTEMPTS over 4 (Maye 4) -> PUSH", await run(NE_CHI, "Drake Maye over 4 rushing attempts"), { outcome: "PUSH" });
  check("RUSH_ATTEMPTS: a QB's carries, not his pass attempts (Rodgers 3 car)", await run(PIT_ATL, "Aaron Rodgers over 2.5 rushing attempts"), { outcome: "WIN" });

  // ---- legacy / manual row: no stored propMarket, grading re-parses the text ----
  check("unstored row: interceptions text grades as PASS_INTERCEPTIONS", await run(KC_SEA, "Sam Darnold over 0.5 interceptions", { stored: false }), { outcome: "WIN" });
  check("unstored row: rushing attempts never reads as RUSH_YDS (Dobbins 23 yds, 6 car)", await run(DEN_ARI, "JK Dobbins over 13.5 rushing attempts", { stored: false }), { outcome: "LOSS" });

  // ---- QB-only pool: a shared surname resolves to the passer, not the WR ----
  // NE @ CHI has Caleb Williams (CHI QB) and Kyle Williams (NE WR).
  check("'Williams' interceptions -> Caleb Williams (0 INT), never the WR", await run(NE_CHI, "Williams over 0.5 interceptions"), { outcome: "LOSS" });
  check("'Williams' completions -> Caleb Williams (22)", await run(NE_CHI, "Williams over 21.5 completions"), { outcome: "WIN" });
  // Rushing attempts uses the offense pool (any back / QB / receiver), so the same bare surname stays PENDING.
  const ambiguous = await run(NE_CHI, "Williams over 3.5 rushing attempts");
  check("'Williams' rushing attempts is ambiguous -> stays pending", ambiguous.outcome, null);
  check("  ...with the 'more than one player' reason", "reason" in ambiguous && /matches more than one player/.test(ambiguous.reason), true);

  // ---- a defender's interception is never graded as a QB's thrown INT ----
  const defender = await run(NE_CHI, "D'Marco Jackson over 0.5 interceptions");
  check("defender interceptions -> not found among passers, stays pending", defender, { outcome: null, reason: 'couldn\'t find "D\'Marco Jackson" in the box score' });

  // ---- did not play: on the roster, on one of the teams, absent from a final, complete box score -> PUSH ----
  check("DNP QB (Stidham, DEN) pass attempts -> PUSH", await run(DEN_ARI, "Jarrett Stidham over 20.5 pass attempts"), { outcome: "PUSH" });
  check("DNP QB (Stidham, DEN) interceptions -> PUSH", await run(DEN_ARI, "Jarrett Stidham over 0.5 interceptions"), { outcome: "PUSH" });
  check("DNP RB (Badie, DEN) rushing attempts -> PUSH", await run(DEN_ARI, "Tyler Badie over 8.5 rushing attempts"), { outcome: "PUSH" });

  // ---- not found: a name the box score and roster don't know, or a player on neither team ----
  check(
    "unknown name -> couldn't find",
    await run(DEN_ARI, "Zzyzx Quarterback over 0.5 interceptions"),
    { outcome: null, reason: 'couldn\'t find "Zzyzx Quarterback" in the box score' }
  );
  check(
    "rostered QB on neither team (Dobbs, NE in DEN @ ARI) -> couldn't find, never PUSH",
    await run(DEN_ARI, "Joshua Dobbs over 30.5 pass attempts"),
    { outcome: null, reason: 'couldn\'t find "Joshua Dobbs" in the box score' }
  );
  // A WR typed against a passing market: rostered, in the box score, but not a passer.
  check(
    "a WR (Kyle Williams) against a passing market -> couldn't find, never a 0",
    await run(NE_CHI, "Kyle Williams over 0.5 interceptions", { roster: [...ROSTER, rp("4999999", "Kyle Williams", "New England Patriots", "WR")] }),
    { outcome: null, reason: 'couldn\'t find "Kyle Williams" in the box score' }
  );

  // ---- box score not final ----
  const live = load(KC_SEA.file);
  const notFinal = { ...live, header: { competitions: [{ status: { type: { name: "STATUS_IN_PROGRESS", completed: false, state: "in" } } }] } };
  check("not final -> pending", await run(KC_SEA, "Sam Darnold over 0.5 interceptions", { data: notFinal }), { outcome: null, reason: "the box score isn't final yet for this game" });

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
