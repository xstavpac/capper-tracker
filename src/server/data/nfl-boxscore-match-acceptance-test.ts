// Grading-time NFL box-score player matching (grading.ts locateNflPlayer +
// nfl-boxscore-match.ts). Root cause being locked in: picks stored with a
// bare surname ("Judkins") or without ESPN's generational suffix ("Kenneth
// Walker" vs "Kenneth Walker III") never matched ESPN's displayName, and a
// player present in one stat group but not another ("Kyle Monangai" rushed
// but caught nothing) was reported "not found" instead of a real 0.
//
// Uses trimmed, saved copies of real ESPN summary responses for 2026 Week 3
// (captured 2026-09-30) under __fixtures__/ - no live network, no prisma
// (the roster is injected). Ground truth from those responses:
//   401872952 KC @ MIA   Kenneth Walker III (KC): rush 18/70/1 TD, rec 2/3 yds/1 TD
//   401872949 CAR @ CLE  Quinshon Judkins (CLE): rush 18/70, rec 2/9
//   401872956 TEN @ NYG  Darnell Mooney (NYG): rush 1/9, rec 2/20
//   401872963 PHI @ CHI  Kyle Monangai (CHI): rush 10/31, NO receiving row
//                        Luther Burden III (CHI): rush 1/7, rec 7/61/1 TD
//   401872954 NYJ @ DET  Adonai Mitchell (NYJ): inactive, no row in any group
//
// Run with: npx tsx src/server/data/nfl-boxscore-match-acceptance-test.ts
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

const FIXTURE_DIR = path.join(__dirname, "__fixtures__");
function load(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
}

const KC_MIA = { id: "401872952", file: "nfl-boxscore-401872952-kc-mia.json", home: "Miami Dolphins", away: "Kansas City Chiefs" };
const CAR_CLE = { id: "401872949", file: "nfl-boxscore-401872949-car-cle.json", home: "Cleveland Browns", away: "Carolina Panthers" };
const TEN_NYG = { id: "401872956", file: "nfl-boxscore-401872956-ten-nyg.json", home: "New York Giants", away: "Tennessee Titans" };
const PHI_CHI = { id: "401872963", file: "nfl-boxscore-401872963-phi-chi.json", home: "Chicago Bears", away: "Philadelphia Eagles" };
const NYJ_DET = { id: "401872954", file: "nfl-boxscore-401872954-nyj-det.json", home: "Detroit Lions", away: "New York Jets" };

function rp(espnPlayerId: string, playerName: string, team: string, position = "WR"): RosterPlayer {
  const parts = playerName.split(" ");
  return { espnPlayerId, playerName, firstName: parts[0], lastName: parts.slice(1).join(" "), team, position };
}
// lastName deliberately mirrors ESPN's real quirk ("Walker III").
const ROSTER: RosterPlayer[] = [
  rp("4597500", "Adonai Mitchell", "New York Jets"),
  rp("4567048", "Kenneth Walker III", "Kansas City Chiefs", "RB"),
  rp("4685702", "Quinshon Judkins", "Cleveland Browns", "RB"),
];

async function run(
  game: typeof KC_MIA,
  betDetail: string,
  overrides: { data?: any; roster?: RosterPlayer[]; propMarket?: any; playerName?: string | null } = {}
) {
  const data = overrides.data ?? load(game.file);
  const deps: NflPropDeps = {
    fetchSummary: async () => data,
    getRoster: async () => overrides.roster ?? ROSTER,
  };
  return resolvePlayerProp(
    {
      betDetail,
      propMarket: overrides.propMarket ?? null,
      playerName: overrides.playerName ?? null,
      homeTeam: game.home,
      awayTeam: game.away,
    },
    game.id,
    "NFL",
    deps
  );
}

async function main() {
  // ---- suffix mismatch: capper omits ESPN's "III" ----
  check("Kenneth Walker -> Kenneth Walker III: Over 59.5 rush yds (70) WINs", await run(KC_MIA, "Kenneth Walker Over 59.5 Rushing Yards"), { outcome: "WIN" });
  check("Kenneth Walker III (with suffix) still matches", await run(KC_MIA, "Kenneth Walker III Over 59.5 Rushing Yards"), { outcome: "WIN" });
  check("Kenneth Walker anytime TD (rushing TD) WINs", await run(KC_MIA, "Kenneth Walker Anytime Touchdown"), { outcome: "WIN" });
  check("Luther Burden -> Luther Burden III: Over 5.5 receptions (7) WINs", await run(PHI_CHI, "Luther Burden Over 5.5 Receptions"), { outcome: "WIN" });
  check("Luther Burden Over 70.5 receiving yds (61) LOSSes", await run(PHI_CHI, "Luther Burden Over 70.5 Receiving Yards"), { outcome: "LOSS" });

  // ---- bare surname, scoped to the game's two teams ----
  check("bare 'Judkins' Over 60.5 rush yds (70) WINs", await run(CAR_CLE, "Judkins Over 60.5 Rushing Yards"), { outcome: "WIN" });
  check("bare 'Mooney' Over 15.5 rec yds (20) WINs", await run(TEN_NYG, "Mooney Over 15.5 Receiving Yards"), { outcome: "WIN" });
  check("bare 'Monangai' Over 25.5 rush yds (31) WINs", await run(PHI_CHI, "Monangai Over 25.5 Rushing Yards"), { outcome: "WIN" });
  check(
    "structured pick (playerName/propMarket set) with bare surname resolves the same way",
    await run(CAR_CLE, "Judkins Over 60.5 Rushing Yards", { propMarket: "RUSH_YDS", playerName: "Judkins" }),
    { outcome: "WIN" }
  );

  // ---- missing row = real zero ----
  check("Monangai (no receiving row) Over 0.5 receptions LOSSes at 0", await run(PHI_CHI, "Kyle Monangai Over 0.5 Receptions"), { outcome: "LOSS" });
  check("Monangai Under 5.5 receiving yds WINs at 0", await run(PHI_CHI, "Kyle Monangai Under 5.5 Receiving Yards"), { outcome: "WIN" });
  check("Monangai anytime TD (no TD, no receiving row) LOSSes", await run(PHI_CHI, "Kyle Monangai Anytime Touchdown"), { outcome: "LOSS" });
  check("Walker Over 0.5 passing yds (no passing row) LOSSes at 0", await run(KC_MIA, "Kenneth Walker Over 0.5 Passing Yards"), { outcome: "LOSS" });
  // The two already-working combined paths, unchanged: 70 + 3 = 73.
  check("RUSH_REC_YDS still sums both halves (73)", await run(KC_MIA, "Kenneth Walker Over 72.5 Rushing and Receiving Yards"), { outcome: "WIN" });

  // ---- same-surname collision: never guess ----
  {
    const data = load(KC_MIA.file);
    const chiefs = data.boxscore.players.find((t: any) => t.team.displayName === "Kansas City Chiefs");
    chiefs.statistics
      .find((c: any) => c.name === "receiving")
      .athletes.push({ athlete: { id: "9999991", displayName: "Devontez Walker" }, stats: ["4", "40", "10.0", "0", "20", "5"] });
    const collision = await run(KC_MIA, "Walker Over 59.5 Rushing Yards", { data });
    check("bare 'Walker' with two Walkers on the same two teams stays PENDING", collision.outcome, null);
    check(
      "...with a 'more than one player' reason",
      (collision as { reason?: string }).reason?.includes("more than one player") ?? false,
      true
    );
    check("full name 'Kenneth Walker' still resolves despite the collision", await run(KC_MIA, "Kenneth Walker Over 59.5 Rushing Yards", { data }), { outcome: "WIN" });
  }

  // ---- wrong game: player isn't on either team ----
  {
    const r = await run(CAR_CLE, "Kenneth Walker Over 59.5 Rushing Yards");
    check("Walker pick against CAR@CLE (he's on KC) stays PENDING", r.outcome, null);
  }

  // ---- did-not-play PUSH: Adonai Mitchell (inactive) ----
  check("Adonai Mitchell (inactive, roster-verified) PUSHes", await run(NYJ_DET, "ADONAI Mitchell Over 40.5 Receiving Yards"), { outcome: "PUSH" });
  check("Adonai Mitchell anytime TD (inactive) PUSHes", await run(NYJ_DET, "Adonai Mitchell Anytime Touchdown"), { outcome: "PUSH" });
  {
    const r = await run(NYJ_DET, "ADONAI Mitchell Over 40.5 Receiving Yards", { roster: [] });
    check("not on the roster cache -> PENDING, no PUSH", r.outcome, null);
  }
  {
    const r = await run(NYJ_DET, "Mitchell Over 40.5 Receiving Yards", {
      roster: [...ROSTER, rp("4400001", "Keaton Mitchell", "Baltimore Ravens", "RB")],
    });
    check("bare 'Mitchell' matching two roster players -> PENDING, no PUSH", r.outcome, null);
  }
  {
    const r = await run(NYJ_DET, "Adonai Mitchel Over 40.5 Receiving Yards");
    check("typo'd name (fuzzy only) never PUSHes", r.outcome, null);
  }
  {
    const data = load(NYJ_DET.file);
    data.header.competitions[0].status.type = { name: "STATUS_IN_PROGRESS", completed: false, state: "in" };
    const r = await run(NYJ_DET, "Adonai Mitchell Over 40.5 Receiving Yards", { data });
    check("game not final -> PENDING, no PUSH", r.outcome, null);
  }
  {
    const data = load(NYJ_DET.file);
    delete data.header;
    const r = await run(NYJ_DET, "Adonai Mitchell Over 40.5 Receiving Yards", { data });
    check("final status not explicitly confirmed -> PENDING, no PUSH", r.outcome, null);
  }
  {
    const data = load(NYJ_DET.file);
    const jets = data.boxscore.players.find((t: any) => t.team.displayName === "New York Jets");
    jets.statistics = jets.statistics.filter((c: any) => c.name !== "receiving");
    const r = await run(NYJ_DET, "Adonai Mitchell Over 40.5 Receiving Yards", { data });
    check("incomplete box score (no Jets receiving group) -> PENDING, no PUSH", r.outcome, null);
  }
  {
    const r = await run(NYJ_DET, "Adonai Mitchell Over 40.5 Receiving Yards", {
      roster: [rp("4597500", "Adonai Mitchell", "Denver Broncos")],
    });
    check("roster says he's on a team not in this game -> PENDING, no PUSH", r.outcome, null);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
