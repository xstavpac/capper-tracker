// Qualification and Ranking for the Parlay Generator (docs/parlay-white-paper.md,
// Sections 3, 5 and 7). Pure functions only - no DB access anywhere in this
// file. Building Parlays A/B/C, Section 9 conflict validation across a whole
// parlay, and the explanation layer are all OUT of scope here (see each
// function's own comment for exactly what it covers) - this module only
// answers, for one primary leg: which same-game candidates are eligible
// (Section 3's 55% gate, Section 5(b)'s Contrarian headcount), and how they
// rank against each other (Section 7 Step 1's Wilson lower bound).
//
// This module has NO user-scoping logic of its own. `candidates`, `records`
// and `sameGamePicks` must already be scoped to the requesting user's own
// tracked cappers by the caller (which has DB access) before being passed
// in - passing unscoped or cross-user data through is a caller bug, this
// module has no way to detect it.
//
// Everything except rankCandidates lives in qualification-core.ts, which is
// client-safe; this file only adds the pickCategory lookup (server/data/stats.ts
// imports prisma) and re-exports the rest, so every existing import still works.
import { pickCategory, type CategoryBreakdownItem } from "@/server/data/stats";
import type { BetType, Period } from "@prisma/client";
import { rankCandidatesBy, type ParlayLeg, type RankedCandidate } from "@/lib/parlay/qualification-core";

export * from "@/lib/parlay/qualification-core";

// pickCategory (src/server/data/stats.ts) types betType/period as Prisma's
// generated BetType/Period enums, not plain string - the one seam where this
// module's deliberately-Prisma-free leg shape has to bridge into a stricter
// caller. The cast is narrow (type-only, no runtime import of PrismaClient)
// and safe: every real ParlayLeg.betType/period value already came from one
// of those enums at the DB layer, this just re-asserts that at the boundary.
function toPickCategoryInput(leg: ParlayLeg) {
  return {
    betType: leg.betType as BetType,
    period: leg.period as Period,
    betDetail: leg.betDetail,
    odds: leg.odds,
    line: leg.line,
    sportName: leg.sportName,
  };
}

// rankCandidatesBy (qualification-core.ts) with each candidate's market read
// by pickCategory - see that function for the classification, gate, headcount
// and ordering.
export function rankCandidates(
  primary: ParlayLeg,
  candidates: ParlayLeg[],
  mode: "AUTO_HEDGE" | "CONTRARIAN",
  records: Record<string, CategoryBreakdownItem | null>,
  sameGamePicks: ParlayLeg[] = candidates
): RankedCandidate[] {
  return rankCandidatesBy(primary, candidates, mode, records, (leg) => pickCategory(toPickCategoryInput(leg)), sameGamePicks);
}
