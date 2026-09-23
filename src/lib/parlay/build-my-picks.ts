// Section 9 conflict validation for Build My Picks (docs/parlay-white-paper.md
// Section 9 / Section 10's open item: "Add conflict validation to My Picks -
// Build My Picks takes the top N ranked picks with no conflict check").
//
// Pure selection logic: given a list of picks already ranked (best first,
// same ranking parlay-pool-section.tsx already computes) and a target leg
// count, walk the ranking in order and add each pick unless it conflicts
// with or duplicates a leg already selected. The ranking itself is never
// touched - only which ranked picks get selected changes. No UI, no DB.
//
// Reuses the Section 4 Relationship Classifier directly - no new
// conflict/duplicate rules are defined here:
//   - classifyPair rule R2 (same scope, opposing sides) or R3 (same total,
//     opposite direction) -> the two legs can't both win -> conflict, skip.
//   - EXACT_DUPLICATE -> a second capper on the identical pick adds nothing
//     -> skip as a duplicate.
//   - R1/R4/R5/R6/NOT_SAME_GAME -> never block (includes legs correlated by
//     the user's own choice - that's allowed, only literal conflicts and
//     duplicates are skipped).
//   - UNDERIVABLE or UNCLASSIFIED -> the classifier couldn't determine the
//     relationship (e.g. an ATP pick with no team concept, or a same-scope
//     team total whose team alias didn't resolve) - never guessed as safe
//     OR as a conflict. Both legs are included, and a note is attached
//     recording that this pair couldn't be verified.
import { classifyPair, type ParlayCandidate } from "@/lib/parlay/relationship-classifier";

export type BuildCandidate = {
  pickId: string;
  label: string; // human-readable identity for skip/uncertainty notes, e.g. "Capper One — Yankees ML"
  betType: string;
  period: string;
  betDetail: string | null;
  line: number | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  sportName: string;
};

export type SkippedPick = {
  pickId: string;
  label: string;
  reason: "conflict" | "duplicate";
  conflictsWith: { pickId: string; label: string };
  note: string;
};

export type UnverifiedPair = {
  pickId: string;
  label: string;
  withPickId: string;
  withLabel: string;
  note: string;
};

export type BuildResult = {
  legs: BuildCandidate[];
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number; // requested - legs.length, 0 when fully filled
};

function toCandidate(c: BuildCandidate): ParlayCandidate {
  return {
    pick: { betType: c.betType, period: c.period, betDetail: c.betDetail, line: c.line },
    game: { homeTeam: c.homeTeam, awayTeam: c.awayTeam, gameTime: c.gameTime, sportName: c.sportName },
  };
}

// A pair blocks selection only for a real conflict (R2/R3 - can't both win)
// or an exact duplicate. Every other outcome, including UNDERIVABLE/
// UNCLASSIFIED, is non-blocking - see this file's own header for why.
function blocks(a: BuildCandidate, b: BuildCandidate): { blocked: boolean; isDuplicate: boolean } {
  const outcome = classifyPair(toCandidate(a), toCandidate(b));
  if (outcome.outcome === "EXACT_DUPLICATE") return { blocked: true, isDuplicate: true };
  if (outcome.outcome === "RULE" && (outcome.rule === "R2" || outcome.rule === "R3")) {
    return { blocked: true, isDuplicate: false };
  }
  return { blocked: false, isDuplicate: false };
}

function isUncertain(a: BuildCandidate, b: BuildCandidate): boolean {
  const outcome = classifyPair(toCandidate(a), toCandidate(b));
  return outcome.outcome === "UNDERIVABLE" || outcome.outcome === "UNCLASSIFIED";
}

// ranked: already ranked best-first (same win%-based ranking
// parlay-pool-section.tsx computes today) - this function never reorders it,
// it only decides which ranked picks make it into the final `legs`.
export function selectConflictFreeLegs(ranked: BuildCandidate[], n: number): BuildResult {
  const legs: BuildCandidate[] = [];
  const skipped: SkippedPick[] = [];
  const unverified: UnverifiedPair[] = [];

  for (const candidate of ranked) {
    if (legs.length >= n) break;

    let blockedBy: BuildCandidate | null = null;
    let blockedAsDuplicate = false;
    const uncertainAgainst: BuildCandidate[] = [];

    for (const leg of legs) {
      const { blocked, isDuplicate } = blocks(candidate, leg);
      if (blocked) {
        blockedBy = leg;
        blockedAsDuplicate = isDuplicate;
        break;
      }
      if (isUncertain(candidate, leg)) uncertainAgainst.push(leg);
    }

    if (blockedBy) {
      skipped.push({
        pickId: candidate.pickId,
        label: candidate.label,
        reason: blockedAsDuplicate ? "duplicate" : "conflict",
        conflictsWith: { pickId: blockedBy.pickId, label: blockedBy.label },
        note: blockedAsDuplicate
          ? `Skipped ${candidate.label} — duplicate of ${blockedBy.label}`
          : `Skipped ${candidate.label} — conflicts with ${blockedBy.label} in your parlay`,
      });
      continue;
    }

    legs.push(candidate);
    for (const leg of uncertainAgainst) {
      unverified.push({
        pickId: candidate.pickId,
        label: candidate.label,
        withPickId: leg.pickId,
        withLabel: leg.label,
        note: `Couldn't verify ${candidate.label} and ${leg.label} don't conflict`,
      });
    }
  }

  return { legs, skipped, unverified, requested: n, shortfall: Math.max(0, n - legs.length) };
}
