// Proof for NCAAB first-half grading and the NCAAB period guard (resolveOutcome,
// grading.ts), plus the pick gate on NCAAB game results - run with:
//   npx tsx src/server/data/ncaab-grading-guard-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on
// any failure. No DB, no network.
//
// NCAAB plays two halves. ESPN's summary linescore for an NCAAB final is
// [1H, 2H] plus one entry per overtime (confirmed live 2026-11-09 on 33
// regulation + 13 OT finals). The quarter sports' first half, linescore[0] +
// linescore[1], is ALL of regulation here, so firstHalfFromLinescore (odds.ts)
// takes linescore[0] alone for NCAAB. The main fixture is a real final (ESPN
// event 401920912, 2026-11-02): Grambling 89, Northern Illinois 87,
// linescores [43, 46] and [36, 51] - first half 43-36.
//
// The guard: NCAAB grades FULL_GAME, FIRST_HALF and SECOND_HALF. Quarter periods
// would read the halves as quarters. SECOND_HALF is final - 1H, so OT is folded
// in, the same convention as NFL/NCAAF/NBA/WNBA.

import { resolveOutcome, withSportKey } from "./grading";
import { firstHalfFromLinescore } from "./odds";
import { segmentUnmatchedReason } from "@/lib/pending-pick-reason";
import { finalsWithPicks, PICK_GATED_SPORT_KEYS, NCAAB_SPORT_KEY } from "@/lib/final-pick-gate";
import { tendencyPhaseEnabled } from "@/lib/tendency-pipeline";
import { parseCatalog } from "@/lib/parse-catalog";
import { runAmbiguousHierarchy } from "@/lib/ambiguous-hierarchy";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const ls = (home: number[], away: number[]) => home.map((h, i) => ({ home: h, away: away[i] }));

// ---- the extraction: real ESPN linescores -> first half ----
const GRAMBLING_LS = ls([43, 46], [36, 51]);
check("NCAAB regulation final: first half is linescore[0] (43-36), not 89-87", firstHalfFromLinescore(NCAAB_SPORT_KEY, GRAMBLING_LS), { home: 43, away: 36 });
// ESPN 401917515, Tarleton State at San Diego, Final/OT 96-90.
check(
  "NCAAB OT final (3 entries): first half is still linescore[0] (32-46)",
  firstHalfFromLinescore(NCAAB_SPORT_KEY, ls([32, 50, 14], [46, 36, 8])),
  { home: 32, away: 46 }
);
// ESPN 401926780, Jacksonville State at South Alabama, Final/2OT 83-80. Four
// entries that are NOT quarters: summing [0]+[1] would give 66-66.
const SOUTH_ALABAMA_2OT = ls([23, 43, 6, 11], [32, 34, 6, 8]);
check("NCAAB 2OT final (4 entries): first half is linescore[0] (23-32), not 66-66", firstHalfFromLinescore(NCAAB_SPORT_KEY, SOUTH_ALABAMA_2OT), { home: 23, away: 32 });
check("NCAAB truncated linescore (1 entry) -> null", firstHalfFromLinescore(NCAAB_SPORT_KEY, ls([43], [36])), null);
check("NCAAB no linescore -> null", firstHalfFromLinescore(NCAAB_SPORT_KEY, null), null);
// Other sports untouched: Q1 + Q2.
check("NBA keeps Q1+Q2 on the same 4 entries (66-66)", firstHalfFromLinescore("basketball_nba", SOUTH_ALABAMA_2OT), { home: 66, away: 66 });
check("WNBA keeps Q1+Q2", firstHalfFromLinescore("basketball_wnba", SOUTH_ALABAMA_2OT), { home: 66, away: 66 });
check("NCAAF keeps Q1+Q2", firstHalfFromLinescore("americanfootball_ncaaf", SOUTH_ALABAMA_2OT), { home: 66, away: 66 });
check("NHL has no half", firstHalfFromLinescore("icehockey_nhl", SOUTH_ALABAMA_2OT), null);

// The real final, as persistFinalScores now stores it: firstFive* = linescore[0].
const GAME = {
  homeTeam: "Grambling Tigers",
  awayTeam: "Northern Illinois Huskies",
  homeScore: 89,
  awayScore: 87,
  firstFiveHomeScore: 43,
  firstFiveAwayScore: 36,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: GRAMBLING_LS as never,
};
const ncaab = { ...GAME, sportKey: NCAAB_SPORT_KEY };
const nba = { ...GAME, sportKey: "basketball_nba" };

const pick = (period: string, betType: string, betDetail: string, line: number | null, pickedSide: "HOME" | "AWAY" | null = null) => ({
  period,
  betType,
  betDetail,
  line,
  homeTeam: GAME.homeTeam,
  pickedSide,
});

// ---- FIRST_HALF now grades for NCAAB, off 43-36 ----
const H1_OVER = pick("FIRST_HALF", "TOTAL", "1H Over 80.5", 80.5);
const H2_OVER = pick("SECOND_HALF", "TOTAL", "2H Over 80.5", 80.5);
const Q1_OVER = pick("FIRST_QUARTER", "TOTAL", "1Q Over 40.5", 40.5);

check("NCAAB 1H Over 80.5 LOSES (79 at the half; the buggy 176 would have won it)", resolveOutcome(H1_OVER, ncaab), "LOSS");
check("NCAAB 1H Over 75.5 wins (79)", resolveOutcome(pick("FIRST_HALF", "TOTAL", "1H Over 75.5", 75.5), ncaab), "WIN");
check("NCAAB 1H Under 80.5 wins (79)", resolveOutcome(pick("FIRST_HALF", "TOTAL", "1H Under 80.5", 80.5), ncaab), "WIN");
check("NCAAB 1H moneyline, stored HOME: Grambling led 43-36 -> WIN", resolveOutcome(pick("FIRST_HALF", "MONEYLINE", "1H Grambling ML", null, "HOME"), ncaab), "WIN");
check("NCAAB 1H moneyline, stored AWAY -> LOSS", resolveOutcome(pick("FIRST_HALF", "MONEYLINE", "1H Northern Illinois ML", null, "AWAY"), ncaab), "LOSS");
check("NCAAB 1H spread: Northern Illinois +3.5 down 7 -> LOSS", resolveOutcome(pick("FIRST_HALF", "SPREAD", "1H Northern Illinois +3.5", 3.5, "AWAY"), ncaab), "LOSS");
check("NCAAB 1H spread: Northern Illinois +7.5 down 7 -> WIN", resolveOutcome(pick("FIRST_HALF", "SPREAD", "1H Northern Illinois +7.5", 7.5, "AWAY"), ncaab), "WIN");
check("NCAAB 1H spread: Grambling -7 up 7 -> PUSH", resolveOutcome(pick("FIRST_HALF", "SPREAD", "1H Grambling -7", -7, "HOME"), ncaab), "PUSH");
check(
  "NCAAB 1H pick on a row with no first-half score yet stays PENDING",
  resolveOutcome(H1_OVER, { ...ncaab, firstFiveHomeScore: null, firstFiveAwayScore: null }),
  null
);
check(
  "NCAAB pick stored FULL_GAME whose text says 1H -> PENDING, never graded off the full game",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling 1H ML", null, "HOME"), ncaab),
  null
);

// The real pending prod pick cmw5gn2pl0025s8d4twl0one4 (LearLocks), field for
// field, against ESPN 401909552: Boston College 71, UMass 55, linescores
// [37, 34] and [35, 20] - 1H 37-35.
const BC_LS = ls([37, 34], [35, 20]);
const BC_UMASS = {
  sportKey: NCAAB_SPORT_KEY,
  homeTeam: "Boston College Eagles",
  awayTeam: "Massachusetts Minutemen",
  homeScore: 71,
  awayScore: 55,
  firstFiveHomeScore: null as number | null,
  firstFiveAwayScore: null as number | null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: BC_LS as never,
};
const BC_FH = firstHalfFromLinescore(NCAAB_SPORT_KEY, BC_LS);
check("BC/UMass: first half extracted as 37-35", BC_FH, { home: 37, away: 35 });
const BC_PICK = {
  betType: "MONEYLINE",
  betDetail: "Boston College 1H moneyline",
  line: null,
  period: "FIRST_HALF",
  homeTeam: "Boston College Eagles",
  pickedSide: "HOME" as const,
};
check("BC 1H ML: PENDING while the row has no first-half score (prod today)", resolveOutcome(BC_PICK, BC_UMASS), null);
const BC_GRADED = { ...BC_UMASS, firstFiveHomeScore: BC_FH?.home ?? null, firstFiveAwayScore: BC_FH?.away ?? null };
check("BC 1H ML: WIN once firstFive* = 37-35", resolveOutcome(BC_PICK, BC_GRADED), "WIN");
check("BC 1H ML: the text alone (no stored pickedSide) also reads Boston College -> WIN", resolveOutcome({ ...BC_PICK, pickedSide: null }, BC_GRADED), "WIN");

// ---- SECOND_HALF grades for NCAAB: final minus 1H, OT included ----
// Grambling 89-87, 1H 43-36 -> 2H 46-51 (total 97).
check("NCAAB 2H Over 80.5 wins (97)", resolveOutcome(H2_OVER, ncaab), "WIN");
check("NCAAB 2H Under 80.5 loses (97)", resolveOutcome(pick("SECOND_HALF", "TOTAL", "2H Under 80.5", 80.5), ncaab), "LOSS");
check("NCAAB 2H moneyline, stored AWAY: Northern Illinois won the 2nd half 51-46 -> WIN", resolveOutcome(pick("SECOND_HALF", "MONEYLINE", "2H Northern Illinois ML", null, "AWAY"), ncaab), "WIN");
check("NCAAB 2H moneyline, stored HOME -> LOSS", resolveOutcome(pick("SECOND_HALF", "MONEYLINE", "2H Grambling ML", null, "HOME"), ncaab), "LOSS");
check("NCAAB 2H spread: Northern Illinois -5 won the half by 5 -> PUSH", resolveOutcome(pick("SECOND_HALF", "SPREAD", "2H Northern Illinois -5", -5, "AWAY"), ncaab), "PUSH");
check("NCAAB 2H pick on a row with no first-half score stays PENDING", resolveOutcome(H2_OVER, { ...ncaab, firstFiveHomeScore: null, firstFiveAwayScore: null }), null);

// Real OT finals (ESPN, see above). The 2H must include the overtime periods.
// Tarleton State at San Diego, Final/OT 96-90: 1H 32-46, so 2H incl. OT is
// 64-44 (total 108). Regulation-only 2H would be 50-36 (total 86).
const SD_OT = {
  sportKey: NCAAB_SPORT_KEY,
  homeTeam: "San Diego Toreros",
  awayTeam: "Tarleton State Texans",
  homeScore: 96,
  awayScore: 90,
  firstFiveHomeScore: 32,
  firstFiveAwayScore: 46,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: ls([32, 50, 14], [46, 36, 8]) as never,
};
const sdPick = (betType: string, betDetail: string, line: number | null, side: "HOME" | "AWAY" | null = null) => ({
  period: "SECOND_HALF",
  betType,
  betDetail,
  line,
  homeTeam: SD_OT.homeTeam,
  pickedSide: side,
});
check("OT final: 2H Over 90.5 WINS (108 with OT; 86 regulation-only would lose)", resolveOutcome(sdPick("TOTAL", "2H Over 90.5", 90.5), SD_OT), "WIN");
check("OT final: 2H Under 90.5 LOSES", resolveOutcome(sdPick("TOTAL", "2H Under 90.5", 90.5), SD_OT), "LOSS");
check("OT final: 2H San Diego -19.5 covers (64-44 = 20 with OT; 14 in regulation)", resolveOutcome(sdPick("SPREAD", "2H San Diego -19.5", -19.5, "HOME"), SD_OT), "WIN");
check("OT final: 2H Tarleton State +20 pushes (lost the 2H by 20)", resolveOutcome(sdPick("SPREAD", "2H Tarleton State +20", 20, "AWAY"), SD_OT), "PUSH");

// Jacksonville State at South Alabama, Final/2OT 83-80: 1H 23-32 -> 2H incl.
// both OTs is 60-48 (total 108, margin 12). Regulation-only 2H: 43-34 (77, 9).
const SA_2OT = {
  sportKey: NCAAB_SPORT_KEY,
  homeTeam: "South Alabama Jaguars",
  awayTeam: "Jacksonville State Gamecocks",
  homeScore: 83,
  awayScore: 80,
  firstFiveHomeScore: 23,
  firstFiveAwayScore: 32,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: SOUTH_ALABAMA_2OT as never,
};
const saPick = (betType: string, betDetail: string, line: number | null, side: "HOME" | "AWAY" | null = null) => ({
  period: "SECOND_HALF",
  betType,
  betDetail,
  line,
  homeTeam: SA_2OT.homeTeam,
  pickedSide: side,
});
check("2OT final: 2H Over 100.5 WINS (108 with both OTs; 77 regulation-only)", resolveOutcome(saPick("TOTAL", "2H Over 100.5", 100.5), SA_2OT), "WIN");
check("2OT final: 2H South Alabama -10.5 COVERS (+12 with OT; +9 regulation-only would lose)", resolveOutcome(saPick("SPREAD", "2H South Alabama -10.5", -10.5, "HOME"), SA_2OT), "WIN");
check("2OT final: 2H Jacksonville State +11.5 loses", resolveOutcome(saPick("SPREAD", "2H Jacksonville State +11.5", 11.5, "AWAY"), SA_2OT), "LOSS");
check("2OT final: the full game still grades off 83-80 (163 > 162.5)", resolveOutcome({ ...saPick("TOTAL", "Over 162.5", 162.5), period: "FULL_GAME" }, SA_2OT), "WIN");

// ---- the guard: quarter periods stay PENDING for NCAAB ----
check("NCAAB FIRST_QUARTER total stays PENDING (linescore[0] is a half, not Q1)", resolveOutcome(Q1_OVER, ncaab), null);
check("NCAAB SECOND_QUARTER stays PENDING", resolveOutcome(pick("SECOND_QUARTER", "TOTAL", "2Q Over 40.5", 40.5), ncaab), null);
check("NCAAB THIRD_QUARTER stays PENDING (index 2 would be OT)", resolveOutcome(pick("THIRD_QUARTER", "TOTAL", "3Q Over 1.5", 1.5), ncaab), null);
check("NCAAB FOURTH_QUARTER stays PENDING", resolveOutcome(pick("FOURTH_QUARTER", "TOTAL", "4Q Over 1.5", 1.5), ncaab), null);

// Control: the SAME row and picks grade under another sport, so the nulls above
// are the guard and not a bad fixture.
check("control: same SECOND_HALF total is computed under NBA (46 + 51 = 97 > 80.5)", resolveOutcome(H2_OVER, nba), "WIN");
check("control: same FIRST_QUARTER total grades under NBA (43 + 36 = 79 > 40.5)", resolveOutcome(Q1_OVER, nba), "WIN");
check("control: a row with no sportKey (older callers) is unguarded", resolveOutcome(Q1_OVER, GAME), "WIN");

// ---- Pending Picks reason mirrors the guard ----
const NCAAB_ONLY_MSG = "NCAAB grading covers full game and halves only - needs manual grading";
check("reason: NCAAB SECOND_HALF waiting on its score -> the normal 'not posted yet' wording", segmentUnmatchedReason("SECOND_HALF", "SECOND_HALF", NCAAB_SPORT_KEY, "1H"), "matched game, but the 2nd half score isn't posted for this game yet");
check("reason: NCAAB FIRST_QUARTER -> same message", segmentUnmatchedReason("FIRST_QUARTER", "FIRST_QUARTER", NCAAB_SPORT_KEY, "1H"), NCAAB_ONLY_MSG);
check(
  "reason: NCAAB FIRST_HALF waiting on its score -> the normal 'not posted yet' wording",
  segmentUnmatchedReason("FIRST_HALF", "FIRST_HALF", NCAAB_SPORT_KEY, "1H"),
  "matched game, but the 1st half score isn't posted for this game yet"
);

// ---- FULL_GAME still grades for NCAAB ----
check(
  "NCAAB FULL_GAME total grades (176 > 170.5)",
  resolveOutcome(pick("FULL_GAME", "TOTAL", "Over 170.5", 170.5), ncaab),
  "WIN"
);
check(
  "NCAAB FULL_GAME total under loses (176 is not under 170.5)",
  resolveOutcome(pick("FULL_GAME", "TOTAL", "Under 170.5", 170.5), ncaab),
  "LOSS"
);
check(
  "NCAAB FULL_GAME spread on a stored side grades (Northern Illinois lost by 2, +3.5 covers)",
  resolveOutcome(pick("FULL_GAME", "SPREAD", "Northern Illinois +3.5", 3.5, "AWAY"), ncaab),
  "WIN"
);
check(
  "NCAAB FULL_GAME moneyline on a stored side grades (Grambling won)",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling ML", null, "HOME"), ncaab),
  "WIN"
);

// Team-name resolution with NO stored side (the text fallback). Works for the
// mascot and for a school that also plays NCAAF; a school only the text names
// by its SCHOOL (no NCAAB school list until PR B) resolves to neither team and
// stays PENDING - never graded onto a guessed side.
check(
  "text fallback: mascot ('Huskies') resolves the away side",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Huskies ML", null), ncaab),
  "LOSS"
);
check(
  "text fallback: school shared with NCAAF ('Northern Illinois') resolves",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Northern Illinois ML", null), ncaab),
  "LOSS"
);
check(
  "text fallback: a school by name ('Grambling') resolves its side now that the list carries it (Grambling won 89-87)",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling ML", null), ncaab),
  "WIN"
);
check(
  "text fallback: the real final, by the loser's school (Northern Illinois lost 87-89)",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "NIU ML", null), ncaab),
  "LOSS"
);
check(
  "text fallback: Grambling -1.5 covers a 2-point win",
  resolveOutcome(pick("FULL_GAME", "SPREAD", "Grambling -1.5", -1.5), ncaab),
  "WIN"
);
check(
  "text fallback: Grambling -3.5 doesn't",
  resolveOutcome(pick("FULL_GAME", "SPREAD", "Grambling -3.5", -3.5), ncaab),
  "LOSS"
);
check(
  "text fallback: the longer alias reads the same ('Grambling State ML')",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Grambling State ML", null), ncaab),
  "WIN"
);

// ---- the whole road: pasted text to a graded pick ----
async function wholeRoad() {
  // The parser, then the hierarchy with the real game on the score feed. No football
  // game is on the board for either school.
  const near = async (queries: { nickname: string; sport: string }[]) =>
    Object.fromEntries(queries.map((q) => [q.nickname + "|" + q.sport, q.sport === "NCAAB" && q.nickname === "grambling tigers"]));
  const log = console.log;
  console.log = () => {};
  const { picks } = await runAmbiguousHierarchy(
    parseCatalog("Sharp\nGrambling ML\n", ["Sharp"], undefined, NCAAB_LISTED_TEAMS).picks,
    {},
    { runScheduleCheck: near, runWideScheduleCheck: near, now: new Date("2026-11-02T18:00:00Z") }
  );
  console.log = log;
  const imported = picks[0];
  check("'Grambling ML' imports as NCAAB on a basketball-only night", [imported.sportName, imported.ambiguous, imported.teamNicknames], ["NCAAB", undefined, ["grambling tigers"]]);
  check(
    "and grades WIN against the real Grambling 89 - Northern Illinois 87 final",
    resolveOutcome(pick(imported.period, imported.betType, imported.description, null), ncaab),
    "WIN"
  );
}

// A team outside both college lists has no school keys, so this stays a no-op for
// every other sport.
check(
  "text fallback: a pro game gets no school reading",
  resolveOutcome(pick("FULL_GAME", "MONEYLINE", "Memphis ML", null), { ...GAME, homeTeam: "Memphis Grizzlies", awayTeam: "Utah Jazz", sportKey: "basketball_nba" }),
  null
);

// ---- the guard travels with the candidate pool ----
const pool = withSportKey([{ homeTeam: "A" }, { homeTeam: "B" }], NCAAB_SPORT_KEY);
check("withSportKey stamps every row and leaves the rest", pool, [
  { homeTeam: "A", sportKey: NCAAB_SPORT_KEY },
  { homeTeam: "B", sportKey: NCAAB_SPORT_KEY },
]);
check("a pool row stamped NCAAB is guarded", resolveOutcome(Q1_OVER, { ...GAME, ...withSportKey([{}], NCAAB_SPORT_KEY)[0] }), null);

// ---- the pick gate: NCAAB persists only finals a pending pick names ----
check("NCAAB is the only pick-gated sport", [...PICK_GATED_SPORT_KEYS], [NCAAB_SPORT_KEY]);

const finals = [
  { id: "1", homeTeam: "Grambling Tigers", awayTeam: "Northern Illinois Huskies" },
  { id: "2", homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
  { id: "3", homeTeam: "Gonzaga Bulldogs", awayTeam: "Houston Cougars" },
  { id: "4", homeTeam: "Saint Mary's Gaels", awayTeam: "San José State Spartans" },
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

check("no pending picks -> no final is persisted", ids(finalsWithPicks(finals, [], NCAAB_SPORT_KEY)), []);
check(
  "a pick on one game keeps that final only",
  ids(finalsWithPicks(finals, [{ homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" }], NCAAB_SPORT_KEY)),
  ["2"]
);
check(
  "home/away swapped between feeds (neutral site) still matches",
  ids(finalsWithPicks(finals, [{ homeTeam: "Houston Cougars", awayTeam: "Gonzaga Bulldogs" }], NCAAB_SPORT_KEY)),
  ["3"]
);
check(
  "case and accents fold the way every cross-feed join does",
  ids(finalsWithPicks(finals, [{ homeTeam: "saint mary's gaels", awayTeam: "San Jose State Spartans" }], NCAAB_SPORT_KEY)),
  ["4"]
);
check(
  "two picks on the same game, one on another: three finals' worth of picks keep exactly two finals",
  ids(
    finalsWithPicks(
      finals,
      [
        { homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
        { homeTeam: "Duke Blue Devils", awayTeam: "Kansas Jayhawks" },
        { homeTeam: "Grambling Tigers", awayTeam: "Northern Illinois Huskies" },
      ],
      NCAAB_SPORT_KEY
    )
  ),
  ["1", "2"]
);
check(
  "one shared team is not enough: the same home team against a different opponent is a different game",
  ids(finalsWithPicks(finals, [{ homeTeam: "Duke Blue Devils", awayTeam: "Houston Cougars" }], NCAAB_SPORT_KEY)),
  []
);
check("no finals -> nothing", finalsWithPicks([], [{ homeTeam: "x", awayTeam: "y" }], NCAAB_SPORT_KEY), []);

// ---- tendencies: a pick-gated sport never takes part (its GameResult rows are a sample of what was bet on) ----
check("tendency phase: NCAAB is out even when the pipeline is on", tendencyPhaseEnabled(true, NCAAB_SPORT_KEY), false);
check("tendency phase: other sports follow the pipeline flag (on)", tendencyPhaseEnabled(true, "basketball_nba"), true);
check("tendency phase: other sports follow the pipeline flag (off)", tendencyPhaseEnabled(false, "basketball_nba"), false);

wholeRoad().then(() => {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
});
