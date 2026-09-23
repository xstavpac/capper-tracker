// Production Relationship Classifier (docs/parlay-white-paper.md, Section 4).
// Pure, dependency-free-of-Prisma logic that describes a single pick on three
// dimensions (family / scope / direction) and classifies a same-game pair of
// picks into one of six rules (R1-R6) or an explicit non-rule outcome.
//
// Scope note: this module is classification only. It has no opinion on the
// 55% qualification gate, Wilson scoring, ranking, substitution, or conflict
// validation beyond "same game" - those are separate pipeline stages
// (Sections 3, 5(b), 7, 9) that consume this module's output, not part of it.
//
// Behavioral reference during development: scripts/t2-harness/parlay-
// relationship-classifier.mjs and scripts/t2-harness/lib/pick-matching.ts
// (investigation-only - nothing here imports from scripts/).
import { derivePickTeamName } from "@/lib/pick-side";
import { extractLine, nrfiSide } from "@/lib/bet-line";
import { deriveTeamTotalTarget } from "@/lib/team-total-target";

export type Family = "SIDE" | "TOTAL";
export type Level = "GAME" | "TEAM" | "FIRST_INNING";
export type PickDescriptionStatus = "OK" | "INACTIVE" | "UNDERIVABLE";

export type PickInput = {
  betType: string;
  period: string;
  betDetail: string | null;
  line: number | null;
};

export type GameInput = {
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  sportName: string;
};

export type PickDescription = {
  status: PickDescriptionStatus;
  reason: string | null; // populated for INACTIVE/UNDERIVABLE, null for OK
  family: Family | null;
  period: string;
  level: Level | null; // TOTAL family only (GAME/TEAM/FIRST_INNING); null for SIDE
  direction: string | null; // team name for SIDE, "OVER"/"UNDER" for TOTAL
  line: number | null; // Pick.line, falling back to bet-line.ts's extractLine
  teamTarget: string | null; // TEAM_TOTAL only; the team the total is on
};

// Family mapping as a data table, per Section 4: a new market Section 4 adds
// is a table entry here, not a new branch. Absent from this table (and not
// PLAYER_PROP) means "unrecognized betType" -> UNDERIVABLE.
const FAMILY_BY_BET_TYPE: Record<string, Family> = {
  MONEYLINE: "SIDE",
  SPREAD: "SIDE",
  TOTAL: "TOTAL",
  TEAM_TOTAL: "TOTAL",
  NRFI: "TOTAL",
};

// Level mapping, TOTAL family only - SIDE picks have no level (null). NRFI
// carries Period=FULL_GAME in real data (see nrfiSide's own comment in
// bet-line.ts), so FIRST_INNING is what keeps an NRFI pick's scope distinct
// from a real full-game TOTAL at the same period.
const LEVEL_BY_BET_TYPE: Record<string, Level> = {
  TOTAL: "GAME",
  TEAM_TOTAL: "TEAM",
  NRFI: "FIRST_INNING",
};

// TOTAL/TEAM_TOTAL direction, read straight from betDetail text - same
// substring check the harness's overUnderSide used (not the o/u-shorthand
// pattern parsePlayerPropLine recognizes for player props elsewhere in this
// app; TOTAL/TEAM_TOTAL betDetail text in the real data is always spelled
// out "Over"/"Under").
function overUnderFromText(betDetail: string | null): "OVER" | "UNDER" | null {
  const text = (betDetail ?? "").toLowerCase();
  if (text.includes("over")) return "OVER";
  if (text.includes("under")) return "UNDER";
  return null;
}

function resolvedLine(pick: PickInput): number | null {
  if (pick.line !== null && pick.line !== undefined) return pick.line;
  if (pick.betType === "SPREAD" || pick.betType === "TOTAL" || pick.betType === "TEAM_TOTAL") {
    return extractLine(pick.betType, pick.betDetail ?? "");
  }
  return null;
}

// Describes one pick on the three Section 4 dimensions. Never guesses: any
// dimension that can't be derived from existing pick/game data makes the
// whole pick UNDERIVABLE (or INACTIVE for a known-but-unbuilt market), with a
// specific reason, rather than defaulting.
export function describePick(pick: PickInput, game: GameInput): PickDescription {
  const line = resolvedLine(pick);

  if (pick.betType === "PLAYER_PROP") {
    return {
      status: "INACTIVE",
      reason: "PLAYER_PROP has no defined family - player props are not yet classified",
      family: null,
      period: pick.period,
      level: null,
      direction: null,
      line,
      teamTarget: null,
    };
  }

  const family = FAMILY_BY_BET_TYPE[pick.betType];
  if (!family) {
    return {
      status: "UNDERIVABLE",
      reason: `unrecognized betType "${pick.betType}"`,
      family: null,
      period: pick.period,
      level: null,
      direction: null,
      line,
      teamTarget: null,
    };
  }

  const level = family === "TOTAL" ? LEVEL_BY_BET_TYPE[pick.betType] : null;

  // TEAM_TOTAL's team target, best-effort - not one of Section 4's three
  // derivability dimensions (family/scope/direction), so an unresolved
  // target (e.g. an alias not in parse-catalog's nickname tables) does NOT
  // make the whole pick UNDERIVABLE; direction (Over/Under) is derived
  // independently of it. teamTarget only feeds the narrower target-matching
  // checks classifyPair uses for TOTAL-vs-TOTAL same-scope pairs - an
  // unresolved target there is never guessed as a match.
  const teamTarget: string | null = pick.betType === "TEAM_TOTAL" ? deriveTeamTotalTarget(pick, game, game.sportName) : null;

  let direction: string | null;
  let reason: string | null = null;
  if (family === "SIDE") {
    direction = derivePickTeamName(pick, game, game.sportName);
    if (!direction) reason = "side/team unresolvable (e.g. ATP or unmatched betDetail text)";
  } else if (pick.betType === "NRFI") {
    const side = nrfiSide(pick.betDetail);
    direction = side === "YES_RUN" ? "OVER" : side === "NO_RUN" ? "UNDER" : null;
    if (!direction) reason = "betDetail doesn't match NRFI/YRFI text patterns";
  } else {
    direction = overUnderFromText(pick.betDetail);
    if (!direction) reason = 'betDetail has neither "over" nor "under" text';
  }

  if (!direction) {
    return { status: "UNDERIVABLE", reason, family, period: pick.period, level, direction: null, line, teamTarget };
  }

  return { status: "OK", reason: null, family, period: pick.period, level, direction, line, teamTarget };
}

export type Rule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type Category = "CORRELATED" | "INDEPENDENT" | "OPPOSING" | "EXCLUDED";
export type Mode = "NEITHER" | "AUTO_HEDGE" | "CONTRARIAN";

export const RULE_DESCRIPTIONS: Record<Rule, { category: Category; mode: Mode; text: string }> = {
  R1: { category: "CORRELATED", mode: "NEITHER", text: "Same scope, same family, same direction, different market or line" },
  R2: { category: "OPPOSING", mode: "CONTRARIAN", text: "Same scope, side vs side, opposing team" },
  R3: { category: "OPPOSING", mode: "CONTRARIAN", text: "Same scope, total vs the same total, opposite direction" },
  R4: { category: "INDEPENDENT", mode: "AUTO_HEDGE", text: "Side vs total, any scope" },
  R5: { category: "INDEPENDENT", mode: "AUTO_HEDGE", text: "Nested scope, same family, same direction" },
  R6: { category: "EXCLUDED", mode: "NEITHER", text: "Nested scope, same family, opposite direction" },
};

export type PairOutcome =
  | { outcome: "RULE"; rule: Rule; category: Category; mode: Mode }
  | { outcome: "NOT_SAME_GAME" }
  | { outcome: "EXACT_DUPLICATE" }
  | { outcome: "UNCLASSIFIED"; reason: string }
  | { outcome: "UNDERIVABLE"; reason: string }
  | { outcome: "INACTIVE" };

function ruleOutcome(rule: Rule): PairOutcome {
  const { category, mode } = RULE_DESCRIPTIONS[rule];
  return { outcome: "RULE", rule, category, mode };
}

export type ParlayCandidate = { pick: PickInput; game: GameInput };

function sameGame(a: GameInput, b: GameInput): boolean {
  return a.homeTeam === b.homeTeam && a.awayTeam === b.awayTeam && a.gameTime.getTime() === b.gameTime.getTime();
}

// scope = period alone for SIDE (no level); period + level for TOTAL.
function scopeKey(d: PickDescription): string {
  return d.family === "TOTAL" ? `${d.period}|${d.level}` : d.period;
}

function sameScope(a: PickDescription, b: PickDescription): boolean {
  return scopeKey(a) === scopeKey(b);
}

// Whether two TOTAL-family picks' teamTarget can be trusted to compare as
// equal for the EXACT_DUPLICATE check. Trivially true for a game-level total
// or NRFI/YRFI (only one per game per scope - level isn't "TEAM", teamTarget
// is null on both sides and irrelevant). For a team-level total, an
// unresolved target (null) on EITHER side must never be treated as equal to
// anything, including another null - two team totals whose team we couldn't
// resolve are NOT known to be the same bet just because both are unknown.
function teamTargetsMatchForDuplicate(a: PickDescription, b: PickDescription): boolean {
  if (a.level !== "TEAM") return true;
  return a.teamTarget !== null && a.teamTarget === b.teamTarget;
}

// Classifies a same-game pair of picks per Section 4's R1-R6 rule set.
// Symmetric: classifyPair(a, b) and classifyPair(b, a) give equivalent
// results, since every check below (family/scope/direction/line equality) is
// order-independent.
export function classifyPair(a: ParlayCandidate, b: ParlayCandidate): PairOutcome {
  if (!sameGame(a.game, b.game)) return { outcome: "NOT_SAME_GAME" };

  const descA = describePick(a.pick, a.game);
  const descB = describePick(b.pick, b.game);

  if (descA.status === "INACTIVE" || descB.status === "INACTIVE") return { outcome: "INACTIVE" };

  if (descA.status === "UNDERIVABLE" || descB.status === "UNDERIVABLE") {
    const reasons = [descA, descB]
      .filter((d) => d.status === "UNDERIVABLE")
      .map((d) => d.reason as string)
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .sort();
    return { outcome: "UNDERIVABLE", reason: reasons.join("; ") };
  }

  // Both derivable from here on.
  const sameFamily = descA.family === descB.family;
  const sameDirection = descA.direction === descB.direction;
  const sameLine = (descA.line ?? null) === (descB.line ?? null);
  const sameBetType = a.pick.betType === b.pick.betType;

  // teamTarget is null for every non-TEAM_TOTAL betType (both sides trivially
  // equal there), and required equal (and resolved) for TEAM_TOTAL -
  // otherwise "Yankees Over 4.5" and "Red Sox Over 4.5" (same line/direction,
  // different team) would wrongly register as duplicates, and two team
  // totals with an unresolved target would wrongly register as duplicates of
  // each other, instead of falling through to the UNCLASSIFIED checks below.
  if (sameBetType && descA.period === descB.period && sameDirection && sameLine && teamTargetsMatchForDuplicate(descA, descB)) {
    return { outcome: "EXACT_DUPLICATE" };
  }

  if (!sameFamily) {
    return ruleOutcome("R4");
  }

  if (sameScope(descA, descB)) {
    if (descA.family === "SIDE") {
      return sameDirection ? ruleOutcome("R1") : ruleOutcome("R2");
    }
    // TOTAL family, same scope. A team-level total's target must be
    // resolved on BOTH sides before comparing - null never equals null here
    // (two team totals we each couldn't identify are not known to be the
    // same bet), so that gets its own distinct reason from "resolved but
    // different teams".
    if (descA.level === "TEAM") {
      if (descA.teamTarget === null || descB.teamTarget === null) {
        return { outcome: "UNCLASSIFIED", reason: "team target unresolved" };
      }
      if (descA.teamTarget !== descB.teamTarget) {
        return { outcome: "UNCLASSIFIED", reason: "same scope, different total target (e.g. opposing team's team total)" };
      }
    }
    return sameDirection ? ruleOutcome("R1") : ruleOutcome("R3");
  }

  // Same family, nested scope (R5/R6).
  return sameDirection ? ruleOutcome("R5") : ruleOutcome("R6");
}
