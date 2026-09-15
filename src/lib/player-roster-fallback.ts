// Conservative last-resort resolver for a bare player-prop line with no team
// prefix ("Patrick Mahomes Over 225 Passing Yards" - no "Chiefs") - the
// player-name analog of live-team-fallback.ts's team-name resolution, same
// split: this file is pure/sync (no fetch, no prisma - safe to unit test
// with a fixture-built roster and no network), the actual ESPN fetch lives
// in server/data/nfl-roster.ts and is done once by the caller
// (recover-unresolved-picks.ts) before this is invoked, same "fetch once,
// resolve many lines against it" shape as gatherLiveTeamNames /
// resolveLineAgainstLiveTeams.
//
// Conservative by construction, same policy as resolveLineAgainstLiveTeams:
//   - resolves only when EXACTLY ONE distinct player (by espnPlayerId)
//     matches. An exact (normalized) name match is always preferred; the
//     fuzzy matcher (isLikelyDuplicateName, already used by grading.ts for
//     box-score names) is tried ONLY when no exact match exists at all, and
//     only counts as resolved if it too narrows to exactly one distinct
//     player.
//   - two or more distinct players matching - a genuine same-name collision
//     across teams, or a fuzzy match too loose to trust - reports
//     `ambiguous`, which the caller treats exactly the same as unresolved.
//     This mirrors recoverUnresolvedPicksAction's own existing policy for
//     team-name collisions ("a collision is exactly the case where we must
//     NOT guess") - never guessed here either.
//   - this is only ever invoked for a line parsePlayerProp already
//     recognizes as one of the app's supported player-prop markets
//     (passing/rushing/receiving yards, receptions, TD) - a line with none
//     of those shapes returns `unresolved` immediately, without ever
//     touching the roster.
import { parsePlayerProp } from "@/lib/bet-line";
import { normalizeName, isLikelyDuplicateName } from "@/lib/fuzzy-match";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type PlayerPropResolution =
  | { status: "resolved"; sport: "NFL"; team: string; playerName: string; via: "exact" | "fuzzy" }
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

export function resolvePlayerPropAgainstRoster(line: string, roster: RosterPlayer[]): PlayerPropResolution {
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

  return { status: "unresolved" };
}
