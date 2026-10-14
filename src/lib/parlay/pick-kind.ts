// The one place a pick is labeled a game line or a player prop. Auto-Generate's
// "Include Picks" filter and its Pick Mix both read classifyPickKind - nothing
// else in the Parlay Generator keeps its own list of markets.
//
// Keyed on BetType, not pickCategory: pickCategory returns null for a prop
// whose text names no market it can read, and that pick is still a prop.
//
//   PLAYER_PROP                         -> PROP (every PropMarket: yardage, anytime
//                                          TD, NHL goals, MLB hits, NBA double-double ...)
//   SPREAD, MONEYLINE, TOTAL            -> GAME_LINE, whatever the period (1H/F5,
//                                          quarters, hockey periods, regulation)
//                                          and whatever the line (alternate lines
//                                          are stored as plain SPREAD/TOTAL)
//   TEAM_TOTAL                          -> GAME_LINE (no player; the same-game rules
//                                          already treat it as a total)
//   NRFI (NRFI and YRFI)                -> GAME_LINE (a game-level first-inning market)
//
// Pure and client-safe: type-only imports.
import type { BetType } from "@prisma/client";

export type PickKind = "GAME_LINE" | "PROP";

// `satisfies Record<BetType, ...>`: a new BetType fails the build here until
// someone decides which bucket it belongs in.
export const PICK_KIND_BY_BET_TYPE = {
  SPREAD: "GAME_LINE",
  MONEYLINE: "GAME_LINE",
  TOTAL: "GAME_LINE",
  TEAM_TOTAL: "GAME_LINE",
  NRFI: "GAME_LINE",
  PLAYER_PROP: "PROP",
} as const satisfies Record<BetType, PickKind>;

export type PickKindInput = {
  betType: string;
  // Set only on player props (Pick.propMarket). Optional because pooled picks
  // saved before the field was passed through won't carry it.
  propMarket?: string | null;
};

export function classifyPickKind(pick: PickKindInput): PickKind {
  const mapped = (PICK_KIND_BY_BET_TYPE as Record<string, PickKind>)[pick.betType];
  if (mapped) return mapped;
  // A bet type this map has never seen (a pick that crossed the wire before
  // the map was updated): a player attached makes it a prop.
  return pick.propMarket ? "PROP" : "GAME_LINE";
}
