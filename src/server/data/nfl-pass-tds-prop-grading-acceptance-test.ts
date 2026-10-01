// PASS_TDS grading (grading.ts resolvePlayerProp -> resolveYardageOrReceptionsProp). Saved real ESPN box
// scores (captured 2026-09-30), no network, roster injected. Ground truth (passing TD column):
//   401872949 CAR @ CLE   Deshaun Watson (CLE) 2, Shedeur Sanders (CLE) 0, Bryce Young (CAR) 1
//   401872954 NYJ @ DET   Geno Smith (NYJ) 3, Jared Goff (DET) 2
//   401872952 KC @ MIA    Patrick Mahomes (KC) 2, Malik Willis (MIA) 0
//   401872927 MIN @ GB    Christian Watson (GB) is a WR with a receiving row only
//
// Run with: npx tsx src/server/data/nfl-pass-tds-prop-grading-acceptance-test.ts
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
const NYJ_DET = { id: "401872954", file: "nfl-boxscore-401872954-nyj-det.json", home: "Detroit Lions", away: "New York Jets" };
const KC_MIA = { id: "401872952", file: "nfl-boxscore-401872952-kc-mia.json", home: "Miami Dolphins", away: "Kansas City Chiefs" };
const MIN_GB = { id: "401872927", file: "nfl-boxscore-401872927-min-gb.json", home: "Green Bay Packers", away: "Minnesota Vikings" };

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}
const ROSTER: RosterPlayer[] = [
  rp("3122840", "Deshaun Watson", "Cleveland Browns", "QB"),
  rp("9000001", "Christian Watson", "Green Bay Packers", "WR"),
  rp("9000002", "Tyrod Taylor", "New York Jets", "QB"), // on a team in NYJ @ DET, absent from its box score
  rp("9000003", "Jake Browning", "Cleveland Browns", "QB"), // not on either team in NYJ @ DET
];

async function run(
  game: typeof CAR_CLE,
  betDetail: string,
  opts: { data?: any; roster?: RosterPlayer[]; stored?: boolean; playerName?: string } = {}
) {
  const data = opts.data ?? load(game.file);
  const deps: NflPropDeps = { fetchSummary: async () => data, getRoster: async () => opts.roster ?? ROSTER };
  return resolvePlayerProp(
    {
      betDetail,
      propMarket: opts.stored === false ? null : "PASS_TDS",
      playerName: opts.stored === false ? null : (opts.playerName ?? null),
      homeTeam: game.home,
      awayTeam: game.away,
    },
    game.id,
    "NFL",
    deps
  );
}

async function main() {
  // ---- 0 TD (Shedeur Sanders) ----
  check("0 TD vs over 0.5 -> LOSS", await run(CAR_CLE, "Shedeur Sanders over 0.5 passing touchdowns"), { outcome: "LOSS" });
  check("0 TD vs under 0.5 -> WIN", await run(CAR_CLE, "Shedeur Sanders under 0.5 passing touchdowns"), { outcome: "WIN" });
  check("0 TD vs over 1.5 -> LOSS", await run(CAR_CLE, "Shedeur Sanders over 1.5 passing TDs"), { outcome: "LOSS" });

  // ---- 1 TD (Bryce Young) ----
  check("1 TD vs over 0.5 -> WIN", await run(CAR_CLE, "Bryce Young over 0.5 passing touchdowns"), { outcome: "WIN" });
  check("1 TD vs over 1.5 -> LOSS", await run(CAR_CLE, "Bryce Young over 1.5 passing touchdowns"), { outcome: "LOSS" });
  check("1 TD vs under 1.5 -> WIN", await run(CAR_CLE, "Bryce Young under 1.5 passing touchdowns"), { outcome: "WIN" });
  check("1 TD vs under 0.5 -> LOSS", await run(CAR_CLE, "Bryce Young under 0.5 pass TD"), { outcome: "LOSS" });
  check("1 TD vs over 1 (whole number) -> PUSH", await run(CAR_CLE, "Bryce Young over 1 passing TDs"), { outcome: "PUSH" });

  // ---- 2 TD (Deshaun Watson) ----
  check("2 TD vs over 1.5 -> WIN", await run(CAR_CLE, "Deshaun Watson over 1.5 passing touchdowns"), { outcome: "WIN" });
  check("2 TD vs over 2.5 -> LOSS", await run(CAR_CLE, "Deshaun Watson over 2.5 passing TDs"), { outcome: "LOSS" });
  check("2 TD vs under 2.5 -> WIN", await run(CAR_CLE, "Deshaun Watson under 2.5 passing TDs"), { outcome: "WIN" });
  check("2 TD vs under 1.5 -> LOSS", await run(CAR_CLE, "Deshaun Watson under 1.5 passing TDs"), { outcome: "LOSS" });
  check("2 TD vs over 2 (whole number) -> PUSH", await run(CAR_CLE, "Deshaun Watson over 2 passing TDs"), { outcome: "PUSH" });
  check("2 TD vs under 2 (whole number) -> PUSH", await run(CAR_CLE, "Deshaun Watson under 2 passing TDs"), { outcome: "PUSH" });
  check("N+ form (stored normalized): 2+ passing TDs -> over 1.5 -> WIN", await run(CAR_CLE, "Deshaun Watson Over 1.5 pass TDs"), { outcome: "WIN" });

  // ---- other box scores ----
  check("Geno Smith (3) over 2.5 -> WIN", await run(NYJ_DET, "Geno Smith over 2.5 passing TDs"), { outcome: "WIN" });
  check("Geno Smith (3) over 3 -> PUSH", await run(NYJ_DET, "Geno Smith over 3 passing TDs"), { outcome: "PUSH" });
  check("Mahomes (2) bare surname over 1.5 -> WIN", await run(KC_MIA, "Mahomes over 1.5 passing TDs"), { outcome: "WIN" });

  // ---- structured pick (propMarket stored) and legacy (null -> re-derived) agree ----
  check("stored propMarket, bare surname", await run(CAR_CLE, "Watson over 1.5 passing TDs", { playerName: "Watson" }), { outcome: "WIN" });
  check("legacy null propMarket re-derived from text", await run(CAR_CLE, "Watson over 1.5 passing TDs", { stored: false }), { outcome: "WIN" });

  // ---- QB-only: a WR with the same surname in the SAME game never collides ----
  {
    const data = load(CAR_CLE.file);
    const cle = data.boxscore.players.find((t: any) => t.team.displayName === "Cleveland Browns");
    const receiving = cle.statistics.find((c: any) => c.name === "receiving");
    receiving.athletes.push({ athlete: { id: "9000001", displayName: "Christian Watson" }, stats: receiving.athletes[0].stats.map(() => "0") });
    check("bare Watson with Christian Watson also in the box score -> Deshaun (2 TD): over 1.5 WIN", await run(CAR_CLE, "Watson over 1.5 passing TDs", { data }), { outcome: "WIN" });
    check("same game, under 1.5 -> LOSS", await run(CAR_CLE, "Watson under 1.5 passing TDs", { data }), { outcome: "LOSS" });
  }
  // A WR is never gradeable as a QB: no passing row and not a QB on the roster.
  {
    const r: any = await run(MIN_GB, "Christian Watson over 0.5 passing touchdowns");
    check("a WR named in a passing-TDs pick stays PENDING (not graded as a 0-TD LOSS)", r.outcome, null);
  }
  {
    const r: any = await run(MIN_GB, "Watson over 0.5 passing touchdowns");
    check("bare Watson in a game with only the WR Watson stays PENDING", r.outcome, null);
  }

  // ---- did-not-play follows the yardage rule: verified DNP QB -> PUSH; unverifiable -> PENDING ----
  check("QB on a team in the game, final + complete box, no row anywhere -> PUSH", await run(NYJ_DET, "Tyrod Taylor over 0.5 passing touchdowns"), { outcome: "PUSH" });
  check("yardage prop for the same DNP QB also PUSHes (parity)", await run(NYJ_DET, "Tyrod Taylor over 150.5 passing yards", { stored: false }), { outcome: "PUSH" });
  {
    const r: any = await run(NYJ_DET, "Jake Browning over 0.5 passing touchdowns");
    check("roster QB whose team is not in this game -> PENDING, never PUSH", r.outcome, null);
  }
  {
    const data = load(NYJ_DET.file);
    data.header.competitions[0].status.type.completed = false;
    const r: any = await run(NYJ_DET, "Geno Smith over 2.5 passing TDs", { data });
    check("game not final -> PENDING with the existing reason", [r.outcome, r.reason], [null, "the box score isn't final yet for this game"]);
  }
  // A QB with a box-score row but no PASSING row (only rushing) has a real 0 passing TDs.
  {
    const data = load(KC_MIA.file);
    const mia = data.boxscore.players.find((t: any) => t.team.displayName === "Miami Dolphins");
    const passing = mia.statistics.find((c: any) => c.name === "passing");
    const idx = passing.athletes.findIndex((a: any) => a.athlete.displayName === "Malik Willis");
    const willis = passing.athletes.splice(idx, 1)[0];
    const rushing = mia.statistics.find((c: any) => c.name === "rushing");
    if (!rushing.athletes.some((a: any) => a.athlete.id === willis.athlete.id)) {
      rushing.athletes.push({ athlete: willis.athlete, stats: rushing.athletes[0].stats.map(() => "0") });
    }
    const roster = [...ROSTER, rp(String(willis.athlete.id), "Malik Willis", "Miami Dolphins", "QB")];
    check("QB in the box score without a passing row -> real 0: over 0.5 LOSS", await run(KC_MIA, "Malik Willis over 0.5 passing touchdowns", { data, roster }), { outcome: "LOSS" });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
