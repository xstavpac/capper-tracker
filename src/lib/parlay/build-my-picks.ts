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
  gameId?: string | null;
  // Set on a candidate the generator chose rather than the user (a game
  // item's or the qualified pool's picks - see slip-build.ts): it is only
  // taken while its game has no leg yet, the one-leg-per-game default.
  onePerGame?: boolean;
};

// A pick that lost a conflict (or duplicate) to a leg of this parlay. It is
// out of THIS parlay only - it stays a candidate everywhere else (another
// build, an alternate parlay), so nothing removes it from the pool.
// `won` says why the other pick kept its place: it ranks higher, or it is
// locked (a slip lock - see slip-build.ts), which beats any ranking.
export type SkippedPick = {
  pickId: string;
  label: string;
  reason: "conflict" | "duplicate";
  conflictsWith: { pickId: string; label: string };
  won: "HIGHER_RANKED" | "LOCKED";
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
    game: { homeTeam: c.homeTeam, awayTeam: c.awayTeam, gameTime: c.gameTime, sportName: c.sportName, gameId: c.gameId },
  };
}

// A pair blocks selection only for a real conflict (R2/R3 - can't both win)
// or an exact duplicate. Every other outcome, including UNDERIVABLE/
// UNCLASSIFIED, is non-blocking - see this file's own header for why.
export function blocks(a: BuildCandidate, b: BuildCandidate): { blocked: boolean; isDuplicate: boolean } {
  const outcome = classifyPair(toCandidate(a), toCandidate(b));
  if (outcome.outcome === "EXACT_DUPLICATE") return { blocked: true, isDuplicate: true };
  if (outcome.outcome === "RULE" && (outcome.rule === "R2" || outcome.rule === "R3")) {
    return { blocked: true, isDuplicate: false };
  }
  return { blocked: false, isDuplicate: false };
}

const WON_TEXT: Record<SkippedPick["won"], string> = { HIGHER_RANKED: "higher-ranked", LOCKED: "locked" };

function isUncertain(a: BuildCandidate, b: BuildCandidate): boolean {
  const outcome = classifyPair(toCandidate(a), toCandidate(b));
  return outcome.outcome === "UNDERIVABLE" || outcome.outcome === "UNCLASSIFIED";
}

// ranked: already ranked best-first (compareByRecord - the same win%-based
// ranking My Picks and Parlay A use) - this function never reorders it, it
// only decides which ranked picks make it into the final `legs`.
// `seed` is legs already decided (the slip's locked items, see slip-build.ts):
// they come first, count toward n, and every candidate is checked against them.
//
// Conflicting picks compete: walking best-first, a candidate that conflicts
// with a leg already taken lost to that leg - which is either locked (a seed)
// or ranks higher (it came earlier in the ranking). So of two conflicting
// picks the higher-ranked one is kept, unless the other is locked. The loser
// is skipped with a note naming the winner and why it won.
export function selectConflictFreeLegs(ranked: BuildCandidate[], n: number, seed: BuildCandidate[] = []): BuildResult {
  const legs: BuildCandidate[] = [...seed];
  const seedIds = new Set(seed.map((s) => s.pickId));
  const skipped: SkippedPick[] = [];
  const unverified: UnverifiedPair[] = [];

  for (const candidate of ranked) {
    if (legs.length >= n) break;
    // A generator-chosen pick on a game that already has a leg is not a
    // conflict - its game is simply spent - so it leaves no note.
    if (candidate.onePerGame && legs.some((l) => l.gameId === candidate.gameId)) continue;

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
      const won = seedIds.has(blockedBy.pickId) ? "LOCKED" : "HIGHER_RANKED";
      skipped.push({
        pickId: candidate.pickId,
        label: candidate.label,
        reason: blockedAsDuplicate ? "duplicate" : "conflict",
        conflictsWith: { pickId: blockedBy.pickId, label: blockedBy.label },
        won,
        note: `Skipped ${candidate.label} — ${blockedAsDuplicate ? "duplicate of" : "conflicts with"} ${blockedBy.label} (${WON_TEXT[won]})`,
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
