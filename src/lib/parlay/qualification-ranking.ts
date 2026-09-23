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
import { classifyPair, describePick, type ParlayCandidate, type PickInput, type GameInput, type Rule } from "@/lib/parlay/relationship-classifier";
import { pickCategory, type CategoryBreakdownItem } from "@/server/data/stats";
import { categoryRecordKey } from "@/server/data/picks";
import type { BetType, Period } from "@prisma/client";

// One flat leg shape, reused for the primary, every candidate, and every
// same-game pick fed to the headcount check - mirrors build-my-picks.ts's
// BuildCandidate convention. betType/period stay plain strings (like
// relationship-classifier.ts's PickInput) so this module stays decoupled
// from Prisma's generated enum types the same way the classifier is; the one
// place that genuinely needs the stricter Prisma enum type is pickCategory
// (see toPickCategoryInput below), which gets a narrow, local cast.
export type ParlayLeg = {
  pickId: string;
  capperId: string;
  betType: string;
  period: string;
  betDetail: string | null;
  line: number | null;
  odds: number;
  datePosted: Date;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  sportName: string;
};

function toParlayCandidate(leg: ParlayLeg): ParlayCandidate {
  return {
    pick: { betType: leg.betType, period: leg.period, betDetail: leg.betDetail, line: leg.line },
    game: { homeTeam: leg.homeTeam, awayTeam: leg.awayTeam, gameTime: leg.gameTime, sportName: leg.sportName },
  };
}

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

// ---------------------------------------------------------------------------
// Section 7, Step 1: Wilson score interval lower bound.
//   p = wins/decided, n = decided (pushes excluded, same as computeStats).
//   LB = (p + z²/2n - z*sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)
// Only orders candidates that already passed the Section 3 gate below - it
// never decides eligibility and never substitutes for the gate.
// ---------------------------------------------------------------------------
export function wilsonLowerBound(wins: number, losses: number, z = 1.96): number {
  const decided = wins + losses;
  if (decided <= 0) return 0;
  const p = wins / decided;
  const n = decided;
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Section 3: the 55% market-specific qualification gate. Exactly the same
// boundary the Sharp Money tab applies (src/server/data/sharp-money.ts:
// `record.winPct < QUALIFYING_WIN_PCT` skips), so winPct === 55.0 passes.
// A gate, not a score - never blended with wilsonLowerBound above.
// ---------------------------------------------------------------------------
export function qualifies(record: CategoryBreakdownItem | null): boolean {
  return record !== null && record.winPct >= 55;
}

// ---------------------------------------------------------------------------
// Section 5(b): Contrarian headcount. Counts DISTINCT tracked cappers on the
// primary's own market+scope (same betType+period, and for TEAM_TOTAL the
// same total target), split by direction - team vs team for MONEYLINE/
// SPREAD, Over vs Under for TOTAL/TEAM_TOTAL, and NRFI vs YRFI (which is
// UNDER vs OVER in describePick's direction vocabulary). "Tracked as of that
// date" = datePosted no later than the primary's own gameTime - a same-day
// headcount, not a point-in-time win-rate lookup (that cutoff lives in the
// caller's win-rate data, not here). This cutoff applies uniformly,
// INCLUDING to the primary itself: a primary whose own datePosted lands
// after its game's gameTime (a real, fairly common pattern in imported
// data - a backfilled/corrected posting time) does not get an automatic
// pass for its own side, matching the spec's plain "posted before this game
// started" wording, which states no exemption for the primary. Callers
// should include the primary itself in `sameGamePicks` if they want it to
// have a chance to count - it's simply one more entry subject to the same
// filters as every other pick; this function also checks it directly, so
// including it twice is harmless (Set-deduped). Exact duplicates of the
// primary count toward its side the same way - same market/scope/direction,
// no special-casing needed. Primary's side must be STRICTLY larger than the
// opposing side; a tie (including 1-vs-1, or 0-vs-0) fails.
// ---------------------------------------------------------------------------
export function contrarianHeadcountPasses(primary: ParlayLeg, sameGamePicks: ParlayLeg[]): boolean {
  const primaryGame: GameInput = { homeTeam: primary.homeTeam, awayTeam: primary.awayTeam, gameTime: primary.gameTime, sportName: primary.sportName };
  const primaryDesc = describePick({ betType: primary.betType, period: primary.period, betDetail: primary.betDetail, line: primary.line }, primaryGame);
  if (primaryDesc.status !== "OK") return false;

  const oppositeDirection = primaryDesc.direction === "OVER" ? "UNDER" : primaryDesc.direction === "UNDER" ? "OVER" : null;
  // For SIDE family, direction IS the team name - the "opposing direction"
  // is simply whichever of the game's two teams isn't the primary's team.
  const oppositeSideDirection =
    primaryDesc.family === "SIDE"
      ? primaryDesc.direction === primary.homeTeam
        ? primary.awayTeam
        : primary.homeTeam
      : oppositeDirection;

  const primarySide = new Set<string>();
  const opposingSide = new Set<string>();

  // The primary itself goes through the exact same filter as every other
  // same-game pick - see the header comment above for why it gets no
  // exemption from its own datePosted check.
  for (const gp of [primary, ...sameGamePicks]) {
    if (gp.betType !== primary.betType || gp.period !== primary.period) continue;
    if (gp.datePosted.getTime() > primary.gameTime.getTime()) continue;

    const gpDesc = gp === primary ? primaryDesc : describePick({ betType: gp.betType, period: gp.period, betDetail: gp.betDetail, line: gp.line }, primaryGame);
    if (gpDesc.status !== "OK") continue;

    // TEAM_TOTAL: only the same team's total counts toward either side of
    // THIS primary's headcount - the opposing team's team total is a
    // different market entirely, not a vote on either side of this one.
    if (primary.betType === "TEAM_TOTAL" && gpDesc.teamTarget !== primaryDesc.teamTarget) continue;

    if (gpDesc.direction === primaryDesc.direction) primarySide.add(gp.capperId);
    else if (gpDesc.direction === oppositeSideDirection) opposingSide.add(gp.capperId);
  }

  return primarySide.size > opposingSide.size;
}

export type RankedCandidate = {
  leg: ParlayLeg;
  rule: Rule; // R2 | R3 (Contrarian) or R4 | R5 (Auto Hedge) - R1/R6 never reach here
  record: { wins: number; losses: number; n: number; winPct: number };
  wilsonLowerBound: number;
};

// ---------------------------------------------------------------------------
// Section 7, Steps 1-2: classify every candidate against the primary leg,
// keep only the ones matching `mode` (AUTO_HEDGE keeps R4/R5 -> INDEPENDENT;
// CONTRARIAN keeps R2/R3 -> OPPOSING, and only when the Section 5(b)
// headcount also passes for the primary), drop anything failing the Section
// 3 gate regardless of its Wilson score, then rank the survivors by Wilson
// lower bound descending. Deterministic tie-break: decided-n descending,
// then pick id ascending (string compare) - so equal scores never depend on
// input array order.
//
// `sameGamePicks` defaults to `candidates` (the common case: the candidate
// pool already covers every same-game pick worth considering), but a caller
// with a broader same-game pool for the headcount check specifically (e.g.
// picks that don't classify as valid CONTRARIAN candidates themselves but
// still count toward the majority/minority headcount) can pass it
// separately. The headcount is a property of the primary leg alone - it
// does not vary per candidate - so it's evaluated once, not per candidate.
//
// Section 9 (conflict validation against the OTHER legs already in the
// parlay) is out of scope here entirely - this only ranks candidates for
// ONE primary leg in isolation.
// ---------------------------------------------------------------------------
export function rankCandidates(
  primary: ParlayLeg,
  candidates: ParlayLeg[],
  mode: "AUTO_HEDGE" | "CONTRARIAN",
  records: Record<string, CategoryBreakdownItem | null>,
  sameGamePicks: ParlayLeg[] = candidates
): RankedCandidate[] {
  if (mode === "CONTRARIAN" && !contrarianHeadcountPasses(primary, sameGamePicks)) return [];

  const primaryCandidate = toParlayCandidate(primary);
  const scored: RankedCandidate[] = [];

  for (const candidate of candidates) {
    const outcome = classifyPair(primaryCandidate, toParlayCandidate(candidate));
    if (outcome.outcome !== "RULE" || outcome.mode !== mode) continue;

    const category = pickCategory(toPickCategoryInput(candidate));
    if (!category) continue;

    const record = records[categoryRecordKey(candidate.capperId, category)] ?? null;
    if (!qualifies(record)) continue;

    const { wins, losses, winPct } = record as CategoryBreakdownItem;
    scored.push({
      leg: candidate,
      rule: outcome.rule,
      record: { wins, losses, n: wins + losses, winPct },
      wilsonLowerBound: wilsonLowerBound(wins, losses),
    });
  }

  scored.sort((a, b) => {
    if (b.wilsonLowerBound !== a.wilsonLowerBound) return b.wilsonLowerBound - a.wilsonLowerBound;
    if (b.record.n !== a.record.n) return b.record.n - a.record.n;
    return a.leg.pickId < b.leg.pickId ? -1 : a.leg.pickId > b.leg.pickId ? 1 : 0;
  });

  return scored;
}
