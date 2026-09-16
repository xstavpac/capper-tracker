// Conservative last-resort resolver for a bare player-prop line with no team
// prefix ("Patrick Mahomes Over 225 Passing Yards" - no "Chiefs") - the
// player-name analog of live-team-fallback.ts's team-name resolution, same
// split: this file is pure/sync (no fetch, no prisma - safe to unit test
// with a fixture-built roster and no network); the roster it matches against
// comes from server/data/nfl-roster-cache.ts's getCachedNflRoster (a cached
// table read, not a live fetch), passed in once by the caller
// (recover-unresolved-picks.ts), same "fetch once, resolve many lines
// against it" shape as gatherLiveTeamNames / resolveLineAgainstLiveTeams.
//
// Conservative by construction, same policy as resolveLineAgainstLiveTeams:
//   - resolves only when EXACTLY ONE distinct player (by espnPlayerId)
//     matches. An exact (normalized) full-name match is always preferred;
//     the fuzzy matcher (isLikelyDuplicateName, already used by grading.ts
//     for box-score names) is tried next, ONLY when no exact match exists at
//     all; a bare-surname match (see below) is tried last, ONLY when the
//     typed text is a single word - each tier only counts as resolved if it
//     narrows to exactly one distinct player.
//   - two or more distinct players matching at any tier - a genuine
//     same-name (or same-surname) collision across teams, or a fuzzy match
//     too loose to trust - reports `ambiguous`, which the caller treats
//     exactly the same as unresolved. This mirrors
//     recoverUnresolvedPicksAction's own existing policy for team-name
//     collisions ("a collision is exactly the case where we must NOT
//     guess") - never guessed here either, and a single typed token is
//     never treated as "close enough" on its own merit: it still has to
//     land on exactly one roster player (optionally narrowed by
//     `relevantTeams`, see below) or it stays ambiguous/unresolved.
//   - this is only ever invoked for a line parsePlayerProp already
//     recognizes as one of the app's supported player-prop markets
//     (passing/rushing/receiving yards, receptions, TD) - a line with none
//     of those shapes returns `unresolved` immediately, without ever
//     touching the roster.
//
// Bare-surname tier (2026-09, the "Gibbs over 65.5 rushing yards" case): a
// capper often types just a last name, with no first name and no team.
// Tried only when the typed name has no space - a multi-word name that
// already failed exact + fuzzy matching is a real miss (wrong spelling, not
// on this roster, etc.), not a surname to go re-guess from. Matched against
// RosterPlayer.lastName (normalized), which is only meaningful because
// nfl-roster.ts's extraction already restricts the cached roster to
// QB/RB/WR/TE - without that restriction "Gibbs" could just as easily land
// on a linebacker or long-snapper who could never actually be the subject of
// a supported prop, inflating collisions that don't reflect real ambiguity.
// `relevantTeams`, when the caller has it (e.g. the live NFL schedule/odds
// board already fetched for the team-name fallback in the same recovery
// pass), is used ONLY to break a genuine multi-surname tie - not to
// pre-filter the roster before matching - so a team on a bye week (absent
// from that list) never loses an otherwise-unambiguous match.
import { parsePlayerProp } from "@/lib/bet-line";
import { normalizeName, isLikelyDuplicateName } from "@/lib/fuzzy-match";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type PlayerPropResolution =
  | { status: "resolved"; sport: "NFL"; team: string; playerName: string; via: "exact" | "fuzzy" | "surname" }
  | { status: "ambiguous"; matches: { playerName: string; team: string }[] }
  | { status: "unresolved" };

// ESPN's roster displayName includes a generational suffix when the player
// has one ("Kenneth Walker III" - confirmed live) that a capper typing a
// pick essentially never does ("Kenneth Walker Over 45.5 Rushing Yards").
// Stripped from both sides before comparing so this doesn't fall through to
// the fuzzy path (or miss entirely) on nothing but a missing suffix - a 3-4
// character trailing insertion like " III" is bigger than
// isLikelyDuplicateName's edit-distance threshold for most name lengths, so
// plain fuzzy matching alone can't reliably absorb it.
function stripNameSuffix(name: string): string {
  return name.replace(/\s+(jr\.?|sr\.?|II|III|IV|V)$/i, "").trim();
}

// Distinct by espnPlayerId - a roster lists each player once, but this
// guards against the same player somehow matching twice (e.g. a future
// multi-source roster merge) inflating what should be a single-player
// match into a false "ambiguous".
function distinctPlayers(matches: RosterPlayer[]): RosterPlayer[] {
  const byId = new Map<string, RosterPlayer>();
  for (const m of matches) byId.set(m.espnPlayerId, m);
  return [...byId.values()];
}

export function resolvePlayerPropAgainstRoster(
  line: string,
  roster: RosterPlayer[],
  relevantTeams?: string[]
): PlayerPropResolution {
  const prop = parsePlayerProp(line);
  if (!prop) return { status: "unresolved" };

  const typedName = stripNameSuffix(prop.playerName);
  const normalizedTyped = normalizeName(typedName);

  const exact = distinctPlayers(roster.filter((p) => normalizeName(stripNameSuffix(p.playerName)) === normalizedTyped));
  if (exact.length === 1) {
    return { status: "resolved", sport: "NFL", team: exact[0].team, playerName: exact[0].playerName, via: "exact" };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", matches: exact.map((p) => ({ playerName: p.playerName, team: p.team })) };
  }

  const fuzzy = distinctPlayers(roster.filter((p) => isLikelyDuplicateName(stripNameSuffix(p.playerName), typedName)));
  if (fuzzy.length === 1) {
    return { status: "resolved", sport: "NFL", team: fuzzy[0].team, playerName: fuzzy[0].playerName, via: "fuzzy" };
  }
  if (fuzzy.length > 1) {
    return { status: "ambiguous", matches: fuzzy.map((p) => ({ playerName: p.playerName, team: p.team })) };
  }

  // Bare-surname tier - only for a single typed token, and only after both
  // full-name tiers above found nothing at all (see header comment for why
  // this never loosens into "one token is always enough").
  if (!/\s/.test(typedName)) {
    // stripNameSuffix again here: ESPN's own `lastName` field can carry the
    // generational suffix itself (confirmed live - Kenneth Walker III's
    // lastName is literally "Walker III", not "Walker"), so a bare "Walker"
    // needs the same stripping applied on this side of the comparison too.
    const bySurname = distinctPlayers(roster.filter((p) => normalizeName(stripNameSuffix(p.lastName)) === normalizedTyped));
    if (bySurname.length === 1) {
      return { status: "resolved", sport: "NFL", team: bySurname[0].team, playerName: bySurname[0].playerName, via: "surname" };
    }
    if (bySurname.length > 1) {
      if (relevantTeams && relevantTeams.length > 0) {
        const narrowed = bySurname.filter((p) => relevantTeams.includes(p.team));
        if (narrowed.length === 1) {
          return { status: "resolved", sport: "NFL", team: narrowed[0].team, playerName: narrowed[0].playerName, via: "surname" };
        }
      }
      return { status: "ambiguous", matches: bySurname.map((p) => ({ playerName: p.playerName, team: p.team })) };
    }
  }

  return { status: "unresolved" };
}
