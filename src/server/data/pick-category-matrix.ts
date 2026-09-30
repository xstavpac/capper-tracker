// The input space pickCategory() is pinned over, shared by the two tests that
// use it (pick-category-matrix-acceptance-test.ts and
// all-category-keys-acceptance-test.ts).
//
// Why this exists: Pick.category is STORED at insert (createPicksWithEntitlementCheck)
// and read back by SQL, so pickCategory()'s output for an existing input can
// never silently change - a change makes every stored value for that input
// stale. pick-category-version-acceptance-test.ts pins a hand-picked sample of
// inputs; this enumerates a much larger cross-product so a change to
// pickCategory OR to a helper it leans on (favoriteOrUnderdog, extractLine,
// nrfiSide, parsePlayerProp in lib/bet-line.ts) is caught for the whole matrix,
// not only for the sample someone thought of.
//
// Two kinds of group, per BetType (taken from the Prisma enum, so a NEW bet type,
// period, or prop market enters the matrix automatically and fails the pinned
// file until someone reviews it):
//   - "<BET_TYPE>/sweep":   EVERY input axis varied at once, each at low
//     cardinality. Catches pickCategory starting to read an axis it doesn't read
//     today (e.g. TOTAL beginning to look at `line`).
//   - "<BET_TYPE>/focused": the axes the code reads for that bet type today, at
//     high cardinality (every period x every sport x the realistic betDetail
//     texts ...).
// Loop order is fixed and the axes pickCategory ignores for a bet type vary
// FASTEST, so equal outputs come out in long runs (the pinned file is
// run-length encoded and stays small).
import { BetType, Period, PickedSide, PropMarket } from "@prisma/client";
import type { pickCategory } from "@/server/data/stats";

export type MatrixInput = Parameters<typeof pickCategory>[0];
export type MatrixCase = { group: string; input: MatrixInput };

const PERIODS = Object.values(Period);
const BET_TYPES = Object.values(BetType);
// NHL and MLB markets (added 2026-10) are deliberately not swept: pickCategory only tests
// propMarket for truthiness (-> TD_PROP), so they add no branch, and keeping the
// axis at the NFL values keeps the pinned golden table valid without a regen.
const NON_NFL_PROP_MARKETS = new Set<string>([
  "ANYTIME_GOAL", "FIRST_GOAL", "SHOTS_ON_GOAL", "POINTS", "ASSISTS", "SAVES",
  "STRIKEOUTS", "OUTS_RECORDED", "TOTAL_BASES", "HITS", "WALKS", "RUNS", "RBIS", "HOME_RUNS",
]);
const PROP_MARKETS: (PropMarket | null)[] = [null, ...Object.values(PropMarket).filter((m) => !NON_NFL_PROP_MARKETS.has(m))];
const SIDES: (PickedSide | null)[] = [null, ...Object.values(PickedSide)];

// Only MLB vs everyone else matters today (F5 vs first-half naming) - lower-case
// "mlb" pins that the comparison is case-insensitive.
const SPORTS_WIDE = ["MLB", "mlb", "NFL", "NBA", "NHL", "NCAAF", "NCAAB", "WNBA", "KBO", "CFL"];
const SPORTS_SWEEP = ["MLB", "NFL"];
const ODDS_WIDE = [-150, -110, 0, 130];
const ODDS_SWEEP = [-150, 0, 130];
const LINES_WIDE: (number | null)[] = [null, -1.5, 0, 3.5, -0.5];
const LINES_SWEEP: (number | null)[] = [null, -1.5, 3.5];
// (pickedSide, mlFavoredSide) pairs: neither known, both known agreeing, both known
// disagreeing, only one known - the four states favoriteOrUnderdog distinguishes.
const SIDE_PAIRS: [PickedSide | null, PickedSide | null][] = [
  [null, null],
  ["HOME", "HOME"],
  ["HOME", "AWAY"],
  ["AWAY", null],
];
const PROP_SWEEP: (PropMarket | null)[] = [null, "TD", "RUSH_YDS"];

const DETAILS_TOTAL: (string | null)[] = [
  null,
  "",
  "Over 8.5",
  "over 8.5",
  "OVER",
  "Under 44.5",
  "u 7",
  "o7",
  "8.5",
  "Over/Under 8.5",
  "Under and Over",
  "F5 Over 4.5",
  "Athletics over 4.5",
];
const DETAILS_NRFI: (string | null)[] = [
  null,
  "NRFI",
  "NRFI Under 0.5 1st inning",
  "YRFI",
  "YRFI Over 0.5 1st inning",
  "Over 0.5 1st inning",
  "Yes run first inning",
  "garbage",
];
const DETAILS_SPREAD: (string | null)[] = [null, "Bills -3", "Bills +2.5", "Bills pk", "Bills PK 0", "garbage"];
const DETAILS_PROP: (string | null)[] = [
  null,
  "",
  "Puka Nacua Anytime TD",
  "Josh Allen Over 275.5 Passing Yards",
  "Jaylen Waddle Over 60.5 Receiving Yards",
  "Josh Allen 275.5 pass yds",
  "Garbage text",
  "Bills ML",
];
const DETAILS_SWEEP: (string | null)[] = [null, "Over 8.5", "Bills -3", "Puka Nacua Anytime TD", "YRFI Over 0.5 1st inning"];
const DETAILS_MONEYLINE: (string | null)[] = [null, "Bills ML"];

function make(
  betType: BetType,
  o: Partial<Omit<MatrixInput, "betType">>
): MatrixInput {
  return {
    betType,
    period: "FULL_GAME",
    betDetail: null,
    odds: -110,
    line: null,
    sportName: "MLB",
    pickedSide: null,
    mlFavoredSide: null,
    propMarket: null,
    ...o,
  };
}

// Every input axis, varied at once, at low cardinality. Outermost -> innermost;
// the axes pickCategory ignores for most bet types (line, propMarket) are
// innermost so their runs are long.
function* sweep(betType: BetType): Generator<MatrixInput> {
  for (const period of PERIODS)
    for (const sportName of SPORTS_SWEEP)
      for (const betDetail of DETAILS_SWEEP)
        for (const odds of ODDS_SWEEP)
          for (const [pickedSide, mlFavoredSide] of SIDE_PAIRS)
            for (const line of LINES_SWEEP)
              for (const propMarket of PROP_SWEEP) {
                yield make(betType, { period, sportName, betDetail, odds, line, pickedSide, mlFavoredSide, propMarket });
              }
}

function* focusedMoneyline(): Generator<MatrixInput> {
  for (const period of PERIODS)
    for (const sportName of SPORTS_WIDE)
      for (const odds of ODDS_WIDE)
        for (const pickedSide of SIDES)
          for (const mlFavoredSide of SIDES)
            for (const betDetail of DETAILS_MONEYLINE) {
              yield make("MONEYLINE", { period, sportName, odds, pickedSide, mlFavoredSide, betDetail });
            }
}

function* focusedSpread(): Generator<MatrixInput> {
  for (const period of PERIODS)
    for (const sportName of SPORTS_WIDE)
      for (const odds of ODDS_WIDE)
        for (const line of LINES_WIDE)
          for (const betDetail of DETAILS_SPREAD) {
            yield make("SPREAD", { period, sportName, odds, line, betDetail });
          }
}

function* focusedTotal(betType: "TOTAL" | "TEAM_TOTAL"): Generator<MatrixInput> {
  for (const period of PERIODS)
    for (const sportName of SPORTS_WIDE)
      for (const betDetail of DETAILS_TOTAL) {
        yield make(betType, { period, sportName, betDetail });
      }
}

function* focusedNrfi(): Generator<MatrixInput> {
  for (const sportName of ["MLB", "NFL"])
    for (const period of ["FULL_GAME", "FIRST_HALF"] as const)
      for (const betDetail of DETAILS_NRFI) {
        yield make("NRFI", { sportName, period, betDetail });
      }
}

function* focusedProp(): Generator<MatrixInput> {
  for (const sportName of ["NFL", "MLB"])
    for (const period of ["FULL_GAME", "FIRST_HALF"] as const)
      for (const propMarket of PROP_MARKETS)
        for (const betDetail of DETAILS_PROP) {
          yield make("PLAYER_PROP", { sportName, period, propMarket, betDetail });
        }
}

// Bet types with a hand-written focused group above. A bet type NOT listed here
// still gets its "/sweep" group (every axis), so a new BetType enum value is
// pinned from the day it exists.
const FOCUSED: Partial<Record<BetType, () => Generator<MatrixInput>>> = {
  MONEYLINE: focusedMoneyline,
  SPREAD: focusedSpread,
  TOTAL: () => focusedTotal("TOTAL"),
  TEAM_TOTAL: () => focusedTotal("TEAM_TOTAL"),
  NRFI: focusedNrfi,
  PLAYER_PROP: focusedProp,
};

// Group names in a fixed order: every bet type's sweep, then its focused group.
export function matrixGroupNames(): string[] {
  const names: string[] = [];
  for (const bt of BET_TYPES) {
    names.push(`${bt}/sweep`);
    if (FOCUSED[bt]) names.push(`${bt}/focused`);
  }
  return names;
}

export function* enumerateGroup(name: string): Generator<MatrixInput> {
  const [bt, kind] = name.split("/") as [BetType, "sweep" | "focused"];
  if (kind === "sweep") yield* sweep(bt);
  else yield* FOCUSED[bt]!();
}

export function* enumerateMatrix(): Generator<MatrixCase> {
  for (const group of matrixGroupNames()) {
    for (const input of enumerateGroup(group)) yield { group, input };
  }
}
