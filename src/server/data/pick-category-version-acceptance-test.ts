// Pins pickCategory()'s outputs for a matrix of inputs, so the category that is
// STORED on every Pick (Pick.category, stamped at insert - see
// createPicksWithEntitlementCheck) can't silently go stale.
//
// If this test fails you changed what pickCategory returns for an existing
// input. Every already-stored category is now out of date for that input, so:
//   1. bump PICK_CATEGORY_VERSION in stats.ts,
//   2. re-run scripts/backfill-pick-category.ts to restamp existing picks (it
//      selects rows below the current version),
//   3. only then update the expected values below.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/pick-category-version-acceptance-test.ts
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

type Input = Parameters<typeof pickCategory>[0];
const base = {
  period: "FULL_GAME",
  betDetail: null,
  odds: -110,
  line: null,
  sportName: "MLB",
  pickedSide: null,
  mlFavoredSide: null,
  propMarket: null,
} as const;

const GOLDEN: [string, Partial<Input> & { betType: Input["betType"] }, string | null][] = [
  ["NRFI under", { betType: "NRFI", betDetail: "NRFI Under 0.5 1st inning" }, "NRFI"],
  ["NRFI yes-run", { betType: "NRFI", betDetail: "YRFI Over 0.5 1st inning" }, "YRFI"],
  ["ML fav by odds", { betType: "MONEYLINE", odds: -150 }, "FAV_ML"],
  ["ML dog by odds", { betType: "MONEYLINE", odds: 130 }, "DOG_ML"],
  ["ML both-negative, mlFavoredSide decides (home fav, picked away)", { betType: "MONEYLINE", odds: -104, pickedSide: "AWAY", mlFavoredSide: "HOME" }, "DOG_ML"],
  ["ML MLB first half", { betType: "MONEYLINE", period: "FIRST_HALF" }, "F5_ML"],
  ["ML NFL first half", { betType: "MONEYLINE", period: "FIRST_HALF", sportName: "NFL" }, "FIRST_HALF_ML"],
  ["ML NFL first quarter", { betType: "MONEYLINE", period: "FIRST_QUARTER", sportName: "NFL" }, "FIRST_QUARTER_ML"],
  ["ML NHL second period", { betType: "MONEYLINE", period: "SECOND_PERIOD", sportName: "NHL" }, "SECOND_PERIOD_ML"],
  ["SPREAD minus line", { betType: "SPREAD", line: -1.5 }, "SPREAD_MINUS"],
  ["SPREAD plus line", { betType: "SPREAD", line: 4.5, odds: -110 }, "SPREAD_PLUS"],
  ["SPREAD pickem line 0", { betType: "SPREAD", line: 0 }, "SPREAD"],
  ["SPREAD no line, negative odds", { betType: "SPREAD", line: null, odds: -120 }, "SPREAD"],
  ["SPREAD MLB first half minus", { betType: "SPREAD", period: "FIRST_HALF", line: -0.5 }, "F5_SPREAD_MINUS"],
  ["SPREAD MLB first half pickem", { betType: "SPREAD", period: "FIRST_HALF", line: 0 }, "SPREAD"],
  ["SPREAD NFL first half", { betType: "SPREAD", period: "FIRST_HALF", sportName: "NFL", line: -3 }, "FIRST_HALF_SPREAD"],
  ["SPREAD NBA third quarter", { betType: "SPREAD", period: "THIRD_QUARTER", sportName: "NBA", line: -2 }, "THIRD_QUARTER_SPREAD"],
  ["TEAM_TOTAL", { betType: "TEAM_TOTAL", betDetail: "Athletics over 4.5" }, "TEAM_TOTAL"],
  ["TEAM_TOTAL first half", { betType: "TEAM_TOTAL", period: "FIRST_HALF", betDetail: "over 2.5" }, "TEAM_TOTAL"],
  ["TOTAL over", { betType: "TOTAL", betDetail: "Over 8.5" }, "OVER"],
  ["TOTAL under", { betType: "TOTAL", betDetail: "under 44.5" }, "UNDER"],
  ["TOTAL no direction (null)", { betType: "TOTAL", betDetail: "8.5" }, null],
  ["TOTAL null detail (null)", { betType: "TOTAL", betDetail: null }, null],
  ["TOTAL MLB first half over", { betType: "TOTAL", period: "FIRST_HALF", betDetail: "F5 Over 4.5" }, "F5_OVER"],
  ["TOTAL MLB first half no direction (null)", { betType: "TOTAL", period: "FIRST_HALF", betDetail: "4.5" }, null],
  ["TOTAL NFL first half under", { betType: "TOTAL", period: "FIRST_HALF", sportName: "NFL", betDetail: "1H Under 21.5" }, "FIRST_HALF_UNDER"],
  ["TOTAL NBA second quarter over", { betType: "TOTAL", period: "SECOND_QUARTER", sportName: "NBA", betDetail: "Q2 Over 55.5" }, "SECOND_QUARTER_OVER"],
  ["TOTAL NBA second quarter no direction (null)", { betType: "TOTAL", period: "SECOND_QUARTER", sportName: "NBA", betDetail: "55.5" }, null],
  ["PLAYER_PROP propMarket set", { betType: "PLAYER_PROP", sportName: "NFL", propMarket: "REC_YDS", betDetail: "anything" }, "TD_PROP"],
  ["PLAYER_PROP legacy TD text", { betType: "PLAYER_PROP", sportName: "NFL", betDetail: "Puka Nacua Anytime TD" }, "TD_PROP"],
  ["PLAYER_PROP unparseable (null)", { betType: "PLAYER_PROP", sportName: "NFL", betDetail: "??" }, null],
];

// The expected values above were captured at this version.
expect("PICK_CATEGORY_VERSION matches the version the golden table was captured at", PICK_CATEGORY_VERSION, 1);
for (const [label, overrides, expected] of GOLDEN) {
  expect(`pickCategory: ${label}`, pickCategory({ ...base, ...overrides } as Input), expected);
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
