// Conservative last-resort resolver for a sport-less MLB prop line ("Juan Soto 1+ BB", "Skubal o6.5 Ks") -
// the MLB twin of player-roster-fallback.ts's NFL/NHL resolver, in its own pure module (no fetch, no
// prisma; the roster comes from mlb-roster-cache.ts via recover-unresolved-picks.ts) so the NFL/NHL
// matching code stays byte-for-byte what it was.
//
// Same policy as the other rosters: resolves ONLY when exactly one distinct mlbPlayerId matches;
// two or more reports `ambiguous` and is never guessed. What MLB adds:
//   - POSITION-AWARE: the parsed market filters the roster BEFORE matching. A pitcher market (Ks,
//     outs) only considers P/TWP; a hitter market only considers non-pitchers. A hitter named on a
//     K line therefore never resolves (batter strikeouts aren't a market), and a pitcher sharing a
//     surname with a hitter never collides with him.
//   - SHARED NAMES: about 30% of MLB surnames collide and there are two real "Max Muncy"s (Dodgers
//     and Athletics), so here a collision can happen at ANY tier, full name included. Same rule as
//     player-roster-fallback.ts: it resolves on its own only when `slate` is COMPLETE (see
//     SlateContext) and exactly one candidate's team has a game on it. Otherwise it reports
//     `ambiguous` with reason "shared-name", which the caller turns into the import's "which one?"
//     prompt. There is deliberately NO paste-context tiebreak: a team named in another pick of the
//     same paste says nothing about which player this line means (the 2026-10 "McCaffrey" import).
//   - CROSS-SPORT GUARD: HITS and RUNS are also hockey/NFL-shaped vocabulary ("hits" is an NHL
//     market; "runs" is a team-total word). With no sport named, the MLB roster hit is the only
//     sport evidence such a line gets, so if the same typed name ALSO matches the NHL roster the
//     line is ambiguous between sports and stays unresolved (same caution as the team-alias work).
//     Checked BEFORE any shared-name handling, so such a line never reaches the prompt either:
//     reason "cross-sport" is a dead end, not a question the user can answer by choosing a player.
import { mlbPositionFitsMarket, parseMlbPlayerProp } from "@/lib/mlb-prop";
import { matchMlbName } from "@/lib/mlb-name-match";
import type { PlayerCandidate, SlateContext } from "@/lib/player-roster-fallback";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type MlbRosterResolution =
  | { status: "resolved"; sport: "MLB"; team: string; playerName: string }
  // `typedName` is the name as the capper wrote it (the prompt's question is keyed on it).
  | { status: "ambiguous"; reason: "shared-name" | "cross-sport"; typedName: string; matches: PlayerCandidate[] }
  | { status: "unresolved" };

function toCandidates(players: RosterPlayer[]): PlayerCandidate[] {
  return players.map((p) => ({ playerName: p.playerName, team: p.team, position: p.position, externalPlayerId: p.externalPlayerId }));
}

export function resolveMlbPropAgainstRoster(
  line: string,
  roster: RosterPlayer[],
  slate?: SlateContext,
  // Rosters of other sports whose vocabulary overlaps (today: NHL, for "hits").
  otherSportRosters: RosterPlayer[][] = []
): MlbRosterResolution {
  const prop = parseMlbPlayerProp(line);
  if (!prop) return { status: "unresolved" };

  const candidates = roster.filter((p) => mlbPositionFitsMarket(p.position, prop.propMarket));
  const hit = matchMlbName(
    prop.playerName,
    candidates,
    (p) => p.externalPlayerId,
    (p) => p.playerName
  );
  if (hit.status === "none") return { status: "unresolved" };
  const matched = hit.status === "one" ? [hit.item] : hit.items;

  if (prop.propMarket === "HITS" || prop.propMarket === "RUNS") {
    for (const other of otherSportRosters) {
      if (matchMlbName(prop.playerName, other, (p) => p.externalPlayerId, (p) => p.playerName).status !== "none") {
        return { status: "ambiguous", reason: "cross-sport", typedName: prop.playerName, matches: toCandidates(matched) };
      }
    }
  }

  let chosen: RosterPlayer | null = matched.length === 1 ? matched[0] : null;
  if (!chosen && slate?.complete) {
    // The one automatic tiebreak: a complete slate on which exactly one candidate's team plays.
    const playing = matched.filter((p) => slate.teams.includes(p.team));
    if (playing.length === 1) chosen = playing[0];
  }
  if (!chosen) return { status: "ambiguous", reason: "shared-name", typedName: prop.playerName, matches: toCandidates(matched) };

  return { status: "resolved", sport: "MLB", team: chosen.team, playerName: chosen.playerName };
}
