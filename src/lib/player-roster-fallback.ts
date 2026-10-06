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
//   - resolves only when EXACTLY ONE distinct player (by externalPlayerId)
//     matches. An exact (normalized) full-name match is always preferred;
//     the fuzzy matcher (isLikelyDuplicateName, already used by grading.ts
//     for box-score names) is tried next, ONLY when no exact match exists at
//     all; a bare-surname match (see below) is tried last, ONLY when the
//     typed text is a single word - each tier only counts as resolved if it
//     narrows to exactly one distinct player.
//   - two or more distinct players matching at any tier - a genuine
//     same-name (or same-surname) collision across teams, or a fuzzy match
//     too loose to trust - reports `ambiguous`, never a guess. A single
//     typed token is never treated as "close enough" on its own merit: it
//     still has to land on exactly one roster player (see "Shared surnames"
//     below for the one automatic tiebreak) or it stays ambiguous.
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
//
// Shared surnames (2026-10, the "McCaffrey over 38.5 receiving yards" case -
// Christian, 49ers RB, vs Luke, Commanders WR): a bare surname that matches
// 2+ roster players is never guessed. It resolves automatically in exactly
// one situation - `slate` is COMPLETE (see SlateContext) and exactly one
// candidate's team has a game on it (the other is on a bye) - and otherwise
// reports `ambiguous` with tier "surname", which the caller
// (recover-unresolved-lines.ts) turns into the import's "which one?" prompt.
// The slate only ever breaks a tie - it is never used to pre-filter the
// roster - so a team on a bye never loses an otherwise-unambiguous match.
//
// There is deliberately NO paste-context tiebreak. An earlier version also
// narrowed by team names found elsewhere in the same paste ("Commanders -3"
// two lines up); that is exactly what imported the McCaffrey pick above as
// Luke/Commanders. A team named in another pick says nothing about which
// player this line means.
import { parsePlayerProp } from "@/lib/bet-line";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { normalizeName, isLikelyDuplicateName } from "@/lib/fuzzy-match";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type PlayerCandidate = { playerName: string; team: string; position: string; externalPlayerId: string };

// `tier` says where the collision happened. Only "surname" (one typed word
// shared by 2+ players) is something the user can settle by choosing; an
// exact/fuzzy full-name collision stays unresolved, as it always has.
export type PlayerPropResolution =
  | { status: "resolved"; sport: "NFL" | "NHL"; team: string; playerName: string; via: "exact" | "fuzzy" | "surname" }
  | { status: "ambiguous"; tier: "exact" | "fuzzy" | "surname"; matches: PlayerCandidate[] }
  | { status: "unresolved" };

// Every team with a game in the import's matching window (the live scoreboard
// plus the posted odds board, the same two feeds a pick is matched to a game
// from). `complete` is false whenever either feed failed or came back empty:
// a partial slate can make a team look like it has no game, so it must not be
// used to choose between players.
export type SlateContext = { teams: string[]; complete: boolean };

function toCandidates(players: RosterPlayer[]): PlayerCandidate[] {
  return players.map((p) => ({ playerName: p.playerName, team: p.team, position: p.position, externalPlayerId: p.externalPlayerId }));
}

// ESPN's roster displayName includes a generational suffix when the player
// has one ("Kenneth Walker III" - confirmed live) that a capper typing a
// pick essentially never does ("Kenneth Walker Over 45.5 Rushing Yards").
// Stripped from both sides before comparing so this doesn't fall through to
// the fuzzy path (or miss entirely) on nothing but a missing suffix - a 3-4
// character trailing insertion like " III" is bigger than
// isLikelyDuplicateName's edit-distance threshold for most name lengths, so
// plain fuzzy matching alone can't reliably absorb it.
export function stripNameSuffix(name: string): string {
  return name.replace(/\s+(jr\.?|sr\.?|II|III|IV|V)$/i, "").trim();
}

// Distinct by externalPlayerId - a roster lists each player once, but this
// guards against the same player somehow matching twice (e.g. a future
// multi-source roster merge) inflating what should be a single-player
// match into a false "ambiguous".
function distinctPlayers(matches: RosterPlayer[]): RosterPlayer[] {
  const byId = new Map<string, RosterPlayer>();
  for (const m of matches) byId.set(m.externalPlayerId, m);
  return [...byId.values()];
}

// Shared with parse-catalog.ts's findAmbiguousNickname (2026-09, the "Parker
// Washington"/"Dallas Goedert" investigation) - a bare AMBIGUOUS_NICKNAMES
// key (a city/state word like "washington"/"dallas") can also be part of a
// real player's full name, and findAmbiguousNickname needs exactly the same
// "is this a real player" answer this file's own exact/fuzzy tiers give,
// just without the team-resolution part: findAmbiguousNickname only needs a
// yes/no, to decide whether to skip the ambiguous-team prompt - the actual
// team still gets resolved the normal way afterward, once the line falls
// through to `unresolved` and reaches resolvePlayerPropAgainstRoster below.
// One implementation of "exact-or-fuzzy full-name match" - not a second
// fuzzy matcher - built from the exact same stripNameSuffix/normalizeName/
// isLikelyDuplicateName primitives the tiers below use. Deliberately takes
// just a name list (no team/position data): findAmbiguousNickname has no use
// for which team a match belongs to, only whether one exists at all.
//
// Deliberately has no bare-surname tier, unlike resolvePlayerPropAgainstRoster
// below - a single collided word ("Washington" alone, no first name) must
// never suppress the ambiguous-team prompt on its own, since 6 different
// current players share that one surname (see the "never guess" policy this
// file's own bare-surname tier already follows) - only an exact or fuzzy
// FULL name match counts here.
export function isKnownFullPlayerName(name: string, knownFullNames: Iterable<string>): boolean {
  const typed = stripNameSuffix(name);
  const normalizedTyped = normalizeName(typed);
  for (const full of knownFullNames) {
    if (normalizeName(stripNameSuffix(full)) === normalizedTyped) return true;
  }
  for (const full of knownFullNames) {
    if (isLikelyDuplicateName(stripNameSuffix(full), typed)) return true;
  }
  return false;
}

export function resolvePlayerPropAgainstRoster(
  line: string,
  roster: RosterPlayer[],
  slate?: SlateContext,
  // Which league's parser/roster this call is for. The parsed MARKET decides the
  // sport upstream (recover-unresolved-lines.ts passes the NHL roster only for
  // an NHL market), so an NFL and an NHL player sharing a name can never collide.
  sport: "NFL" | "NHL" = "NFL"
): PlayerPropResolution {
  const prop = sport === "NHL" ? parseNhlPlayerProp(line) : parsePlayerProp(line);
  if (!prop) return { status: "unresolved" };

  const typedName = stripNameSuffix(prop.playerName);
  const normalizedTyped = normalizeName(typedName);

  const exact = distinctPlayers(roster.filter((p) => normalizeName(stripNameSuffix(p.playerName)) === normalizedTyped));
  if (exact.length === 1) {
    return { status: "resolved", sport, team: exact[0].team, playerName: exact[0].playerName, via: "exact" };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", tier: "exact", matches: toCandidates(exact) };
  }

  const fuzzy = distinctPlayers(roster.filter((p) => isLikelyDuplicateName(stripNameSuffix(p.playerName), typedName)));
  if (fuzzy.length === 1) {
    return { status: "resolved", sport, team: fuzzy[0].team, playerName: fuzzy[0].playerName, via: "fuzzy" };
  }
  if (fuzzy.length > 1) {
    return { status: "ambiguous", tier: "fuzzy", matches: toCandidates(fuzzy) };
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
      return { status: "resolved", sport, team: bySurname[0].team, playerName: bySurname[0].playerName, via: "surname" };
    }
    if (bySurname.length > 1) {
      // The one automatic tiebreak: a complete slate on which exactly one
      // candidate's team plays. Anything else is the user's call.
      if (slate?.complete) {
        const playing = bySurname.filter((p) => slate.teams.includes(p.team));
        if (playing.length === 1) {
          return { status: "resolved", sport, team: playing[0].team, playerName: playing[0].playerName, via: "surname" };
        }
      }
      return { status: "ambiguous", tier: "surname", matches: toCandidates(bySurname) };
    }
  }

  return { status: "unresolved" };
}

// Passing touchdowns (PASS_TDS) are a QB-only market, so a typed name resolves against the roster's
// quarterbacks only: "Watson" is Deshaun Watson (QB), never WR Christian Watson. Same exact -> fuzzy ->
// bare-surname tiers (and the same complete-slate tie-break) as resolvePlayerPropAgainstRoster, run on the
// QB subset - so when two QBs share a surname, the only one whose team has a game on a complete slate wins,
// and any other tie is "ambiguous" (the caller asks the user which quarterback), never guessed.
//
// Unlike the generic resolver this one says WHY it failed (a specific, user-facing reason naming the
// player) instead of just "unresolved", and applies the "has a game in the window" check when the live
// slate is known: a QB whose team isn't on the NFL schedule/odds board can't be matched to a game anyway.
export type PassTdResolution =
  | { status: "resolved"; team: string; playerName: string; via: "exact" | "fuzzy" | "surname" }
  | { status: "ambiguous"; matches: PlayerCandidate[] }
  | { status: "failed"; reason: string };

function describeQuarterbacks(matches: { playerName: string; team: string }[]): string {
  return matches.map((m) => m.playerName + " (" + m.team + ")").join(", ");
}

export function resolvePassingTdQuarterback(
  line: string,
  roster: RosterPlayer[],
  slate?: SlateContext
): PassTdResolution | null {
  const prop = parsePlayerProp(line);
  if (!prop || prop.propMarket !== "PASS_TDS") return null;
  const typed = prop.playerName;
  const quarterbacks = roster.filter((p) => p.position === "QB");

  const res = resolvePlayerPropAgainstRoster(line, quarterbacks, slate);
  if (res.status === "resolved") {
    // Only enforceable on a complete slate; a failed or partial one means "unknown", not "no games".
    if (slate?.complete && !slate.teams.includes(res.team)) {
      return {
        status: "failed",
        reason:
          res.playerName + " (" + res.team + ") has no game in the current NFL window (bye week or not scheduled), so this pick can't be matched to a game",
      };
    }
    return { status: "resolved", team: res.team, playerName: res.playerName, via: res.via };
  }
  if (res.status === "ambiguous") {
    // A shared QB surname is the user's to settle; a full-name collision still just fails with its reason.
    if (res.tier === "surname") return { status: "ambiguous", matches: res.matches };
    return {
      status: "failed",
      reason:
        '"' + typed + '" matches more than one quarterback (' + describeQuarterbacks(res.matches) + ") - add the first name to say which one",
    };
  }

  // No QB matches. Say so precisely: a real player at another position is a different failure than an
  // unknown name.
  const other = resolvePlayerPropAgainstRoster(line, roster.filter((p) => p.position !== "QB"));
  if (other.status === "resolved") {
    const pos = roster.find((p) => p.playerName === other.playerName && p.team === other.team)?.position ?? "non-QB";
    return {
      status: "failed",
      reason: other.playerName + " (" + other.team + ") is a " + pos + ", not a quarterback - passing TDs is a QB-only market",
    };
  }
  return { status: "failed", reason: "couldn't find a quarterback named \"" + typed + "\" on an active NFL roster" };
}
