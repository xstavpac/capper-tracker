// Harness-only helpers for the parlay-level coverage re-run. Two things live
// here that pick-side.ts deliberately doesn't do:
//   1. TEAM_TOTAL team-matching - classifyPickTeamGroup (pick-team-group.ts)
//      returns "OTHER" for TEAM_TOTAL by design (only MONEYLINE/SPREAD are
//      "team-tied" there). To test Section 4 Row 3 ("same team Over/Under")
//      we still need to know WHICH team a TEAM_TOTAL pick's total is for -
//      so this reuses the exact same already-validated nickname-matching
//      primitives classifyPickTeamGroup itself calls (teamGroupAliases /
//      teamPhraseRegex / normalizeForGrouping from parse-catalog.ts), just
//      without that function's betType gate. Not a new parsing heuristic.
//   2. A pragmatic "do these two legs conflict" / "are these two legs
//      Correlated" check for Section 9's constraint validation, applied when
//      testing whether a discovered candidate is still valid against the
//      OTHER (non-substituted) primary legs.
import { teamGroupAliases, teamPhraseRegex, normalizeForGrouping } from "@/lib/parse-catalog";
import { derivePickSide, derivePickTeamName, deriveOpposingTeamName } from "@/lib/pick-side";
import { nrfiSide } from "@/lib/bet-line";

export type MatchPick = {
  betType: string;
  period: string;
  betDetail: string | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
};

// Match/unmatched counters, exported so the investigation script can report
// TEAM_TOTAL match rates with examples, same spirit as pick-side.ts's own
// header comment documenting its match rate against the production snapshot.
export const teamTotalMatchStats = { matched: 0, unmatched: 0, examples: [] as string[] };

export function matchTeamTotalTeam(pick: MatchPick, sportName: string): "HOME" | "AWAY" | null {
  if (pick.betType !== "TEAM_TOTAL") return null;
  const text = normalizeForGrouping(pick.betDetail ?? "");
  const mentions = (aliases: string[]) => aliases.some((a) => teamPhraseRegex(a).test(text));
  let result: "HOME" | "AWAY" | null = null;
  if (mentions(teamGroupAliases(pick.awayTeam, sportName))) result = "AWAY";
  else if (mentions(teamGroupAliases(pick.homeTeam, sportName))) result = "HOME";

  if (result) teamTotalMatchStats.matched++;
  else {
    teamTotalMatchStats.unmatched++;
    if (teamTotalMatchStats.examples.length < 15) {
      teamTotalMatchStats.examples.push(
        `betDetail="${pick.betDetail}" home="${pick.homeTeam}" away="${pick.awayTeam}" sport=${sportName}`
      );
    }
  }
  return result;
}

// Team name a pick "belongs to", for same-team / opposing-team checks.
// MONEYLINE/SPREAD go through pick-side.ts (derivePickTeamName); TEAM_TOTAL
// goes through matchTeamTotalTeam above; everything else (TOTAL, NRFI,
// PLAYER_PROP without a resolvable team) has no team-scoping and returns
// null - a game total isn't "on" either team, and player props aren't
// resolved to a team by this harness at all (Section 4 treats PLAYER_TO_TEAM
// as inactive anyway).
export function pickTeamName(pick: MatchPick, sportName: string): string | null {
  if (pick.betType === "MONEYLINE" || pick.betType === "SPREAD") {
    return derivePickTeamName(pick, pick, sportName);
  }
  if (pick.betType === "TEAM_TOTAL") {
    const side = matchTeamTotalTeam(pick, sportName);
    return side === "HOME" ? pick.homeTeam : side === "AWAY" ? pick.awayTeam : null;
  }
  return null;
}

export function pickOpposingTeamName(pick: MatchPick, sportName: string): string | null {
  if (pick.betType === "MONEYLINE" || pick.betType === "SPREAD") {
    return deriveOpposingTeamName(pick, pick, sportName);
  }
  if (pick.betType === "TEAM_TOTAL") {
    const side = matchTeamTotalTeam(pick, sportName);
    return side === "HOME" ? pick.awayTeam : side === "AWAY" ? pick.homeTeam : null;
  }
  return null;
}

function overUnderSide(betDetail: string | null): "OVER" | "UNDER" | null {
  const t = (betDetail ?? "").toLowerCase();
  if (t.includes("over")) return "OVER";
  if (t.includes("under")) return "UNDER";
  return null;
}

// Direction for the general TOTAL family (docs/parlay-white-paper.md
// follow-up, "general rule set"): TOTAL/TEAM_TOTAL read Over/Under straight
// from betDetail text; NRFI/YRFI share one betType (see nrfiSide's own
// comment in bet-line.ts) and are mapped onto the same OVER/UNDER vocabulary
// per this investigation's own instruction (NRFI = Under, YRFI = Over) so
// every TOTAL-family comparison (R3/R5/R6) can use one direction check
// regardless of which specific market it is. Returns null (UNDERIVABLE) when
// the text doesn't resolve - never defaults silently, unlike pickCategory's
// own NRFI fallback (which defaults unresolved text to "NRFI"/Under; this
// harness's UNDERIVABLE accounting is deliberately stricter).
export function totalDirection(pick: MatchPick): "OVER" | "UNDER" | null {
  if (pick.betType === "TOTAL" || pick.betType === "TEAM_TOTAL") return overUnderSide(pick.betDetail);
  if (pick.betType === "NRFI") {
    const s = nrfiSide(pick.betDetail);
    return s === "YES_RUN" ? "OVER" : s === "NO_RUN" ? "UNDER" : null;
  }
  return null;
}

// Same game, i.e. same specific matchup, same instance of it - used both for
// "is this a same-game candidate at all" and for the conflict check below.
// Requires exact gameTime equality (not just same team pair) so a rematch -
// the same two teams playing again on a different night (common in an MLB
// series) - is never treated as "the same game".
export function sameGame(a: MatchPick, b: MatchPick): boolean {
  return a.homeTeam === b.homeTeam && a.awayTeam === b.awayTeam && a.gameTime.getTime() === b.gameTime.getTime();
}

// Pragmatic hard-conflict check for Section 9 ("no conflicting legs"): two
// legs that literally cannot both win. Scoped to what this investigation's
// six rows can actually produce as candidates (team ML/spread on either
// side, game totals, team totals) - not a general-purpose parlay validator.
export function picksConflict(a: MatchPick, b: MatchPick, sportName: string): boolean {
  if (!sameGame(a, b)) return false;

  const aTeamMarket = a.betType === "MONEYLINE" || a.betType === "SPREAD";
  const bTeamMarket = b.betType === "MONEYLINE" || b.betType === "SPREAD";
  if (aTeamMarket && bTeamMarket) {
    const aTeam = pickTeamName(a, sportName);
    const bTeam = pickTeamName(b, sportName);
    if (aTeam && bTeam && aTeam !== bTeam) return true; // opposite sides of the same game
  }

  if (a.betType === "TOTAL" && b.betType === "TOTAL" && a.period === b.period) {
    const aSide = overUnderSide(a.betDetail);
    const bSide = overUnderSide(b.betDetail);
    if (aSide && bSide && aSide !== bSide) return true; // Over 8.5 vs Under 8.5, same game+period
  }

  if (a.betType === "TEAM_TOTAL" && b.betType === "TEAM_TOTAL") {
    const aTeam = pickTeamName(a, sportName);
    const bTeam = pickTeamName(b, sportName);
    const aSide = overUnderSide(a.betDetail);
    const bSide = overUnderSide(b.betDetail);
    if (aTeam && bTeam && aTeam === bTeam && aSide && bSide && aSide !== bSide) return true;
  }

  return false;
}
