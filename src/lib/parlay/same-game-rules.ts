// Which two picks on ONE game may sit in the same parlay - the rules
// Auto-Generate's same-game fill (auto-generate.ts, buildSameGameLegs) checks
// before it adds a second or third leg from a game. Pure.
//
// Nothing is classified here: every answer comes from the Relationship
// Classifier's own descriptions (describePick / classifyPair for sides and
// totals, describeProp for player props). This file is only the policy on top.
//
//   R-A  One side bet per game. Moneyline, spread, run line and puck line are
//        all SIDE family, so any two SIDE picks are blocked - whichever teams,
//        and whichever periods (Cubs F5 ML + Rays ML).
//   R-B  One game total per game, across periods too (F5 Over + full-game
//        Under, Over 8.5 + Over 9.5). A team total and NRFI/YRFI are not game
//        totals: a pair with one of those is blocked only when the classifier
//        calls it R3 or R6 (opposite directions), or an exact duplicate.
//   R-D  One prop per player per stat, either direction. Names are matched
//        loosely ("Williams" is "Caleb Williams") - unless both picks name
//        their team and the teams differ, which makes them two players.
//   R-E  One story per game: a game-total Under with no offensive prop Over,
//        a game-total Over with no offensive prop Under.
//   UNVERIFIED  A pick the classifier can't describe (a side with no readable
//        team, a prop with no readable player or line, a team total whose team
//        didn't resolve) is never paired with anything. Not guessed as safe.
//
// Every rule is symmetric: sameGameConflict(a, b) and sameGameConflict(b, a)
// block or allow the same pairs for the same rule.
import { derivePickSide } from "@/lib/pick-side";
import {
  classifyPair,
  describePick,
  describeProp,
  samePropPlayer,
  type ParlayCandidate,
  type PickDescription,
  type PropDescription,
} from "@/lib/parlay/relationship-classifier";

export type SameGameRule = "R-A" | "R-B" | "R-D" | "R-E" | "OPPOSING" | "DUPLICATE" | "UNVERIFIED";

export type SameGameConflict = { rule: SameGameRule; reason: string };

const conflict = (rule: SameGameRule, reason: string): SameGameConflict => ({ rule, reason });

const isGameTotal = (d: PickDescription) => d.family === "TOTAL" && d.level === "GAME";

type OkProp = Extract<PropDescription, { status: "OK" }>;

// Which of the game's two teams a prop's own text names ("Bears Caleb Williams
// over 250 passing yards"), or null when it names neither - the usual case. A
// prop has no stored side, and nothing here looks a player up on a roster. The
// text is read the way a moneyline's is, so the same team aliases apply.
function propTeam(c: ParlayCandidate): "HOME" | "AWAY" | null {
  return derivePickSide({ betType: "MONEYLINE", betDetail: c.pick.betDetail }, c.game, c.game.sportName);
}

// Two props on the same player: the names match (samePropPlayer - loosely, a
// last name alone is enough) and the teams don't say otherwise. Both teams
// known and different is two players, whatever the names. Either team unknown
// leaves the name match standing, which leans toward blocking.
function sameGamePlayer(a: ParlayCandidate, descA: OkProp, b: ParlayCandidate, descB: OkProp): boolean {
  if (!samePropPlayer(descA, descB)) return false;
  const teamA = propTeam(a);
  const teamB = propTeam(b);
  return teamA === null || teamB === null || teamA === teamB;
}

function propVsProp(a: ParlayCandidate, b: ParlayCandidate): SameGameConflict | null {
  const descA = describeProp(a.pick);
  const descB = describeProp(b.pick);
  if (descA.status !== "OK" || descB.status !== "OK") {
    const reasons = [descA, descB].flatMap((d) => (d.status === "OK" ? [] : [d.reason]));
    return conflict("UNVERIFIED", Array.from(new Set(reasons)).sort().join("; "));
  }
  if (descA.market === descB.market && sameGamePlayer(a, descA, b, descB)) return conflict("R-D", "same player and stat");
  return null;
}

function propVsOther(prop: PropDescription, other: PickDescription): SameGameConflict | null {
  if (prop.status !== "OK") return conflict("UNVERIFIED", prop.reason);
  if (other.status !== "OK") return conflict("UNVERIFIED", other.reason ?? "pick could not be described");
  if (isGameTotal(other) && storyClash(prop, other)) {
    return conflict("R-E", `game total ${other.direction === "UNDER" ? "Under" : "Over"} with an offensive prop ${prop.direction === "OVER" ? "Over" : "Under"}`);
  }
  return null;
}

function storyClash(prop: OkProp, total: PickDescription): boolean {
  return prop.offensive && prop.direction !== total.direction;
}

// null when the two picks may both be legs of one parlay. Both picks must be
// on the same game - the caller groups by the board's game id.
export function sameGameConflict(a: ParlayCandidate, b: ParlayCandidate): SameGameConflict | null {
  const aIsProp = a.pick.betType === "PLAYER_PROP";
  const bIsProp = b.pick.betType === "PLAYER_PROP";

  if (aIsProp && bIsProp) return propVsProp(a, b);
  if (aIsProp) return propVsOther(describeProp(a.pick), describePick(b.pick, b.game));
  if (bIsProp) return propVsOther(describeProp(b.pick), describePick(a.pick, a.game));

  const descA = describePick(a.pick, a.game);
  const descB = describePick(b.pick, b.game);
  if (descA.status !== "OK" || descB.status !== "OK") {
    const reasons = [descA, descB].flatMap((d) => (d.status === "OK" ? [] : [d.reason ?? "pick could not be described"]));
    return conflict("UNVERIFIED", Array.from(new Set(reasons)).sort().join("; "));
  }

  if (descA.family === "SIDE" && descB.family === "SIDE") return conflict("R-A", "two side bets on one game");
  if (isGameTotal(descA) && isGameTotal(descB)) return conflict("R-B", "two game totals on one game");

  const outcome = classifyPair(a, b);
  if (outcome.outcome === "EXACT_DUPLICATE") return conflict("DUPLICATE", "the same bet twice");
  if (outcome.outcome === "RULE" && (outcome.rule === "R3" || outcome.rule === "R6")) {
    return conflict("OPPOSING", `opposite directions (${outcome.rule})`);
  }
  if (outcome.outcome === "UNDERIVABLE") return conflict("UNVERIFIED", outcome.reason);
  if (outcome.outcome === "UNCLASSIFIED") {
    // Two team totals in one scope. On two different, resolved teams they are
    // separate markets (Cubs Over 4.5 + Rays Over 3.5). With either team
    // unresolved they may be the same market in opposite directions.
    const bothResolved = descA.teamTarget !== null && descB.teamTarget !== null && descA.teamTarget !== descB.teamTarget;
    return bothResolved ? null : conflict("UNVERIFIED", outcome.reason);
  }
  return null;
}
