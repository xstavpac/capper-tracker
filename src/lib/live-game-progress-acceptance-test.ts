// Proof for getLiveGameProgress across MLB (inning/half) and the ESPN-backed
// quarter/period sports (period/clock). Pure: run with
//   npx tsx src/lib/live-game-progress-acceptance-test.ts
import { getLiveGameProgress } from "@/lib/live-game-progress";
import type { ScoreGame } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function approx(label: string, actual: number, expected: number, tol = 0.01) {
  const pass = Math.abs(actual - expected) <= tol;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${actual} expected~=${expected}`);
  if (!pass) failures++;
}

const base: ScoreGame = {
  id: "g1",
  homeTeam: "Home",
  awayTeam: "Away",
  status: "live",
  scores: [
    { name: "Home", score: "1" },
    { name: "Away", score: "2" },
  ],
  commenceTime: "2026-09-17T00:00:00Z",
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
};

function main() {
  // ==== Non-live / missing data -> null ====
  check("preview game -> null", getLiveGameProgress("baseball_mlb", { ...base, status: "preview" }), null);
  check("final game -> null", getLiveGameProgress("baseball_mlb", { ...base, status: "final" }), null);
  check("undefined score -> null", getLiveGameProgress("baseball_mlb", undefined), null);
  check(
    "unsupported sport (CFL, no period/clock) -> null",
    getLiveGameProgress("canadianfootball_cfl", { ...base, period: 2, clock: "5:00" }),
    null
  );

  // ==== MLB: reuses completedInnings (Top/Middle/Bottom/End over 9) ====
  {
    const r = getLiveGameProgress("baseball_mlb", { ...base, inningHalf: "Top", inningOrdinal: "1st" });
    check("MLB Top 1st label", r?.label, "Top 1st");
    approx("MLB Top 1st pct (0 completed / 9)", r!.pct, 0);
  }
  {
    const r = getLiveGameProgress("baseball_mlb", { ...base, inningHalf: "Bottom", inningOrdinal: "5th" });
    approx("MLB Bottom 5th pct (4.5 / 9)", r!.pct, 50);
  }
  {
    const r = getLiveGameProgress("baseball_mlb", { ...base, inningHalf: "End", inningOrdinal: "9th" });
    approx("MLB End 9th pct (9 / 9, full bar)", r!.pct, 100);
  }
  {
    const r = getLiveGameProgress("baseball_mlb", { ...base, inningHalf: "Top", inningOrdinal: "11th" });
    approx("MLB extra innings pct clamps to full bar", r!.pct, 100);
  }
  check(
    "MLB missing inning data -> null",
    getLiveGameProgress("baseball_mlb", { ...base, inningHalf: null, inningOrdinal: null }),
    null
  );

  // ==== NFL: 4x15min quarters ====
  {
    const r = getLiveGameProgress("americanfootball_nfl", { ...base, period: 1, clock: "15:00" });
    check("NFL Q1 15:00 label", r?.label, "Q1 15:00");
    approx("NFL Q1 15:00 pct (start of game)", r!.pct, 0);
  }
  {
    const r = getLiveGameProgress("americanfootball_nfl", { ...base, period: 3, clock: "7:30" });
    // 2 full quarters (30 min) + 7.5 min elapsed of Q3 = 37.5 / 60 min
    approx("NFL Q3 7:30 pct", r!.pct, (37.5 / 60) * 100);
  }
  {
    const r = getLiveGameProgress("americanfootball_nfl", { ...base, period: 5, clock: "9:15" });
    check("NFL OT label", r?.label, "OT 9:15");
    approx("NFL OT pct clamps to full bar", r!.pct, 100);
  }

  // ==== NBA: 4x12min quarters ====
  {
    const r = getLiveGameProgress("basketball_nba", { ...base, period: 2, clock: "6:00" });
    // 1 full quarter (12) + 6 elapsed = 18 / 48
    approx("NBA Q2 6:00 pct", r!.pct, (18 / 48) * 100);
    check("NBA Q2 6:00 label", r?.label, "Q2 6:00");
  }

  // ==== NHL: 3x20min periods ====
  {
    const r = getLiveGameProgress("icehockey_nhl", { ...base, period: 2, clock: "12:05" });
    check("NHL P2 12:05 label", r?.label, "P2 12:05");
    // 1 full period (20) + 7:55 elapsed = 27:55 / 60
    approx("NHL P2 12:05 pct", r!.pct, ((20 + 20 - 12 - 5 / 60) / 60) * 100);
  }

  // ==== Missing/garbled clock still gives a period-level pct, not null ====
  {
    const r = getLiveGameProgress("basketball_wnba", { ...base, period: 3, clock: null });
    check("WNBA missing clock label falls back to period only", r?.label, "Q3");
    approx("WNBA missing clock pct uses period boundary (2/4)", r!.pct, 50);
  }
  check(
    "quarter sport missing period -> null",
    getLiveGameProgress("americanfootball_nfl", { ...base, period: null, clock: "5:00" }),
    null
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
