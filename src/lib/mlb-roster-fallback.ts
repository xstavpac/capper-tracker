// Conservative last-resort resolver for a sport-less MLB prop line ("Juan Soto 1+ BB", "Skubal o6.5 Ks") -
// the MLB twin of player-roster-fallback.ts's NFL/NHL resolver, in its own pure module (no fetch, no
// prisma; the roster comes from mlb-roster-cache.ts via recover-unresolved-picks.ts) so the NFL/NHL
// matching code stays byte-for-byte what it was.
//
// Same policy as the other rosters: resolves ONLY when exactly one distinct mlbPlayerId matches;
// two or more reports `ambiguous`, which the caller treats exactly like unresolved. What MLB adds:
//   - POSITION-AWARE: the parsed market filters the roster BEFORE matching. A pitcher market (Ks,
//     outs) only considers P/TWP; a hitter market only considers non-pitchers. A hitter named on a
//     K line therefore never resolves (batter strikeouts aren't a market), and a pitcher sharing a
//     surname with a hitter never collides with him.
//   - TEAM CONTEXT: about 30% of MLB surnames collide and there are two real "Max Muncy"s (Dodgers
//     and Athletics). A collision at ANY tier is broken only by team context the capper actually
//     supplied or the board implies - `pasteTeamMentions` (teams already named elsewhere in the same
//     paste) then `relevantTeams` (teams on the live MLB slate) - and only when that narrows to
//     exactly one player. With no such context it stays ambiguous/unresolved; never guessed.
//   - CROSS-SPORT GUARD: HITS and RUNS are also hockey/NFL-shaped vocabulary ("hits" is an NHL
//     market; "runs" is a team-total word). With no sport named, the MLB roster hit is the only
//     sport evidence such a line gets, so if the same typed name ALSO matches the NHL roster the
//     line is ambiguous between sports and stays unresolved (same caution as the team-alias work).
import { mlbPositionFitsMarket, parseMlbPlayerProp } from "@/lib/mlb-prop";
import { matchMlbName } from "@/lib/mlb-name-match";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type MlbRosterResolution =
  | { status: "resolved"; sport: "MLB"; team: string; playerName: string }
  | { status: "ambiguous"; matches: { playerName: string; team: string }[] }
  | { status: "unresolved" };

export function resolveMlbPropAgainstRoster(
  line: string,
  roster: RosterPlayer[],
  relevantTeams: string[] = [],
  pasteTeamMentions: string[] = [],
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

  let chosen: RosterPlayer | null = null;
  if (hit.status === "one") {
    chosen = hit.item;
  } else {
    const narrowed = (pool: RosterPlayer[]) => (pool.length === 1 ? pool[0] : null);
    if (pasteTeamMentions.length > 0) {
      chosen = narrowed(hit.items.filter((p) => pasteTeamMentions.some((m) => p.team.toLowerCase().endsWith(m.toLowerCase()))));
    }
    if (!chosen && relevantTeams.length > 0) chosen = narrowed(hit.items.filter((p) => relevantTeams.includes(p.team)));
    if (!chosen) return { status: "ambiguous", matches: hit.items.map((p) => ({ playerName: p.playerName, team: p.team })) };
  }

  if (prop.propMarket === "HITS" || prop.propMarket === "RUNS") {
    for (const other of otherSportRosters) {
      if (matchMlbName(prop.playerName, other, (p) => p.externalPlayerId, (p) => p.playerName).status !== "none") {
        return { status: "ambiguous", matches: [{ playerName: chosen.playerName, team: chosen.team }] };
      }
    }
  }
  return { status: "resolved", sport: "MLB", team: chosen.team, playerName: chosen.playerName };
}
