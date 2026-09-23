// Investigation-only GENERAL relationship classifier for the parlay-level
// coverage re-run (docs/parlay-white-paper.md). Replaces the six literal
// Section 4 rows with a dimension-based rule set (Family / Scope /
// Direction), so a market Section 4 never explicitly listed (e.g. a spread
// primary, a 2nd-half total, an NRFI primary) still gets classified instead
// of falling out as "no row for this". Lives ONLY in this harness - not the
// production classifier, nothing under src/ imports it.
//
// DIMENSIONS (derived only from existing pick/game data):
//   Family:    SIDE  (MONEYLINE, SPREAD)
//              TOTAL (TOTAL, TEAM_TOTAL, NRFI - NRFI=Under, YRFI=Over)
//              null  (PLAYER_PROP - still inactive; anything else unrecognized)
//   Scope:     period (raw Prisma Period value) + level (TOTAL family only:
//              GAME for TOTAL/NRFI, TEAM for TEAM_TOTAL; null for SIDE)
//   Direction: SIDE  -> the team name (pick-side.ts / pickTeamName)
//              TOTAL -> OVER or UNDER (totalDirection)
// If family or direction can't be derived, the pick is UNDERIVABLE and
// excluded - never inferred, never defaulted.
//
// RULES (primary vs candidate, same game only - order matters, first match wins):
//   exact duplicate: same family, same scope, same direction, same line -> excluded as a candidate (still counted in the 5(b) headcount by the caller)
//   R1: same scope, SIDE vs SIDE, same team               -> Correlated  (NEITHER)
//   R2: same scope, SIDE vs SIDE, opposing team            -> Opposing    (CONTRARIAN)
//   R3: same scope, TOTAL vs TOTAL, same total, opposite direction -> Opposing (CONTRARIAN)
//   R4: SIDE vs TOTAL, any scope                           -> Independent (AUTO_HEDGE) - the game-level-TOTAL half of this is the SAME_GAME toggle
//   R5: nested scope, same family, same direction           -> Independent (AUTO_HEDGE)
//   R6: nested scope, same family, opposite direction       -> Correlated-like (NEITHER)
//   anything else (same scope TOTAL vs TOTAL with different specific total,
//   or same direction/different line, etc.) -> UNCLASSIFIED
import { pickTeamName, totalDirection } from "./lib/pick-matching";
import { extractLine } from "@/lib/bet-line";

export function family(pick) {
  if (pick.betType === "MONEYLINE" || pick.betType === "SPREAD") return "SIDE";
  if (pick.betType === "TOTAL" || pick.betType === "TEAM_TOTAL" || pick.betType === "NRFI") return "TOTAL";
  return null;
}

// TEAM level for TEAM_TOTAL, GAME level for a real game-wide TOTAL, and a
// distinct FIRST_INNING level for NRFI/YRFI - NRFI carries period=FULL_GAME
// in the real data (confirmed against the snapshot: all 233 NRFI rows are
// period=FULL_GAME, same as the 905 full-game TOTAL rows), so without this
// third level NRFI would collide with a full-game TOTAL as "same scope" and
// wrongly resolve via R3 (same total, opposite direction) - NRFI is a
// narrower, genuinely different total (first-inning runs only), not "the
// same total" as the full-game combined score. Giving it its own level
// makes any NRFI/TOTAL pairing NESTED instead (R5/R6), which is the correct
// relationship (see the two added self-check cases).
function level(pick) {
  if (pick.betType === "TEAM_TOTAL") return "TEAM";
  if (pick.betType === "TOTAL") return "GAME";
  if (pick.betType === "NRFI") return "FIRST_INNING";
  return null;
}

// The real line to compare for the exact-duplicate check - prefers the
// stored Pick.line column, but falls back to re-parsing it from betDetail
// via bet-line.ts's own extractLine (the same function production parsing
// uses) when the column is null on a market that DOES have a real numeric
// line (SPREAD/TOTAL/TEAM_TOTAL - confirmed against the snapshot: 1.4% of
// SPREAD and 2.1% of TOTAL rows have a null line column despite the text
// carrying a real number). MONEYLINE (100% null - there is no line) and
// NRFI (100% null - a binary yes/no market) are never derived; null is
// their true, correct state, not a parsing gap.
function resolvedLine(pick) {
  if (pick.line !== null && pick.line !== undefined) return pick.line;
  if (pick.betType === "SPREAD" || pick.betType === "TOTAL" || pick.betType === "TEAM_TOTAL") {
    return extractLine(pick.betType, pick.betDetail ?? "");
  }
  return null;
}

// Describes one pick along all three dimensions, plus why it's UNDERIVABLE
// if it is. Called once per unique pick by the investigation script (cached
// per pick id) - never recomputed per candidate-pair, so every derivation
// stat this file's side effects feed (via pickTeamName's teamTotalMatchStats)
// is a per-pick rate, not inflated by how many simulated parlays reuse a pick.
export function describePick(pick, sportName) {
  const fam = family(pick);
  if (!fam) {
    return {
      family: null,
      underivableReason: pick.betType === "PLAYER_PROP" ? "PLAYER_PROP has no defined family (player props remain inactive)" : `unrecognized betType "${pick.betType}"`,
      betType: pick.betType,
      period: pick.period,
      lvl: null,
      direction: null,
      totalTargetTeam: null,
      line: resolvedLine(pick),
    };
  }
  let direction = null;
  let underivableReason = null;
  if (fam === "SIDE") {
    direction = pickTeamName(pick, sportName);
    if (!direction) underivableReason = "side/team unresolvable (pick-side.ts returned null - e.g. ATP or unmatched betDetail text)";
  } else {
    direction = totalDirection(pick);
    if (!direction) {
      underivableReason =
        pick.betType === "NRFI"
          ? "betDetail doesn't match NRFI/YRFI text patterns"
          : "betDetail has neither \"over\" nor \"under\" text";
    }
  }
  const lvl = level(pick);
  return {
    family: fam,
    underivableReason,
    betType: pick.betType,
    period: pick.period,
    lvl,
    direction,
    totalTargetTeam: lvl === "TEAM" ? pickTeamName(pick, sportName) : null,
    line: resolvedLine(pick),
  };
}

export function isUnderivable(desc) {
  return desc.family === null || desc.direction === null;
}

function scopeKey(d) {
  return d.family === "TOTAL" ? `${d.period}|${d.lvl}` : d.period;
}

function sameScope(a, b) {
  return scopeKey(a) === scopeKey(b);
}

function nestedScope(a, b) {
  return a.family === b.family && !sameScope(a, b);
}

// "The same total": trivially true for a game-level total (only one per
// game per scope) or an NRFI market; for a team-level total, requires the
// SAME specific team's total.
function sameTotalTarget(a, b) {
  return a.totalTargetTeam === b.totalTargetTeam;
}

export const RULE_DESCRIPTIONS = {
  R1: { category: "Correlated", bucket: "NEITHER", text: "Same scope, SIDE vs SIDE, same team (incl. alternate spread lines)" },
  R2: { category: "Opposing", bucket: "CONTRARIAN", text: "Same scope, SIDE vs SIDE, opposing team" },
  R3: { category: "Opposing", bucket: "CONTRARIAN", text: "Same scope, TOTAL vs the same total, opposite direction" },
  R4: { category: "Independent", bucket: "AUTO_HEDGE", text: "SIDE vs TOTAL, any scope" },
  R5: { category: "Independent", bucket: "AUTO_HEDGE", text: "Nested scope, same family, same direction" },
  R6: { category: "Neither", bucket: "NEITHER", text: "Nested scope, same family, opposite direction" },
};

/**
 * @param descA,descB  describePick() output for the two picks (order doesn't
 *   matter - every rule below is symmetric in A/B; the caller decides which
 *   one is "the primary" for headcount/qualification purposes downstream).
 * @param ctx { sameGameRowActive: boolean } - the SAME_GAME toggle now gates
 *   only the R4 sub-case where the TOTAL side is a GAME-level total (the
 *   direct generalization of the old Row 5 toggle); a TEAM-level total via
 *   R4 is unaffected, same as before.
 */
export function classifyGeneral(descA, descB, ctx) {
  if (isUnderivable(descA) || isUnderivable(descB)) {
    return { bucket: "UNDERIVABLE", rule: null };
  }

  const sameFamily = descA.family === descB.family;

  if (sameFamily && sameScope(descA, descB)) {
    // Exact duplicate requires the same betType too, not just family/scope/
    // direction/line - MONEYLINE (line always null) and a pick'em SPREAD
    // (also sometimes null) share the same team/scope/null-line shape but
    // are different markets and must never collide as "duplicates".
    const sameBetType = descA.betType === descB.betType;
    const sameLine = (descA.line ?? null) === (descB.line ?? null);
    const sameDirection = descA.direction === descB.direction;
    const exactDuplicate = sameBetType && sameDirection && sameLine;
    if (descA.family === "SIDE") {
      if (exactDuplicate) return { bucket: "UNCLASSIFIED", rule: null, reason: "exact duplicate" };
      if (sameDirection) return { bucket: "NEITHER", rule: "R1" };
      return { bucket: "CONTRARIAN", rule: "R2" };
    }
    // TOTAL vs TOTAL, same scope.
    if (!sameTotalTarget(descA, descB)) {
      return { bucket: "UNCLASSIFIED", rule: null, reason: "same scope, different specific total target (e.g. opposing team's team-total)" };
    }
    if (exactDuplicate) return { bucket: "UNCLASSIFIED", rule: null, reason: "exact duplicate" };
    if (sameDirection) return { bucket: "UNCLASSIFIED", rule: null, reason: "same total, same direction, different line - not covered" };
    return { bucket: "CONTRARIAN", rule: "R3" };
  }

  if (!sameFamily) {
    // R4: SIDE vs TOTAL, any scope - gated by the SAME_GAME toggle only for
    // the game-level-total half (the old Row 5 generalization).
    const totalDesc = descA.family === "TOTAL" ? descA : descB;
    if (totalDesc.lvl === "GAME" && !ctx.sameGameRowActive) {
      return { bucket: "UNCLASSIFIED", rule: null, reason: "R4 (game-level total) disabled for this run" };
    }
    return { bucket: "AUTO_HEDGE", rule: "R4" };
  }

  // Same family, nested scope (R5/R6).
  if (descA.direction === descB.direction) return { bucket: "AUTO_HEDGE", rule: "R5" };
  return { bucket: "NEITHER", rule: "R6" };
}

// ---------------------------------------------------------------------------
// SELF-CHECK: does the new general classifier reproduce the same outcome the
// old, literal Section 4 table documented for each of its six rows? Built
// from synthetic representative picks (not real DB data) - run once, at
// import time is too eager (side effects on teamTotalMatchStats), so the
// investigation script's orchestrator calls this explicitly before restoring
// any DB and prints the table for review.
export function runSelfCheck() {
  // Real MLB team names (must exist in parse-catalog's nickname tables for
  // pickTeamName to resolve them - placeholder names like "Home Team" don't
  // match anything and would wrongly show every case as UNDERIVABLE, which
  // is a fixture bug, not a classifier bug).
  const GAME = { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: new Date("2026-09-01T23:00:00Z") };
  const mk = (overrides) => ({ ...GAME, betDetail: null, line: null, period: "FULL_GAME", ...overrides });
  const sportName = "MLB";

  const cases = [
    {
      oldRow: 1,
      expectedBucket: "NEITHER",
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "SPREAD", betDetail: "Yankees -1.5", line: -1.5 }),
    },
    {
      oldRow: 2,
      expectedBucket: "AUTO_HEDGE",
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "MONEYLINE", betDetail: "Yankees F5 ML", period: "FIRST_HALF" }),
    },
    {
      oldRow: 3,
      expectedBucket: "AUTO_HEDGE",
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "TEAM_TOTAL", betDetail: "Yankees Over 4.5" }),
    },
    {
      oldRow: 4,
      expectedBucket: "CONTRARIAN",
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "MONEYLINE", betDetail: "Red Sox ML" }),
    },
    {
      oldRow: 5,
      expectedBucket: "AUTO_HEDGE",
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "TOTAL", betDetail: "Over 8.5" }),
    },
    {
      oldRow: 6,
      expectedBucket: "UNDERIVABLE", // inactive: player props have no family at all
      primary: mk({ betType: "MONEYLINE", betDetail: "Yankees ML" }),
      candidate: mk({ betType: "PLAYER_PROP", betDetail: "Player X Over 1.5 Total Bases" }),
    },
    {
      // New case (not one of the original six rows): NRFI carries
      // period=FULL_GAME in the real data, same as a full-game TOTAL - this
      // checks that NRFI's own FIRST_INNING level keeps it from colliding
      // with a full-game total as "same scope" (which would wrongly route
      // through R3 instead of the correct nested R5/R6).
      oldRow: "NRFI vs full-game Over",
      expectedBucket: "NEITHER", // NRFI=Under, nested vs full-game Over -> opposite direction -> R6
      primary: mk({ betType: "NRFI", betDetail: "Yankees NRFI" }),
      candidate: mk({ betType: "TOTAL", betDetail: "Over 8.5" }),
    },
    {
      oldRow: "NRFI vs full-game Under",
      expectedBucket: "AUTO_HEDGE", // NRFI=Under, nested vs full-game Under -> same direction -> R5
      primary: mk({ betType: "NRFI", betDetail: "Yankees NRFI" }),
      candidate: mk({ betType: "TOTAL", betDetail: "Under 8.5" }),
    },
  ];

  const results = cases.map((c) => {
    const dP = describePick(c.primary, sportName);
    const dC = describePick(c.candidate, sportName);
    const result = classifyGeneral(dP, dC, { sameGameRowActive: true });
    return {
      oldRow: c.oldRow,
      expectedBucket: c.expectedBucket,
      actualBucket: result.bucket,
      actualRule: result.rule,
      agrees: result.bucket === c.expectedBucket,
    };
  });
  return results;
}
