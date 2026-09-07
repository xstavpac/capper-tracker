// The natural-phrasing /live game-card record line - run with:
//   npx tsx src/lib/game-card-record-line-acceptance-test.ts
//
// Format (per the game-card mockup):
//   "Team +3.5 · 58% overall on total picks (21-15-2) · 60% in NCAAF (3-2) 🔥4"
//   - clause 1: all-time record in this pick's MARKET (side dropped -
//     "total" / "spread" / "moneyline")
//   - clause 2: record in the GAME'S LEAGUE - dropped entirely when the capper
//     has no graded pick in that league yet
//   - "·" before the first clause and between clauses; each clause's win% and
//     (record) colored by that clause's own win rate (component concern)
//   - a trailing 🔥/🧊 streak indicator in the slot the old "L20" segment held,
//     nothing below a 2+ streak - no fallback number
//
// Proven here: the exact text, the dropped-league-clause case, pushes, the
// 🔥/🧊 indicator + its hover tooltip (count and direction), the "no category
// history" line, and the mobile-width behaviour - which now ACCEPTS a wrap to
// a second row for the plainer wording and only guards against a third.

import {
  gameCardRecordClauses,
  gameCardRecordPortionText,
  gameCardRecordLineText,
  gameCardNoHistoryLineText,
  gameCardStreakSuffix,
  gameCardStreakTooltip,
  estimateGameCardLineWidthPx,
  GAME_CARD_LINE_MOBILE_BUDGET_PX,
  GAME_CARD_LINE_MAX_ROWS,
  GAME_CARD_NO_HISTORY_TEXT,
  type GameCardStreak,
} from "@/lib/game-card-record-line";

const winStreak = (count: number): GameCardStreak => ({ type: "WIN", count });
const lossStreak = (count: number): GameCardStreak => ({ type: "LOSS", count });

// At most GAME_CARD_LINE_MAX_ROWS rows: the natural-phrasing line is longer
// than the compact format it replaced and a second-row wrap is an accepted
// tradeoff - the guard only stops a third row.
const MAX_LINE_PX = GAME_CARD_LINE_MOBILE_BUDGET_PX * GAME_CARD_LINE_MAX_ROWS;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkLte(label: string, actual: number, limit: number) {
  const pass = actual <= limit;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual} <= ${limit}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? "PASS" : "FAIL"}: ${label}`);
  if (!actual) failures++;
}

const col = (wins: number, losses: number, pushes = 0) => ({
  wins,
  losses,
  pushes,
  winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
});

const clausesFor = (
  overall: ReturnType<typeof col>,
  league: ReturnType<typeof col> | null,
  marketNoun = "total",
  leagueName = "NCAAF"
) =>
  gameCardRecordClauses(
    { overall, league: league ?? col(0, 0) },
    { leagueName, marketNoun, hasLeagueHistory: league !== null }
  );

// ---------------------------------------------------------------------------
console.log("########## exact natural phrasing ##########");
{
  const clauses = clausesFor(col(21, 15, 2), col(3, 2));
  check("two clauses: overall + league", clauses.map((c) => c.scope), ["overall on total picks", "in NCAAF"]);
  check("each clause carries a rounded win%", clauses.map((c) => c.pct), ["58%", "60%"]);
  check("each clause carries its own W-L(-P) record", clauses.map((c) => c.record), ["21-15-2", "3-2"]);
  check(
    "portion text - '·' between clauses, parenthesised records",
    gameCardRecordPortionText(clauses),
    "58% overall on total picks (21-15-2) · 60% in NCAAF (3-2)"
  );
  check(
    "full line - '·' before the first clause",
    gameCardRecordLineText("Team +3.5", clauses),
    "Team +3.5 · 58% overall on total picks (21-15-2) · 60% in NCAAF (3-2)"
  );
}
{
  // Side-dropped market nouns: a spread and a moneyline pick.
  check(
    "spread pick reads 'on spread picks'",
    gameCardRecordPortionText(clausesFor(col(12, 5), col(2, 1), "spread")),
    "71% overall on spread picks (12-5) · 67% in NCAAF (2-1)"
  );
  check(
    "moneyline pick reads 'on moneyline picks'",
    gameCardRecordPortionText(clausesFor(col(33, 27), col(1, 1), "moneyline")),
    "55% overall on moneyline picks (33-27) · 50% in NCAAF (1-1)"
  );
}
{
  // No graded pick in the game's league yet -> the "in <league>" clause is
  // dropped entirely (never "0% in NCAAF (0-0)").
  const clauses = clausesFor(col(21, 15, 2), null);
  check("league clause dropped when the capper has no history in it", clauses.map((c) => c.scope), ["overall on total picks"]);
  check(
    "line ends after the overall clause, no trailing '· 0% in NCAAF (0-0)'",
    gameCardRecordLineText("Team +3.5", clauses),
    "Team +3.5 · 58% overall on total picks (21-15-2)"
  );
}
check(
  "pushes render in both records (21-15-2 / 3-2-1 style)",
  gameCardRecordPortionText(clausesFor(col(3, 3, 1), col(2, 2, 1), "total", "NBA")),
  "50% overall on total picks (3-3-1) · 50% in NBA (2-2-1)"
);

// ---------------------------------------------------------------------------
console.log("\n##########  trailing 🔥/🧊 streak indicator (the old L20 slot)  ##########");
{
  // Below 2 in either direction -> nothing. The slot does NOT fall back to any
  // other number - it simply renders empty.
  check("no streak: 1 win -> empty suffix", gameCardStreakSuffix(winStreak(1)), "");
  check("no streak: 1 loss -> empty suffix", gameCardStreakSuffix(lossStreak(1)), "");
  check("no streak: NONE -> empty suffix", gameCardStreakSuffix({ type: "NONE", count: 0 }), "");
  check("no streak: null -> empty suffix", gameCardStreakSuffix(null), "");
  check("no streak: undefined -> empty suffix", gameCardStreakSuffix(undefined), "");

  check("2 win streak -> 🔥2", gameCardStreakSuffix(winStreak(2)), "🔥2");
  check("4 win streak -> 🔥4", gameCardStreakSuffix(winStreak(4)), "🔥4");
  check("3 loss streak -> 🧊3", gameCardStreakSuffix(lossStreak(3)), "🧊3");
  check("double-digit streak keeps the full count -> 🔥12", gameCardStreakSuffix(winStreak(12)), "🔥12");

  const clauses = clausesFor(col(21, 15, 2), col(3, 2));
  // Below 2 -> portion / line are byte-identical to the no-streak form.
  check(
    "portion with a sub-2 streak == portion with no streak",
    gameCardRecordPortionText(clauses, winStreak(1)),
    gameCardRecordPortionText(clauses)
  );
  check(
    "line with a sub-2 streak == line with no streak",
    gameCardRecordLineText("Team +3.5", clauses, lossStreak(1)),
    gameCardRecordLineText("Team +3.5", clauses)
  );

  // 2+ -> appended after the last clause, single space, at the very end.
  check(
    "win streak appends 🔥4 after the league clause",
    gameCardRecordPortionText(clauses, winStreak(4)),
    "58% overall on total picks (21-15-2) · 60% in NCAAF (3-2) 🔥4"
  );
  check(
    "loss streak appends 🧊2 at the end of the full line",
    gameCardRecordLineText("Team +3.5", clauses, lossStreak(2)),
    "Team +3.5 · 58% overall on total picks (21-15-2) · 60% in NCAAF (3-2) 🧊2"
  );
  // With the league clause dropped the indicator still lands at the very end.
  check(
    "indicator appends after the overall clause when the league clause is dropped",
    gameCardRecordLineText("Team +3.5", clausesFor(col(21, 15, 2), null), winStreak(4)),
    "Team +3.5 · 58% overall on total picks (21-15-2) 🔥4"
  );

  // No category history: the streak is overall, not category-scoped, so it
  // shows on the "no history" line too.
  check(
    "streak shows on the no-category-history line",
    gameCardNoHistoryLineText("Team +3.5", winStreak(3)),
    "Team +3.5 · " + GAME_CARD_NO_HISTORY_TEXT + " 🔥3"
  );
  check(
    "no-history line without a streak is unchanged",
    gameCardNoHistoryLineText("Team +3.5", lossStreak(1)),
    "Team +3.5 · " + GAME_CARD_NO_HISTORY_TEXT
  );
  check("empty clauses + streak -> portion is the bare suffix", gameCardRecordPortionText([], winStreak(2)), "🔥2");
}

// ---------------------------------------------------------------------------
console.log("\n##########  streak hover tooltip: count + direction  ##########");
{
  // The tooltip text must name the exact streak count and its direction.
  for (const n of [2, 3, 4, 7, 12]) {
    check(`win streak of ${n} -> "Won ${n} in a row"`, gameCardStreakTooltip(winStreak(n)), `Won ${n} in a row`);
    check(`loss streak of ${n} -> "Lost ${n} in a row"`, gameCardStreakTooltip(lossStreak(n)), `Lost ${n} in a row`);
  }
  // Below the 2+ cutoff there's no glyph, so there's no tooltip either.
  check("1 win -> no tooltip", gameCardStreakTooltip(winStreak(1)), "");
  check("1 loss -> no tooltip", gameCardStreakTooltip(lossStreak(1)), "");
  check("NONE -> no tooltip", gameCardStreakTooltip({ type: "NONE", count: 0 }), "");
  check("null -> no tooltip", gameCardStreakTooltip(null), "");

  // The tooltip and the glyph always agree about whether they render, and the
  // count in the tooltip matches the count in the glyph.
  for (const streak of [winStreak(2), winStreak(9), lossStreak(2), lossStreak(5)]) {
    const suffix = gameCardStreakSuffix(streak);
    const tooltip = gameCardStreakTooltip(streak);
    checkTrue(`glyph "${suffix}" and tooltip "${tooltip}" both present`, suffix !== "" && tooltip !== "");
    checkTrue(`tooltip "${tooltip}" ends with the glyph's count (${streak.count})`, tooltip.includes(String(streak.count)));
    checkTrue(
      `tooltip direction matches the glyph (${streak.type})`,
      streak.type === "WIN" ? tooltip.startsWith("Won") && suffix.startsWith("🔥") : tooltip.startsWith("Lost") && suffix.startsWith("🧊")
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n##########  mobile width: a second-row wrap is accepted, a third is not  ##########");
{
  // The canonical example still fits ONE row as a bare portion; a full line
  // with a normal bet detail wraps to a second row - accepted.
  const clauses = clausesFor(col(21, 15, 2), col(3, 2));
  checkLte(
    "canonical record portion still fits one row on its own",
    estimateGameCardLineWidthPx(gameCardRecordPortionText(clauses)),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
  for (const bet of ["Team +3.5", "Over 55.5", "UNLV +7", "Bama ML", "Washington State -7"]) {
    for (const streak of [null, winStreak(3), lossStreak(2), winStreak(12)] as (GameCardStreak | null)[]) {
      checkLte(
        `full line stays within ${GAME_CARD_LINE_MAX_ROWS} rows: "${bet}"${streak ? " + " + gameCardStreakSuffix(streak) : ""}`,
        estimateGameCardLineWidthPx(gameCardRecordLineText(bet, clauses, streak)),
        MAX_LINE_PX
      );
    }
  }
}
{
  // Longest realistic market noun (a segment moneyline) + a 3-digit lifetime
  // record + a long college team name + a loss streak - still at most 2 rows.
  const clauses = clausesFor(col(142, 38), col(98, 22), "1st quarter moneyline");
  const line = gameCardRecordLineText("Washington State -7", clauses, lossStreak(6));
  const px = estimateGameCardLineWidthPx(line);
  checkLte(`worst-case line ("${line}") stays within ${GAME_CARD_LINE_MAX_ROWS} rows`, px, MAX_LINE_PX);
}
{
  // The no-category-history line + a streak is short - one row.
  checkLte(
    'no-history line + "🔥3" fits one row: "Team +3.5"',
    estimateGameCardLineWidthPx(gameCardNoHistoryLineText("Team +3.5", winStreak(3))),
    GAME_CARD_LINE_MOBILE_BUDGET_PX
  );
}

// ---------------------------------------------------------------------------
console.log("\n##########  a dense 9-pick card: every line stays within two rows  ##########");
{
  const above = clausesFor(col(41, 19), col(7, 1), "total");
  const below = clausesFor(col(12, 8), null, "moneyline");
  const stacked = [
    { bet: "UNLV +7", clauses: above, streak: winStreak(3) },
    { bet: "Over 55.5", clauses: above, streak: lossStreak(2) },
    { bet: "Under 55.5", clauses: below, streak: winStreak(4) },
    { bet: "UNLV ML", clauses: below, streak: null },
    { bet: "Over 27.5 1H", clauses: above, streak: winStreak(2) },
    { bet: "UNLV 1H +3.5", clauses: below, streak: lossStreak(3) },
    { bet: "Washington State -7", clauses: above, streak: null },
    { bet: "Washington State ML", clauses: below, streak: winStreak(5) },
    { bet: "Bama TT o24.5", clauses: above, streak: lossStreak(2) },
  ] as { bet: string; clauses: ReturnType<typeof clausesFor>; streak: GameCardStreak | null }[];
  const overThree = stacked.filter(
    (p) => estimateGameCardLineWidthPx(gameCardRecordLineText(p.bet, p.clauses, p.streak)) > MAX_LINE_PX
  );
  check("no pick's line spills past two rows", overThree.map((p) => p.bet), []);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
