// The /live game-card capper record block - run with:
//   npx tsx src/lib/game-card-record-line-acceptance-test.ts
//
// It is a stack of rows now (not the old inline sentence + width guard):
//
//   Team +3.5
//   40% (2-3) overall on underdog moneyline picks     <- row 1
//   55% (11-9) in NCAAF                                <- row 2 (omitted if no
//   🔥 4 game win streak                                    league history)
//                                                     <- row 3 (only if 2+)
//
// Proven here: exact row-1 / row-2 text (win% and record stay together as one
// "40% (2-3)" unit), row 2 omitted with no league history (never a fake
// "0% (0-0)"), the favorite/underdog side back in the category wording, the
// spelled-out streak row + its glyph + its hover tooltip, the below-2 cases
// (rows omitted, no fallback number), all four with/without-league ×
// with/without-streak combinations, and that the row-3 glyph still carries the
// pulse animation + reduced-motion classes from PR #34/#35.

import {
  gameCardRecordRows,
  gameCardRecordRowText,
  gameCardStreakGlyph,
  gameCardStreakRowText,
  gameCardStreakTooltip,
  GAME_CARD_NO_HISTORY_TEXT,
  GAME_CARD_STREAK_GLYPH_CLASS,
  type GameCardStreak,
} from "@/lib/game-card-record-line";
import { PICK_CATEGORY_MARKET_NOUN } from "@/server/data/stats";

const winStreak = (count: number): GameCardStreak => ({ type: "WIN", count });
const lossStreak = (count: number): GameCardStreak => ({ type: "LOSS", count });

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
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

const rowsFor = (
  overall: ReturnType<typeof col>,
  league: ReturnType<typeof col> | null,
  marketNoun = "underdog moneyline",
  leagueName = "NCAAF"
) =>
  gameCardRecordRows(
    { overall, league: league ?? col(0, 0) },
    { leagueName, marketNoun, hasLeagueHistory: league !== null }
  );

// The full rendered block as an array of lines, in DOM order.
const blockLines = (rows: ReturnType<typeof rowsFor>, streak?: GameCardStreak | null) => {
  const lines = rows.map(gameCardRecordRowText);
  const streakLine = gameCardStreakRowText(streak);
  if (streakLine) lines.push(streakLine);
  return lines;
};

// ---------------------------------------------------------------------------
console.log("########## row 1 / row 2 text - win% and record stay together ##########");
{
  const rows = rowsFor(col(2, 3), col(11, 9));
  check("two rows: overall then league", rows.map((r) => r.scope), [
    "overall on underdog moneyline picks",
    "in NCAAF",
  ]);
  check(
    "row 1: '<pct>% (<record>) overall on <side> <market> picks'",
    gameCardRecordRowText(rows[0]),
    "40% (2-3) overall on underdog moneyline picks"
  );
  check("row 2: '<pct>% (<record>) in <league>'", gameCardRecordRowText(rows[1]), "55% (11-9) in NCAAF");
  // The percentage is immediately followed by "(record)" - not separated by
  // the description the way the old inline sentence had it.
  checkTrue("row 1: pct and record are adjacent", /^40% \(2-3\) /.test(gameCardRecordRowText(rows[0])));
  checkTrue("row 2: pct and record are adjacent", /^55% \(11-9\) /.test(gameCardRecordRowText(rows[1])));
}
check(
  "pushes render inside the record (3-3-1 style)",
  gameCardRecordRowText(rowsFor(col(3, 3, 1), null, "total")[0]),
  "50% (3-3-1) overall on total picks"
);

// ---------------------------------------------------------------------------
console.log("\n########## row 2 omitted when the capper has no league history ##########");
{
  const rows = rowsFor(col(2, 3), null);
  check("only row 1 is produced", rows.map((r) => r.scope), ["overall on underdog moneyline picks"]);
  check("no fake '0% (0-0) in NCAAF' row", blockLines(rows), ["40% (2-3) overall on underdog moneyline picks"]);
}

// ---------------------------------------------------------------------------
console.log("\n########## favorite/underdog side is back in the category wording ##########");
{
  // The record IS side-specific, so the label has to name the side.
  check("FAV_ML", PICK_CATEGORY_MARKET_NOUN.FAV_ML, "favorite moneyline");
  check("DOG_ML", PICK_CATEGORY_MARKET_NOUN.DOG_ML, "underdog moneyline");
  check("SPREAD_MINUS", PICK_CATEGORY_MARKET_NOUN.SPREAD_MINUS, "favorite spread");
  check("SPREAD_PLUS", PICK_CATEGORY_MARKET_NOUN.SPREAD_PLUS, "underdog spread");
  check("F5_SPREAD_MINUS", PICK_CATEGORY_MARKET_NOUN.F5_SPREAD_MINUS, "first-5 favorite spread");
  check("F5_SPREAD_PLUS", PICK_CATEGORY_MARKET_NOUN.F5_SPREAD_PLUS, "first-5 underdog spread");
  checkTrue(
    "favorite vs underdog moneyline are different phrases",
    PICK_CATEGORY_MARKET_NOUN.FAV_ML !== PICK_CATEGORY_MARKET_NOUN.DOG_ML
  );
  // Markets with no favorite/underdog concept stay side-less.
  check("OVER stays 'total'", PICK_CATEGORY_MARKET_NOUN.OVER, "total");
  check("UNDER stays 'total'", PICK_CATEGORY_MARKET_NOUN.UNDER, "total");
  check("TEAM_TOTAL stays 'team total'", PICK_CATEGORY_MARKET_NOUN.TEAM_TOTAL, "team total");
  // Keys with no favorite/underdog split of their own get no side word.
  check("FIRST_HALF_ML (single key)", PICK_CATEGORY_MARKET_NOUN.FIRST_HALF_ML, "first-half moneyline");
  check("FIRST_HALF_SPREAD (single key)", PICK_CATEGORY_MARKET_NOUN.FIRST_HALF_SPREAD, "first-half spread");
  check("SPREAD fallback (side unknown)", PICK_CATEGORY_MARKET_NOUN.SPREAD, "spread");
  check("segment key: FIRST_QUARTER_ML", PICK_CATEGORY_MARKET_NOUN.FIRST_QUARTER_ML, "1st quarter moneyline");
  // A real row using a fetched noun.
  check(
    "row 1 for a FAV_ML pick reads 'favorite moneyline'",
    gameCardRecordRowText(rowsFor(col(9, 6), null, PICK_CATEGORY_MARKET_NOUN.FAV_ML)[0]),
    "60% (9-6) overall on favorite moneyline picks"
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## row 3 - spelled-out streak, only at 2+ ##########");
{
  check("2 win streak", gameCardStreakRowText(winStreak(2)), "🔥 2 game win streak");
  check("4 win streak", gameCardStreakRowText(winStreak(4)), "🔥 4 game win streak");
  check("5 loss streak", gameCardStreakRowText(lossStreak(5)), "🧊 5 game losing streak");
  check("12 win streak keeps the full count", gameCardStreakRowText(winStreak(12)), "🔥 12 game win streak");
  check("glyph alone: win", gameCardStreakGlyph(winStreak(3)), "🔥");
  check("glyph alone: loss", gameCardStreakGlyph(lossStreak(3)), "🧊");

  // Below 2 in either direction -> row is omitted entirely, no fallback.
  const below: (GameCardStreak | null | undefined)[] = [
    winStreak(1),
    lossStreak(1),
    { type: "NONE", count: 0 },
    null,
    undefined,
  ];
  for (const s of below) {
    check(`below 2 (${JSON.stringify(s)}): row text is empty`, gameCardStreakRowText(s), "");
    check(`below 2 (${JSON.stringify(s)}): glyph is empty`, gameCardStreakGlyph(s), "");
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## row 3 hover tooltip - preserved, count + direction ##########");
{
  for (const n of [2, 4, 7, 12]) {
    check(`win ${n} -> "Won ${n} in a row"`, gameCardStreakTooltip(winStreak(n)), `Won ${n} in a row`);
    check(`loss ${n} -> "Lost ${n} in a row"`, gameCardStreakTooltip(lossStreak(n)), `Lost ${n} in a row`);
  }
  check("below 2 -> no tooltip", gameCardStreakTooltip(winStreak(1)), "");
  check("null -> no tooltip", gameCardStreakTooltip(null), "");

  // Tooltip and the visible row always agree about whether they show, and the
  // count/direction line up.
  for (const s of [winStreak(2), winStreak(9), lossStreak(2), lossStreak(6)]) {
    const row = gameCardStreakRowText(s);
    const tip = gameCardStreakTooltip(s);
    checkTrue(`row "${row}" and tooltip "${tip}" both present`, row !== "" && tip !== "");
    checkTrue(`tooltip "${tip}" names the same count`, tip.includes(String(s.count)) && row.includes(String(s.count)));
    checkTrue(
      `tooltip "${tip}" and row "${row}" agree on direction`,
      s.type === "WIN"
        ? tip.startsWith("Won") && row.includes("win streak") && row.startsWith("🔥")
        : tip.startsWith("Lost") && row.includes("losing streak") && row.startsWith("🧊")
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n########## row 3 glyph keeps the PR #34/#35 pulse + reduced-motion classes ##########");
{
  const classes = GAME_CARD_STREAK_GLYPH_CLASS.split(/\s+/);
  checkTrue("glyph class carries the pulse animation", classes.includes("animate-streak-pulse"));
  checkTrue("glyph class carries the reduced-motion guard", classes.includes("motion-reduce:animate-none"));
  checkTrue(
    "glyph is inline-block so the pulse transform applies without shifting the text",
    classes.includes("inline-block")
  );
  check(
    "exact class string (shared with the component)",
    GAME_CARD_STREAK_GLYPH_CLASS,
    "inline-block animate-streak-pulse motion-reduce:animate-none"
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## the four combinations: {league history?} x {2+ streak?} ##########");
{
  const overall = col(2, 3);
  const league = col(11, 9);

  check("league history + streak -> 3 rows", blockLines(rowsFor(overall, league), winStreak(4)), [
    "40% (2-3) overall on underdog moneyline picks",
    "55% (11-9) in NCAAF",
    "🔥 4 game win streak",
  ]);
  check("league history, no streak -> 2 rows", blockLines(rowsFor(overall, league), winStreak(1)), [
    "40% (2-3) overall on underdog moneyline picks",
    "55% (11-9) in NCAAF",
  ]);
  check("no league history + streak -> 2 rows (row 2 dropped)", blockLines(rowsFor(overall, null), lossStreak(3)), [
    "40% (2-3) overall on underdog moneyline picks",
    "🧊 3 game losing streak",
  ]);
  check("no league history, no streak -> 1 row", blockLines(rowsFor(overall, null), null), [
    "40% (2-3) overall on underdog moneyline picks",
  ]);
}

// ---------------------------------------------------------------------------
console.log("\n########## no-category-history placeholder is unchanged ##########");
check("placeholder text", GAME_CARD_NO_HISTORY_TEXT, "No history in this category yet");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
