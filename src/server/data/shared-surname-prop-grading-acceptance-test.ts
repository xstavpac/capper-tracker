// Grading side of the shared-surname fix (see lib/shared-surname-prop-resolution-acceptance-test.ts
// for the import side): a pick that reaches grading with a bare surname 2+ rostered players share
// is never graded as one of them unless THIS game's own box score has exactly one such player.
// Otherwise it stays PENDING with a reason that names the candidates.
//
// Saved real ESPN box scores, no network, roster injected:
//   401872949 CAR @ CLE   no McCaffrey and no Walker in the box score
//   401872952 KC @ MIA    Kenneth Walker III (KC) 18 carries, 70 rushing yards
//
// Run with: npx tsx src/server/data/shared-surname-prop-grading-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { resolvePlayerProp, type NflPropDeps } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const load = (file: string): any => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", file), "utf8"));

const CAR_CLE = { id: "401872949", file: "nfl-boxscore-401872949-car-cle.json", home: "Cleveland Browns", away: "Carolina Panthers" };
const KC_MIA = { id: "401872952", file: "nfl-boxscore-401872952-kc-mia.json", home: "Miami Dolphins", away: "Kansas City Chiefs" };

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}
const ROSTER: RosterPlayer[] = [
  rp("3117251", "Christian McCaffrey", "San Francisco 49ers", "RB"),
  rp("4426948", "Luke McCaffrey", "Washington Commanders", "WR"),
  rp("4567048", "Kenneth Walker III", "Kansas City Chiefs", "RB"),
  rp("4696882", "Devontez Walker", "Baltimore Ravens", "WR"),
  rp("5160110", "Jahdae Walker", "Chicago Bears", "WR"),
];

function run(game: typeof CAR_CLE, betDetail: string, playerName: string, propMarket: "REC_YDS" | "RUSH_YDS", roster = ROSTER) {
  const deps: NflPropDeps = { fetchSummary: async () => load(game.file), getRoster: async () => roster };
  return resolvePlayerProp({ betDetail, propMarket, playerName, homeTeam: game.home, awayTeam: game.away }, game.id, "NFL", deps);
}

async function main() {
  // The shape of the reported pick: a bare "McCaffrey" attached to a game neither McCaffrey has a line in.
  const stuck = await run(CAR_CLE, "McCaffrey over 38.5 receiving yards", "McCaffrey", "REC_YDS");
  check("shared surname, nobody by that name in this box score -> stays PENDING, reason names both players", stuck, {
    outcome: null,
    reason:
      '"McCaffrey" matches more than one rostered player (Christian McCaffrey, San Francisco 49ers RB; Luke McCaffrey, Washington Commanders WR) and this game\'s box score doesn\'t settle which - grade it manually',
  });

  // Even when exactly one of the candidates is on a team in this game, absence is not graded as a
  // did-not-play PUSH: the roster cannot say which of them the pick was about.
  const oneOnTeam = await run(
    CAR_CLE,
    "McCaffrey over 38.5 receiving yards",
    "McCaffrey",
    "REC_YDS",
    [rp("3117251", "Christian McCaffrey", "Cleveland Browns", "RB"), rp("4426948", "Luke McCaffrey", "Washington Commanders", "WR")]
  );
  check("...also when one of them is on a team in this game (never a did-not-play PUSH)", oneOnTeam.outcome, null);

  // Three rostered Walkers, but the pick's own game has exactly one: the box score settles it.
  check(
    "shared surname, exactly one such player in this game's box score -> graded on his line",
    await run(KC_MIA, "Walker over 45.5 rushing yards", "Walker", "RUSH_YDS"),
    { outcome: "WIN" }
  );

  // A unique surname absent from the box score keeps its existing reason.
  const unique = await run(CAR_CLE, "Nobody over 38.5 receiving yards", "Nobody", "REC_YDS");
  check("a name on no roster keeps the plain not-found reason", unique, { outcome: null, reason: 'couldn\'t find "Nobody" in the box score' });

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
