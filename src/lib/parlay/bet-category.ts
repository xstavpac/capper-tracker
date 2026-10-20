// The Parlay Generator's bet categories - Moneyline, Spread, Totals, Props -
// the one place a pick is put in one. "Include Picks" and the Pick Mix
// (include-picks.ts) both read betCategory; nothing else keeps a market list.
//
// Keyed on BetType, never on period or sport: a 1H / F5 / quarter / hockey-
// period pick is in its market's category. It agrees with the Relationship
// Classifier's families (relationship-classifier.ts, FAMILY_BY_BET_TYPE): its
// SIDE family is Moneyline + Spread, its TOTAL family is Totals, and the
// player props it leaves INACTIVE are Props.
//
//   MONEYLINE   -> MONEYLINE (1H / F5 / quarter MLs, NHL 3-way regulation ML
//                  including the Draw)
//   SPREAD      -> SPREAD (run lines, puck lines, 1H / F5 spreads, alternates)
//   TOTAL       -> TOTALS (full game, 1H / F5, quarters, periods)
//   TEAM_TOTAL  -> TOTALS (full game and 1H / F5 team totals)
//   NRFI        -> TOTALS (NRFI and YRFI, a first-inning total)
//   PLAYER_PROP -> PROPS (every PropMarket, and a prop whose market text is
//                  unreadable - it is still a prop)
//
// A bet type this map has never seen (one that crossed the wire before the map
// was updated) is UNCLASSIFIED: All Picks keeps it, no category does, and no
// Pick Mix share counts it. Outside production it is logged once, so the gap
// is found.
//
// Pure and client-safe: type-only imports.
import type { BetType } from "@prisma/client";

export type BetCategory = "MONEYLINE" | "SPREAD" | "TOTALS" | "PROPS";
export type BetCategoryResult = BetCategory | "UNCLASSIFIED";

// Display order everywhere (the chips, the Pick Mix rows, the notes).
export const BET_CATEGORIES: readonly BetCategory[] = ["MONEYLINE", "SPREAD", "TOTALS", "PROPS"];

export const BET_CATEGORY_LABELS: Record<BetCategory, string> = {
  MONEYLINE: "Moneyline",
  SPREAD: "Spread",
  TOTALS: "Totals",
  PROPS: "Props",
};

// `satisfies Record<BetType, ...>`: a new BetType fails the build here until
// someone decides which category it belongs in.
export const BET_CATEGORY_BY_BET_TYPE = {
  MONEYLINE: "MONEYLINE",
  SPREAD: "SPREAD",
  TOTAL: "TOTALS",
  TEAM_TOTAL: "TOTALS",
  NRFI: "TOTALS",
  PLAYER_PROP: "PROPS",
} as const satisfies Record<BetType, BetCategory>;

export type BetCategoryInput = { betType: string };

const reported = new Set<string>();

export function betCategory(pick: BetCategoryInput): BetCategoryResult {
  const mapped = (BET_CATEGORY_BY_BET_TYPE as Record<string, BetCategory>)[pick.betType];
  if (mapped) return mapped;
  if (process.env.NODE_ENV !== "production" && !reported.has(pick.betType)) {
    reported.add(pick.betType);
    console.warn(`[betCategory] unclassified bet type "${pick.betType}" - kept by All Picks only`);
  }
  return "UNCLASSIFIED";
}
