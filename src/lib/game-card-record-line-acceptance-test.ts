// The /live game-card capper record block - run with:
//   npx tsx src/lib/game-card-record-line-acceptance-test.ts
//
// It is a stack of rows now (not the old inline sentence + width guard):
//
//   Twins Moneyline
//   40% (2-3) overall on Underdog Moneyline Picks       <- Overall (category, all-time)
//   55% (11-9) in MLB Underdog Moneyline Picks          <- League (category+league; omitted
//                                                          with no league history / if == Overall)
//   67% (14-6) over the last 20 picks                   <- Last 20 (capper-wide: any type,
//                                                          any league; >= 20 graded total)
//   🔥 4 game win streak                                <- Streak (only if 2+)
//
// Proven here:
//  - Title Case on the market/category term ("Underdog Moneyline Picks", not
//    "underdog moneyline picks"), matching the capper's own pick-detail line
//    above the block; acronyms kept ("NRFI" stays "NRFI"); the league stays an
//    all-caps abbreviation ("in MLB ...").
//  - The League row names the market too ("in MLB Underdog Moneyline Picks"),
//    not just the bare league.
//  - Duplicate-row collapse: when Overall and League show the same record and
//    the same percentage the League row is dropped (NRFI, an MLB-only market),
//    and when they differ both rows show - a general value comparison, not a
//    hardcoded market list.
//  - The Last 20 row: capper-wide now (every category / league, not this
//    card's category) - it renders from `opts.last20` alone, so it appears
//    after the League row and before the streak row when populated, on its own
//    with no Overall/League card at all, is omitted (no partial "last N") when
//    `opts.last20` is null, and never alters the Overall/League rows.
//  - The spelled-out streak row + its glyph + its hover tooltip, the below-2
//    cases (row omitted, no fallback number), and the row-3 glyph still
//    carrying the pulse animation + reduced-motion classes from PR #34/#35.

import {
  gameCardRecordRows,
  gameCardRecordRowText,
  gameCardStreakGlyph,
  gameCardStreakRowText,
  gameCardStreakTooltip,
  GAME_CARD_NO_HISTORY_TEXT,
  GAME_CARD_STREAK_GLYPH_CLASS,
  GAME_CARD_LAST_N,
  type GameCardStreak,
} from "@/lib/game-card-record-line";
import { PICK_CATEGORY_MARKET_NOUN, type PickCategoryKey } from "@/server/data/stats";

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
  overall: ReturnType<typeof col> | null,
  league: ReturnType<typeof col> | null,
  marketNoun = "underdog moneyline",
  leagueName = "MLB",
  last20: ReturnType<typeof col> | null = null
) =>
  gameCardRecordRows(overall ? { overall, league: league ?? col(0, 0) } : null, {
    leagueName,
    marketNoun,
    hasLeagueHistory: league !== null,
    last20,
  });

// The full rendered block as an array of lines, in DOM order.
const blockLines = (rows: ReturnType<typeof rowsFor>, streak?: GameCardStreak | null) => {
  const lines = rows.map(gameCardRecordRowText);
  const streakLine = gameCardStreakRowText(streak);
  if (streakLine) lines.push(streakLine);
  return lines;
};

// ---------------------------------------------------------------------------
console.log("########## Overall / League row text - win% and record stay together ##########");
{
  const rows = rowsFor(col(2, 3), col(11, 9));
  check("two rows: overall then league", rows.map((r) => r.scope), [
    "overall on Underdog Moneyline Picks",
    "in MLB Underdog Moneyline Picks",
  ]);
  check(
    "Overall row: '<pct> (<record>) overall on <Side> <Market> Picks'",
    gameCardRecordRowText(rows[0]),
    "40% (2-3) overall on Underdog Moneyline Picks"
  );
  check(
    "League row: '<pct> (<record>) in <LEAGUE> <Side> <Market> Picks'",
    gameCardRecordRowText(rows[1]),
    "55% (11-9) in MLB Underdog Moneyline Picks"
  );
  checkTrue("Overall row: pct and record are adjacent", /^40% \(2-3\) /.test(gameCardRecordRowText(rows[0])));
  checkTrue("League row: pct and record are adjacent", /^55% \(11-9\) /.test(gameCardRecordRowText(rows[1])));
}
check(
  "pushes render inside the record (3-3-1 style)",
  gameCardRecordRowText(rowsFor(col(3, 3, 1), null, "under")[0]),
  "50% (3-3-1) overall on Under Picks"
);

// ---------------------------------------------------------------------------
console.log("\n########## FIX 1 - Title Case on the market/category term ##########");
{
  // The term after "overall on" / "in <LEAGUE>" is Title-cased, matching the
  // capper's own pick line ("Twins Moneyline"); sentence-case alone would do
  // nothing since the row starts with a digit.
  const scope = (noun: string) => rowsFor(col(5, 4), null, noun)[0].scope;
  check("multi-word market -> every word capped", scope("underdog moneyline"), "overall on Underdog Moneyline Picks");
  check("single word market", scope("under"), "overall on Under Picks");
  check("'picks' itself is capped too", scope("over").endsWith("Over Picks"), true);
  check("hyphen group cased part-by-part: first-5 over", scope("first-5 over"), "overall on First-5 Over Picks");
  check("hyphen group: first-half under", scope("first-half under"), "overall on First-Half Under Picks");
  check("leading digit left alone: 1st quarter over", scope("1st quarter over"), "overall on 1st Quarter Over Picks");
  check("2nd half spread", scope("2nd half spread"), "overall on 2nd Half Spread Picks");
  check("team total", scope("team total"), "overall on Team Total Picks");
  check("touchdown prop", scope("touchdown prop"), "overall on Touchdown Prop Picks");

  // Acronyms stay all-caps - never "Nrfi" / "Yrfi".
  check("NRFI stays NRFI", scope("NRFI"), "overall on NRFI Picks");
  check("YRFI stays YRFI", scope("YRFI"), "overall on YRFI Picks");
  checkTrue("no lowercased acronym anywhere", !/\bNrfi\b|\bYrfi\b/.test(scope("NRFI") + scope("YRFI")));

  // The league abbreviation stays an all-caps abbreviation regardless of the
  // casing it arrives in ("in mlb" -> "in MLB").
  check("league arg already upper -> unchanged", rowsFor(col(2, 1), col(2, 1), "over", "NCAAF")[0].scope, "overall on Over Picks");
  check(
    "league row uppercases the league ('in mlb' -> 'in MLB')",
    rowsFor(col(9, 6), col(3, 1), "underdog moneyline", "mlb")[1].scope,
    "in MLB Underdog Moneyline Picks"
  );

  // A real fetched noun end-to-end.
  check(
    "row for a FAV_ML pick reads 'Favorite Moneyline Picks'",
    gameCardRecordRowText(rowsFor(col(9, 6), null, PICK_CATEGORY_MARKET_NOUN.FAV_ML)[0]),
    "60% (9-6) overall on Favorite Moneyline Picks"
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## FIX 2 - the League row names the market, not just the league ##########");
{
  const rows = rowsFor(col(5, 10), col(2, 1), "underdog moneyline", "MLB");
  check("league row wording", gameCardRecordRowText(rows[1]), "67% (2-1) in MLB Underdog Moneyline Picks");
  checkTrue("league row is not the bare 'in MLB'", rows[1].scope !== "in MLB");
  checkTrue("league row still leads with 'in <LEAGUE>'", rows[1].scope.startsWith("in MLB "));
}

// ---------------------------------------------------------------------------
console.log("\n########## FIX 3 - collapse the League row when it equals Overall ##########");
{
  // Confirmed real case: Bambino's NRFI pick - every graded NRFI pick is in
  // MLB, so Overall and League are the exact same 26-18 / 59%. One row, not two.
  const nrfi = rowsFor(col(26, 18), col(26, 18), "NRFI", "MLB");
  check("NRFI: collapses to a single row", nrfi.map((r) => r.scope), ["overall on NRFI Picks"]);
  check(
    "NRFI: the surviving row is the Overall row",
    blockLines(nrfi),
    ["59% (26-18) overall on NRFI Picks"]
  );

  // Same record, same rounded percentage but different raw winPct still
  // collapses - the rule compares what the row DISPLAYS.
  const sameDisplay = rowsFor(
    { wins: 26, losses: 18, pushes: 0, winPct: 59.09 },
    { wins: 26, losses: 18, pushes: 0, winPct: 59.11 },
    "NRFI",
    "MLB"
  );
  check("identical displayed record+pct -> collapsed", sameDisplay.length, 1);

  // Different record -> both rows show.
  const differ = rowsFor(col(30, 20), col(8, 2), "underdog spread", "NCAAF");
  check("different records -> two rows", differ.map((r) => r.scope), [
    "overall on Underdog Spread Picks",
    "in NCAAF Underdog Spread Picks",
  ]);
  check("both rows show their own numbers", differ.map(gameCardRecordRowText), [
    "60% (30-20) overall on Underdog Spread Picks",
    "80% (8-2) in NCAAF Underdog Spread Picks",
  ]);

  // Both halves of the rule matter: same displayed pct but a different record
  // (a push shows on only one side) -> NOT collapsed, both rows show.
  const pushOnLeague = rowsFor(col(10, 10), col(10, 10, 4), "over", "MLB");
  checkTrue(
    "same pct but different record -> not collapsed",
    pushOnLeague.length === 2 &&
      pushOnLeague[0].pct === pushOnLeague[1].pct &&
      pushOnLeague[0].record !== pushOnLeague[1].record
  );

  // No league history at all -> League row omitted (unchanged behavior), never
  // a fake "0% (0-0)".
  check("no league history -> only the Overall row", rowsFor(col(2, 3), null).map((r) => r.scope), [
    "overall on Underdog Moneyline Picks",
  ]);
}

// ---------------------------------------------------------------------------
console.log("\n########## FIX 4 - the Last 20 row (now capper-wide) ##########");
{
  check("GAME_CARD_LAST_N mirrors the upstream window", GAME_CARD_LAST_N, 20);

  // Populated -> row shows, after League, before the streak.
  const withL20 = rowsFor(col(40, 30), col(12, 8), "over", "MLB", col(14, 6));
  check("row order: Overall -> League -> Last 20", withL20.map((r) => r.scope), [
    "overall on Over Picks",
    "in MLB Over Picks",
    "over the last 20 picks",
  ]);
  check(
    "Last 20 row text",
    gameCardRecordRowText(withL20[2]),
    "70% (14-6) over the last 20 picks"
  );
  check("full block: Overall -> League -> Last 20 -> Streak", blockLines(withL20, winStreak(3)), [
    "57% (40-30) overall on Over Picks",
    "60% (12-8) in MLB Over Picks",
    "70% (14-6) over the last 20 picks",
    "🔥 3 game win streak",
  ]);

  // Null (below the 20-graded threshold) -> row omitted entirely, no partial.
  const noL20 = rowsFor(col(8, 5), col(3, 2), "over", "MLB", null);
  check("last20 null -> no Last 20 row", noL20.map((r) => r.scope), [
    "overall on Over Picks",
    "in MLB Over Picks",
  ]);
  checkTrue("last20 null -> nothing mentions 'last 20'", !blockLines(noL20).some((l) => l.includes("last 20")));

  // Threshold boundary: exactly at 20 graded the row appears; the streak row
  // still follows it.
  const atThreshold = rowsFor(col(11, 9), null, "under", "MLB", col(11, 9));
  check("at threshold (20 graded): Last 20 present, then streak", blockLines(atThreshold, lossStreak(4)), [
    "55% (11-9) overall on Under Picks",
    "55% (11-9) over the last 20 picks",
    "🧊 4 game losing streak",
  ]);
  const belowThreshold = rowsFor(col(11, 8), null, "under", "MLB", null);
  check("below threshold (19 graded): no Last 20 row", blockLines(belowThreshold, lossStreak(4)), [
    "58% (11-8) overall on Under Picks",
    "🧊 4 game losing streak",
  ]);

  // Last 20 shows even with no league history (it is capper-wide, not scoped
  // to the card at all).
  const l20NoLeague = rowsFor(col(25, 15), null, "over", "MLB", col(13, 7));
  check("Last 20 with no league history", l20NoLeague.map((r) => r.scope), [
    "overall on Over Picks",
    "over the last 20 picks",
  ]);
}

// ---------------------------------------------------------------------------
console.log("\n########## Last 20 is capper-wide - detached from the category card ##########");
{
  // No Overall/League card at all (the capper has no graded pick in this
  // pick's category, or the pick has no category) - the Last 20 row still
  // appears on its own, from opts.last20 alone, once the capper has 20+ graded
  // picks overall.
  const only20 = gameCardRecordRows(null, {
    leagueName: "MLB",
    marketNoun: "",
    hasLeagueHistory: false,
    last20: col(13, 7),
  });
  check("no card + last20 -> just the Last 20 row", only20.map((r) => r.scope), ["over the last 20 picks"]);
  check("no card + last20 -> row text", only20.map(gameCardRecordRowText), ["65% (13-7) over the last 20 picks"]);
  check("no card + last20 -> row kind is last20", only20.map((r) => r.kind), ["last20"]);

  // No card and below the 20-graded threshold -> nothing at all.
  const nothing = gameCardRecordRows(null, {
    leagueName: "MLB",
    marketNoun: "",
    hasLeagueHistory: false,
    last20: null,
  });
  check("no card + no last20 -> no rows", nothing, []);

  // The Last 20 numbers are whatever the caller passes - they are NOT derived
  // from (and do NOT alter) the card's Overall / League columns, which stay
  // category + all-time as before.
  const cardVsL20 = rowsFor(col(2, 3), col(11, 9), "over", "MLB", col(18, 2));
  check(
    "row order unchanged: Overall -> League -> Last 20",
    cardVsL20.map((r) => r.kind),
    ["overall", "league", "last20"]
  );
  check("Last 20 is its own number, not Overall's", cardVsL20.find((r) => r.kind === "last20")?.record, "18-2");
  check("Overall row untouched by the Last 20 arg", cardVsL20.find((r) => r.kind === "overall")?.record, "2-3");
  check("League row untouched by the Last 20 arg", cardVsL20.find((r) => r.kind === "league")?.record, "11-9");

  // Below threshold, an existing category card is entirely unaffected.
  const cardNoL20 = rowsFor(col(2, 3), col(11, 9), "over", "MLB", null);
  check("card with last20 null: Overall + League only, no Last 20 row", cardNoL20.map((r) => r.kind), [
    "overall",
    "league",
  ]);
}

// ---------------------------------------------------------------------------
console.log("\n########## category wording names the exact side - no two opposite-side categories collapse ##########");
{
  const opposites: [PickCategoryKey, PickCategoryKey][] = [
    ["FAV_ML", "DOG_ML"],
    ["SPREAD_MINUS", "SPREAD_PLUS"],
    ["F5_SPREAD_MINUS", "F5_SPREAD_PLUS"],
    ["OVER", "UNDER"],
    ["FIRST_HALF_OVER", "FIRST_HALF_UNDER"],
    ["F5_OVER", "F5_UNDER"],
    ["NRFI", "YRFI"],
    ["FIRST_QUARTER_OVER", "FIRST_QUARTER_UNDER"],
    ["THIRD_PERIOD_OVER", "THIRD_PERIOD_UNDER"],
  ];
  for (const [a, b] of opposites) {
    checkTrue(
      `${a} vs ${b} read differently ("${PICK_CATEGORY_MARKET_NOUN[a]}" vs "${PICK_CATEGORY_MARKET_NOUN[b]}")`,
      PICK_CATEGORY_MARKET_NOUN[a] !== PICK_CATEGORY_MARKET_NOUN[b]
    );
  }
  check(
    "row for a YRFI pick reads 'overall on YRFI Picks'",
    gameCardRecordRowText(rowsFor(col(10, 13), null, PICK_CATEGORY_MARKET_NOUN.YRFI)[0]),
    "43% (10-13) overall on YRFI Picks"
  );
  check(
    "row for an NRFI pick reads 'overall on NRFI Picks'",
    gameCardRecordRowText(rowsFor(col(26, 18), null, PICK_CATEGORY_MARKET_NOUN.NRFI)[0]),
    "59% (26-18) overall on NRFI Picks"
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## streak row - spelled-out, only at 2+ ##########");
{
  check("2 win streak", gameCardStreakRowText(winStreak(2)), "🔥 2 game win streak");
  check("4 win streak", gameCardStreakRowText(winStreak(4)), "🔥 4 game win streak");
  check("5 loss streak", gameCardStreakRowText(lossStreak(5)), "🧊 5 game losing streak");
  check("12 win streak keeps the full count", gameCardStreakRowText(winStreak(12)), "🔥 12 game win streak");
  check("glyph alone: win", gameCardStreakGlyph(winStreak(3)), "🔥");
  check("glyph alone: loss", gameCardStreakGlyph(lossStreak(3)), "🧊");

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
console.log("\n########## streak row hover tooltip - preserved, count + direction ##########");
{
  for (const n of [2, 4, 7, 12]) {
    check(`win ${n} -> "Won ${n} in a row"`, gameCardStreakTooltip(winStreak(n)), `Won ${n} in a row`);
    check(`loss ${n} -> "Lost ${n} in a row"`, gameCardStreakTooltip(lossStreak(n)), `Lost ${n} in a row`);
  }
  check("below 2 -> no tooltip", gameCardStreakTooltip(winStreak(1)), "");
  check("null -> no tooltip", gameCardStreakTooltip(null), "");

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
console.log("\n########## streak glyph keeps the PR #34/#35 pulse + reduced-motion classes ##########");
{
  const classes = GAME_CARD_STREAK_GLYPH_CLASS.split(/\s+/);
  checkTrue("glyph class carries the pulse animation", classes.includes("animate-streak-pulse"));
  checkTrue("glyph class carries the reduced-motion guard", classes.includes("motion-reduce:animate-none"));
  checkTrue("glyph is inline-block so the pulse transform applies without shifting text", classes.includes("inline-block"));
  check(
    "exact class string (shared with the component)",
    GAME_CARD_STREAK_GLYPH_CLASS,
    "inline-block animate-streak-pulse motion-reduce:animate-none"
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## the combinations: {league history?} x {last 20?} x {2+ streak?} ##########");
{
  const overall = col(2, 3);
  const league = col(11, 9);

  check("league history + streak, no L20 -> 3 lines", blockLines(rowsFor(overall, league), winStreak(4)), [
    "40% (2-3) overall on Underdog Moneyline Picks",
    "55% (11-9) in MLB Underdog Moneyline Picks",
    "🔥 4 game win streak",
  ]);
  check("league history, no streak, no L20 -> 2 lines", blockLines(rowsFor(overall, league), winStreak(1)), [
    "40% (2-3) overall on Underdog Moneyline Picks",
    "55% (11-9) in MLB Underdog Moneyline Picks",
  ]);
  check("no league history + streak -> 2 lines (League row dropped)", blockLines(rowsFor(overall, null), lossStreak(3)), [
    "40% (2-3) overall on Underdog Moneyline Picks",
    "🧊 3 game losing streak",
  ]);
  check("no league history, no streak, no L20 -> 1 line", blockLines(rowsFor(overall, null), null), [
    "40% (2-3) overall on Underdog Moneyline Picks",
  ]);
  check(
    "everything on: Overall -> League -> Last 20 -> Streak",
    blockLines(rowsFor(col(40, 30), col(12, 8), "underdog moneyline", "MLB", col(15, 5)), winStreak(5)),
    [
      "57% (40-30) overall on Underdog Moneyline Picks",
      "60% (12-8) in MLB Underdog Moneyline Picks",
      "75% (15-5) over the last 20 picks",
      "🔥 5 game win streak",
    ]
  );
}

// ---------------------------------------------------------------------------
console.log("\n########## no-category-history placeholder is unchanged ##########");
check("placeholder text", GAME_CARD_NO_HISTORY_TEXT, "No history in this category yet");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
