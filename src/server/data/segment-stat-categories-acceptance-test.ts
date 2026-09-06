// Segment-scoped stat categories - run with:
//   npx tsx src/server/data/segment-stat-categories-acceptance-test.ts
//
// Follow-up to the quarter/period grading + duplicate-detection PRs. Before
// this, pickCategory only forked by period for FIRST_HALF; a Q1 / 2nd-half /
// hockey-period pick collapsed into the plain FAV_ML / OVER / UNDER category
// (and the plain MONEYLINE / TOTAL scorecard bucket) alongside full-game
// picks - so a capper's "92% on favorite moneyline picks" silently mixed
// full-game and quarter-scoped bets with a different risk profile.
//
// Proves:
//  - segment ML / TOTAL / SPREAD picks get their own <period>_<side>
//    category, one per Pick.period value (SECOND_HALF,
//    FIRST_QUARTER..FOURTH_QUARTER, FIRST_PERIOD..THIRD_PERIOD) - nothing
//    returns null
//  - non-MLB first-half SPREAD gets FIRST_HALF_SPREAD (was null before)
//  - full-game categories (FAV_ML, OVER, ...) and the scorecard's Moneyline /
//    Total buckets no longer count those picks
//  - a per-sport chip set (NBA_CHIP_SET etc.) excludes segment categories, so
//    the capper "Record by category" tiles stay full-game-only; ALL_CATEGORY_
//    KEYS includes them, so the /live game-card snippet shows a segment pick
//    its own record
//  - FIRST_HALF and F5 behavior is otherwise unchanged (MLB F5 spread still
//    splits favorite/underdog)

import {
  pickCategory,
  computeScorecard,
  computeCategoryBreakdown,
  computeSpecialistTag,
  chipSetForLeague,
  splitSegmentCategoryKey,
  ALL_CATEGORY_KEYS,
  SEGMENT_CATEGORY_KEYS,
  PICK_CATEGORY_LABELS,
} from "@/server/data/stats";
import { parseCatalog } from "@/lib/parse-catalog";
import type { Pick } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const cat = (over: {
  betType: Pick["betType"];
  period: Pick["period"];
  betDetail: string;
  sportName?: string;
  line?: number | null;
  pickedSide?: "HOME" | "AWAY" | null;
}) =>
  pickCategory({
    betType: over.betType,
    period: over.period,
    betDetail: over.betDetail,
    odds: -110,
    line: over.line ?? null,
    sportName: over.sportName ?? "NBA",
    pickedSide: over.pickedSide ?? null,
    mlFavoredSide: null,
  });

// ---------------------------------------------------------------------------
console.log("########## pickCategory: segment picks get their own category ##########");

check("full-game ML (fav) -> FAV_ML", cat({ betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Lakers ML", pickedSide: "HOME" }), "FAV_ML");
check("Q1 ML -> FIRST_QUARTER_ML", cat({ betType: "MONEYLINE", period: "FIRST_QUARTER", betDetail: "Lakers 1Q ML" }), "FIRST_QUARTER_ML");
check("Q2 ML -> SECOND_QUARTER_ML", cat({ betType: "MONEYLINE", period: "SECOND_QUARTER", betDetail: "Lakers Q2 ML" }), "SECOND_QUARTER_ML");
check("Q3 ML -> THIRD_QUARTER_ML", cat({ betType: "MONEYLINE", period: "THIRD_QUARTER", betDetail: "Lakers 3Q ML" }), "THIRD_QUARTER_ML");
check("Q4 ML -> FOURTH_QUARTER_ML", cat({ betType: "MONEYLINE", period: "FOURTH_QUARTER", betDetail: "Lakers 4Q ML" }), "FOURTH_QUARTER_ML");
check("2nd half ML -> SECOND_HALF_ML", cat({ betType: "MONEYLINE", period: "SECOND_HALF", betDetail: "Lakers 2H ML" }), "SECOND_HALF_ML");
check("NHL 1st period ML -> FIRST_PERIOD_ML", cat({ betType: "MONEYLINE", period: "FIRST_PERIOD", betDetail: "Rangers 1st period ML", sportName: "NHL" }), "FIRST_PERIOD_ML");
check("NHL 2nd period ML -> SECOND_PERIOD_ML", cat({ betType: "MONEYLINE", period: "SECOND_PERIOD", betDetail: "Rangers P2 ML", sportName: "NHL" }), "SECOND_PERIOD_ML");
check("NHL 3rd period ML -> THIRD_PERIOD_ML", cat({ betType: "MONEYLINE", period: "THIRD_PERIOD", betDetail: "Rangers 3rd period ML", sportName: "NHL" }), "THIRD_PERIOD_ML");

check("full-game over -> OVER", cat({ betType: "TOTAL", period: "FULL_GAME", betDetail: "over 220.5" }), "OVER");
check("Q1 over -> FIRST_QUARTER_OVER", cat({ betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "over 55.5 1Q" }), "FIRST_QUARTER_OVER");
check("Q1 under -> FIRST_QUARTER_UNDER", cat({ betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "under 55.5 1Q" }), "FIRST_QUARTER_UNDER");
check("2nd half under -> SECOND_HALF_UNDER", cat({ betType: "TOTAL", period: "SECOND_HALF", betDetail: "under 110.5 2H" }), "SECOND_HALF_UNDER");
check("NHL 1st period over -> FIRST_PERIOD_OVER", cat({ betType: "TOTAL", period: "FIRST_PERIOD", betDetail: "over 1.5 1st period", sportName: "NHL" }), "FIRST_PERIOD_OVER");

// SPREAD: a single <period>_SPREAD key (no favorite/underdog split), never
// null - the same "nothing falls through uncounted" fix as ML/TOTAL.
check("Q1 spread -> FIRST_QUARTER_SPREAD", cat({ betType: "SPREAD", period: "FIRST_QUARTER", betDetail: "Lakers 1Q -3.5", line: -3.5 }), "FIRST_QUARTER_SPREAD");
check("Q1 spread with no usable line -> still FIRST_QUARTER_SPREAD (never null)", cat({ betType: "SPREAD", period: "FIRST_QUARTER", betDetail: "Lakers 1Q spread", line: null }), "FIRST_QUARTER_SPREAD");
check("2nd half spread -> SECOND_HALF_SPREAD", cat({ betType: "SPREAD", period: "SECOND_HALF", betDetail: "Lakers 2H -6.5", line: -6.5 }), "SECOND_HALF_SPREAD");
check("NHL 3rd period spread -> THIRD_PERIOD_SPREAD", cat({ betType: "SPREAD", period: "THIRD_PERIOD", betDetail: "Rangers 3rd period -1.5", sportName: "NHL", line: -1.5 }), "THIRD_PERIOD_SPREAD");

// ---------------------------------------------------------------------------
console.log("\n########## FIRST_HALF / F5 unchanged ##########");
check("non-MLB 1H ML -> FIRST_HALF_ML (unchanged)", cat({ betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Lakers 1H ML" }), "FIRST_HALF_ML");
check("non-MLB 1H over -> FIRST_HALF_OVER (unchanged)", cat({ betType: "TOTAL", period: "FIRST_HALF", betDetail: "over 110.5 1H" }), "FIRST_HALF_OVER");
check("MLB F5 ML -> F5_ML (unchanged)", cat({ betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Yankees F5 ML", sportName: "MLB" }), "F5_ML");
check("MLB F5 over -> F5_OVER (unchanged)", cat({ betType: "TOTAL", period: "FIRST_HALF", betDetail: "F5 over 4.5", sportName: "MLB" }), "F5_OVER");
check("MLB F5 spread (fav) -> F5_SPREAD_MINUS (unchanged)", cat({ betType: "SPREAD", period: "FIRST_HALF", betDetail: "Yankees F5 -1.5", sportName: "MLB", line: -1.5 }), "F5_SPREAD_MINUS");
check("non-MLB 1H spread -> FIRST_HALF_SPREAD (gap CLOSED - was null)", cat({ betType: "SPREAD", period: "FIRST_HALF", betDetail: "Lakers 1H -3.5", line: -3.5 }), "FIRST_HALF_SPREAD");
check("non-MLB 1H spread with no line -> still FIRST_HALF_SPREAD (never null)", cat({ betType: "SPREAD", period: "FIRST_HALF", betDetail: "Lakers 1H spread", line: null }), "FIRST_HALF_SPREAD");
check("FIRST_HALF_SPREAD is in the NFL / NCAAF / NBA chip sets", ["NFL", "NCAAF", "NBA"].every((s) => chipSetForLeague(s).includes("FIRST_HALF_SPREAD")), true);

// ---------------------------------------------------------------------------
console.log("\n########## labels + key set ##########");
check("32 segment category keys (8 periods x ML/OVER/UNDER/SPREAD)", SEGMENT_CATEGORY_KEYS.length, 32);
check("FIRST_QUARTER_OVER chip label", PICK_CATEGORY_LABELS["FIRST_QUARTER_OVER"], "Q1 Over");
check("SECOND_HALF_ML chip label", PICK_CATEGORY_LABELS["SECOND_HALF_ML"], "2H ML");
check("THIRD_PERIOD_UNDER chip label", PICK_CATEGORY_LABELS["THIRD_PERIOD_UNDER"], "P3 Under");
check("FIRST_QUARTER_SPREAD chip label", PICK_CATEGORY_LABELS["FIRST_QUARTER_SPREAD"], "Q1 Spread");
check("segment keys are in ALL_CATEGORY_KEYS", SEGMENT_CATEGORY_KEYS.every((k) => ALL_CATEGORY_KEYS.includes(k)), true);
// splitSegmentCategoryKey must round-trip EVERY generated key (it's called at
// module-init in category-icons.tsx and per-pick in the game-card snippet - a
// null here is a hard crash, not a silent miss). Regression guard for the
// side-set drift that broke the SPREAD addition.
check(
  "splitSegmentCategoryKey round-trips all 32 segment keys, none null",
  SEGMENT_CATEGORY_KEYS.every((k) => {
    const s = splitSegmentCategoryKey(k);
    return s !== null && `${s.period}_${s.side}` === k;
  }),
  true
);
check("splitSegmentCategoryKey(non-segment key) -> null", splitSegmentCategoryKey("FAV_ML"), null);
check("splitSegmentCategoryKey(FIRST_HALF_SPREAD) -> null (base key, not a segment)", splitSegmentCategoryKey("FIRST_HALF_SPREAD"), null);
check("segment keys are NOT in any per-sport chip set", ["NBA", "NFL", "NCAAF", "MLB", "NHL", "WNBA"].some((s) => chipSetForLeague(s).some((k) => (SEGMENT_CATEGORY_KEYS as string[]).includes(k))), false);

// ---------------------------------------------------------------------------
console.log("\n########## the capping scenario: full-game + Q1 ML records are separated ##########");

let pid = 0;
const pick = (over: Partial<Pick> & { status: Pick["status"]; betType: Pick["betType"]; period: Pick["period"]; betDetail: string }): Pick & { sport: { name: string } } =>
  ({
    id: "p" + pid++,
    status: over.status,
    betType: over.betType,
    period: over.period,
    betDetail: over.betDetail,
    odds: -110,
    line: over.line ?? null,
    units: 1,
    gameTime: new Date("2026-01-0" + ((pid % 8) + 1) + "T20:00:00Z"),
    pickedSide: over.pickedSide ?? "HOME",
    mlFavoredSide: null,
    sport: { name: "NBA" },
  }) as unknown as Pick & { sport: { name: string } };

// 12-1 on full-game favorite ML, 1-3 on Q1 ML.
const capperPicks = [
  ...Array.from({ length: 12 }, () => pick({ status: "WIN", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Nuggets ML" })),
  pick({ status: "LOSS", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Nuggets ML" }),
  pick({ status: "WIN", betType: "MONEYLINE", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q ML" }),
  pick({ status: "LOSS", betType: "MONEYLINE", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q ML" }),
  pick({ status: "LOSS", betType: "MONEYLINE", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q ML" }),
  pick({ status: "LOSS", betType: "MONEYLINE", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q ML" }),
];

// (a) the game-card snippet path: ALL_CATEGORY_KEYS -> both records, separated.
const allBreakdown = computeCategoryBreakdown(capperPicks, ALL_CATEGORY_KEYS);
const favMl = allBreakdown.find((b) => b.key === "FAV_ML");
const q1Ml = allBreakdown.find((b) => b.key === "FIRST_QUARTER_ML");
check("FAV_ML record is the full-game picks only: 12-1", favMl && [favMl.wins, favMl.losses], [12, 1]);
check("FIRST_QUARTER_ML record is the Q1 picks only: 1-3", q1Ml && [q1Ml.wins, q1Ml.losses], [1, 3]);
check("FAV_ML win% is 92 (13-decided, 12 W) - NOT diluted by the 1-3 Q1 record", favMl && Math.round(favMl.winPct), 92);

// (b) the capper "Record by category" tiles path: chip set -> Q1 excluded.
const nbaBreakdown = computeCategoryBreakdown(capperPicks, chipSetForLeague("NBA"));
check("chip-set breakdown shows FAV_ML (12-1) and NOT FIRST_QUARTER_ML", nbaBreakdown.map((b) => b.key), ["FAV_ML"]);

// (c) the scorecard: Moneyline bucket is full-game only, SEGMENT bucket holds Q1.
const scorecard = computeScorecard(capperPicks as unknown as Pick[]);
const mlBucket = scorecard.find((b) => b.key === "MONEYLINE");
const segBucket = scorecard.find((b) => b.key === "SEGMENT");
check("scorecard Moneyline bucket: 12-1 (full-game only)", mlBucket && [mlBucket.wins, mlBucket.losses], [12, 1]);
check("scorecard SEGMENT bucket: 1-3 (the Q1 picks), labelled 'Quarter / period'", segBucket && [segBucket.wins, segBucket.losses, segBucket.label], [1, 3, "Quarter / period"]);

// (d) specialist tag: a Q1-overs-heavy capper is tagged for that segment, not "Overs specialist".
const q1OverHeavy = [
  ...Array.from({ length: 8 }, () => pick({ status: "WIN", betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "over 55.5 1Q" })),
  ...Array.from({ length: 2 }, () => pick({ status: "LOSS", betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "over 55.5 1Q" })),
  pick({ status: "LOSS", betType: "TOTAL", period: "FULL_GAME", betDetail: "over 220.5" }),
];
const tag = computeSpecialistTag(q1OverHeavy);
check("specialist tag is the 1st-quarter one, not a full-game 'Overs specialist'", tag && [tag.category, tag.label], ["FIRST_QUARTER_OVER", "1st quarter overs specialist"]);

// (e) SPREAD: full-game / Q1 / non-MLB-1H spread records are all separated,
// and nothing lands in null.
const spreadPicks = [
  pick({ status: "WIN", betType: "SPREAD", period: "FULL_GAME", betDetail: "Nuggets -3.5", line: -3.5 }),
  pick({ status: "LOSS", betType: "SPREAD", period: "FULL_GAME", betDetail: "Nuggets -3.5", line: -3.5 }),
  pick({ status: "WIN", betType: "SPREAD", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q -1.5", line: -1.5 }),
  pick({ status: "WIN", betType: "SPREAD", period: "FIRST_HALF", betDetail: "Nuggets 1H -2.5", line: -2.5 }),
];
const spreadBreakdown = computeCategoryBreakdown(spreadPicks, ALL_CATEGORY_KEYS);
check(
  "spread records split by scope: SPREAD_MINUS 1-1, FIRST_QUARTER_SPREAD 1-0, FIRST_HALF_SPREAD 1-0",
  spreadBreakdown.map((b) => [b.key, b.wins, b.losses]),
  [
    ["SPREAD_MINUS", 1, 1],
    ["FIRST_HALF_SPREAD", 1, 0],
    ["FIRST_QUARTER_SPREAD", 1, 0],
  ]
);
check(
  "every spread pick got a category - none dropped as null",
  spreadPicks.every((p) => pickCategory({ ...p, sportName: "NBA" }) !== null),
  true
);

// ---------------------------------------------------------------------------
console.log("\n########## audit follow-ups: nothing silently uncounted ##########");

// A1: TEAM_TOTAL used to fall through bucketKeyForPick to
// `pick.betType as ScorecardBucketKey` and vanish from computeScorecard.
{
  const picks = [
    pick({ status: "WIN", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Nuggets TT over 115.5" }),
    pick({ status: "WIN", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Nuggets TT over 115.5" }),
    pick({ status: "LOSS", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Nuggets TT over 115.5" }),
    pick({ status: "WIN", betType: "TOTAL", period: "FULL_GAME", betDetail: "over 230.5" }),
  ];
  const sc = computeScorecard(picks as unknown as Pick[]);
  check(
    "scorecard now has a Team Total bucket (2-1), separate from Total (1-0)",
    sc.map((b) => [b.key, b.wins, b.losses]),
    [
      ["TOTAL", 1, 0],
      ["TEAM_TOTAL", 2, 1],
    ]
  );
}
// A1: team total is period-independent in the scorecard, same as its category
// - a first-half / quarter team total goes to TEAM_TOTAL, not F5 / SEGMENT.
check(
  "1st-half team total -> TEAM_TOTAL bucket (not F5)",
  computeScorecard([pick({ status: "WIN", betType: "TEAM_TOTAL", period: "FIRST_HALF", betDetail: "Nuggets 1H TT over 58.5" })] as unknown as Pick[]).map((b) => b.key),
  ["TEAM_TOTAL"]
);
check(
  "Q1 team total -> TEAM_TOTAL bucket (not SEGMENT)",
  computeScorecard([pick({ status: "WIN", betType: "TEAM_TOTAL", period: "FIRST_QUARTER", betDetail: "Nuggets 1Q TT over 30.5" })] as unknown as Pick[]).map((b) => b.key),
  ["TEAM_TOTAL"]
);

// A3/A4: a spread pick whose side can't be read (pick'em line / no line) now
// gets the plain SPREAD category instead of null.
check("full-game pick'em spread (line 0) -> SPREAD, not null", cat({ betType: "SPREAD", period: "FULL_GAME", betDetail: "Nuggets pk", line: 0 }), "SPREAD");
check("full-game spread, no line, nothing parseable -> SPREAD, not null", cat({ betType: "SPREAD", period: "FULL_GAME", betDetail: "Nuggets spread", line: null }), "SPREAD");
check("MLB F5 spread, no readable side -> SPREAD, not null", cat({ betType: "SPREAD", period: "FIRST_HALF", betDetail: "Yankees F5 spread", sportName: "MLB", line: null }), "SPREAD");
check("a normal full-game spread is unchanged -> SPREAD_MINUS", cat({ betType: "SPREAD", period: "FULL_GAME", betDetail: "Nuggets -3.5", line: -3.5 }), "SPREAD_MINUS");
check("plain SPREAD is in ALL_CATEGORY_KEYS (game card can show it) but NOT in any chip set", ALL_CATEGORY_KEYS.includes("SPREAD") && !["NBA", "NFL", "MLB", "NCAAF"].some((s) => chipSetForLeague(s).includes("SPREAD")), true);

// A6: WNBA first-half is gradable, so WNBA gets a real chip set with the
// FIRST_HALF_* keys instead of falling back to DEFAULT_CHIP_SET.
check(
  "WNBA chip set now carries the first-half categories",
  ["FIRST_HALF_ML", "FIRST_HALF_OVER", "FIRST_HALF_UNDER", "FIRST_HALF_SPREAD"].every((k) => chipSetForLeague("WNBA").includes(k as never)),
  true
);
check(
  "WNBA 1H over pick lands in the WNBA chip-set breakdown (was excluded)",
  computeCategoryBreakdown(
    [pick({ status: "WIN", betType: "TOTAL", period: "FIRST_HALF", betDetail: "over 82.5 1H" })].map((p) => ({ ...p, sport: { name: "WNBA" } })) as unknown as (Pick & { sport: { name: string } })[],
    chipSetForLeague("WNBA")
  ).map((b) => b.key),
  ["FIRST_HALF_OVER"]
);

// A5: a stray zero-odds token in a pasted pick (e.g. "(0)") must not land in
// Pick.odds as 0 - that made favoriteOrUnderdog / pickCategory return null and
// the pick vanish from every category stat. parsePickText now ignores a
// parsed 0, so odds falls through to the -110 default (and, in bulk-picks,
// the real-market lookup), and the pick classifies normally.
for (const [label, text] of [
  ["(0)", "Cody\nLakers ML (0)"],
  ["(+0)", "Cody\nLakers ML (+0)"],
  ["(0) with a real unit tag", "Cody\nLakers ML (0) 2u"],
] as const) {
  const p = parseCatalog(text).picks[0];
  check(`stray zero-odds ${label} -> odds is the -110 default, not 0`, [p.odds, p.hasExplicitOdds], [-110, false]);
  check(
    `stray zero-odds ${label} -> pickCategory returns a real category, not null`,
    pickCategory({ betType: p.betType, period: "FULL_GAME", betDetail: p.description, odds: p.odds, line: null, sportName: "NBA", pickedSide: null, mlFavoredSide: null }),
    "FAV_ML",
  );
}
check("a real odds token still parses through unchanged", parseCatalog("Cody\nLakers ML (-150)").picks[0].odds, -150);
check("(0) doesn't eat the unit size", parseCatalog("Cody\nLakers ML (0) 2u").picks[0].units, 2);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
