// Roster resolution for an NBA prop line that names a player but no team
// ("Jokic o10.5 reb", "Brunson 25+ points") - the NBA twin of
// mlb-roster-fallback.ts, in its own pure module (no fetch, no prisma; the
// rosters come from nba-roster-cache.ts / nhl-roster-cache.ts via
// recover-unresolved-picks.ts) so the NFL / NHL / MLB matching code is not
// touched.
//
// It answers two questions at once: which player, and - for the two markets
// hockey shares, POINTS and ASSISTS - which league.
//
//   1. A league named on the line or by the capper's sub-header wins: only that
//      league's roster is read.
//   2. A market only basketball has (rebounds, threes, PRA, double-double, ...)
//      reads the NBA roster alone.
//   3. Otherwise the typed name is matched against BOTH rosters:
//        one league hits   -> that league
//        both hit          -> the user is asked (candidates from both)
//        neither hits      -> unresolved, never a guess
//   4. The NHL line caps (a hockey points line is never above 3.5, assists
//      2.5) are a second opinion, not the separator. A roster hit beats the
//      cap - an NBA player's "over 2.5 assists" is an NBA pick - but an NHL
//      player with a line no hockey market has ("over 24.5 points") is a
//      contradiction and is left unresolved, not imported as hockey.
//
// A capper alias ("SGA", "Wemby", "Giannis" - nba-player-aliases.ts) is read first.
// Otherwise name matching is resolveNameAgainstRoster's, unchanged: exact full name, then
// fuzzy, then a bare surname; each tier counts only when it lands on exactly one
// player, a shared surname is settled automatically only by a complete slate on
// which one candidate's team plays, and is otherwise the user's to answer.
import { resolveNameAgainstRoster, type PlayerCandidate, type PlayerPropResolution, type SlateContext } from "@/lib/player-roster-fallback";
import { isNhlSharedNbaMarket, normalizeNbaNPlus, type ParsedNbaProp } from "@/lib/nba-prop";
import { nbaPlayerAliasName } from "@/lib/nba-player-aliases";
import { NHL_MAX_ASSISTS_LINE, NHL_MAX_POINTS_LINE } from "@/lib/nhl-prop";
import { parsePlayerPropLine } from "@/lib/bet-line";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type LeagueCandidate = PlayerCandidate & { sport: "NBA" | "NHL" };

export type NbaRosterResolution =
  | { status: "resolved"; sport: "NBA" | "NHL"; team: string; playerName: string }
  // The user has to choose: a surname shared within one league, or a name both
  // leagues have. `candidates` carry their own league.
  | { status: "ask"; typedName: string; candidates: LeagueCandidate[] }
  | { status: "unresolved"; reason: string }
  // No roster knows the name at all. The caller decides: an unresolved player
  // prop, or (for a line that was never positively a prop) its other resolvers.
  | { status: "no-hit"; reason: string };

export type NbaRosterContext = {
  nbaRoster: RosterPlayer[];
  nhlRoster: RosterPlayer[];
  nbaSlate?: SlateContext;
  nhlSlate?: SlateContext;
  // "NBA" / "NHL" when the line or the capper's sub-header names the league.
  league: "NBA" | "NHL" | null;
};

const describe = (matches: PlayerCandidate[]) => matches.map((m) => m.playerName + " (" + m.team + ")").join(", ");

// One league's answer, in this module's terms.
function fromLeague(res: PlayerPropResolution, sport: "NBA" | "NHL", typedName: string): NbaRosterResolution {
  if (res.status === "resolved") return { status: "resolved", sport, team: res.team, playerName: res.playerName };
  if (res.status === "ambiguous") {
    if (res.tier === "surname") return { status: "ask", typedName, candidates: res.matches.map((m) => ({ ...m, sport })) };
    // A full-name collision is not something a prompt settles - same as NFL / NHL.
    return { status: "unresolved", reason: '"' + typedName + '" matches more than one ' + sport + " player (" + describe(res.matches) + ") - this line can't say which" };
  }
  return { status: "no-hit", reason: 'couldn\'t find "' + typedName + '" on an ' + sport + " roster" };
}

function candidatesOf(res: PlayerPropResolution, sport: "NBA" | "NHL", roster: RosterPlayer[]): LeagueCandidate[] {
  if (res.status === "resolved") {
    // The one player the resolver landed on, read back from the roster for his position and id.
    const p = roster.find((r) => r.playerName === res.playerName && r.team === res.team);
    return p ? [{ playerName: p.playerName, team: p.team, position: p.position, externalPlayerId: p.externalPlayerId, sport }] : [];
  }
  if (res.status === "ambiguous") return res.matches.map((m) => ({ ...m, sport }));
  return [];
}

export function resolveNbaPropAgainstRosters(line: string, prop: ParsedNbaProp, ctx: NbaRosterContext): NbaRosterResolution {
  const typedName = prop.playerName;
  const shared = prop.propMarket !== null && isNhlSharedNbaMarket(prop.propMarket);

  // Rule 0: a name capper shorthand gives an NBA player ("SGA", "Wemby", "Giannis" - see
  // nba-player-aliases.ts) is that player, before any fuzzy or surname guess and whatever the
  // market. An alias is NBA evidence on its own, so only a line that names the NHL skips it.
  const alias = ctx.league === "NHL" ? null : nbaPlayerAliasName(typedName);
  if (alias) {
    const res = resolveNameAgainstRoster(alias, ctx.nbaRoster, ctx.nbaSlate, "NBA");
    if (res.status === "resolved") return { status: "resolved", sport: "NBA", team: res.team, playerName: res.playerName };
    // Not on the roster (any more): match what was typed, as below.
  }

  // Rule 2, and rule 1 for "NBA": basketball's roster alone.
  if (!shared || ctx.league === "NBA") {
    return fromLeague(resolveNameAgainstRoster(typedName, ctx.nbaRoster, ctx.nbaSlate, "NBA"), "NBA", typedName);
  }

  const market = prop.propMarket === "POINTS" ? "points" : "assists";
  const cap = prop.propMarket === "POINTS" ? NHL_MAX_POINTS_LINE : NHL_MAX_ASSISTS_LINE;
  const lineInfo = parsePlayerPropLine(normalizeNbaNPlus(line));
  const fitsHockey = lineInfo !== null && lineInfo.line <= cap;
  const notHockey = (playerName: string): NbaRosterResolution => ({
    status: "unresolved",
    reason:
      playerName + " is an NHL player, but " + (lineInfo ? lineInfo.line + " " : "") + market + " is not a hockey line (NHL " + market + " lines stop at " + cap + ") - check the player or the league",
  });

  const nhl = resolveNameAgainstRoster(typedName, ctx.nhlRoster, ctx.nhlSlate, "NHL");

  // Rule 1 for "NHL": hockey's roster alone, the cap still a second opinion.
  if (ctx.league === "NHL") {
    if (nhl.status !== "unresolved" && !fitsHockey) return notHockey(nhl.status === "resolved" ? nhl.playerName : typedName);
    return fromLeague(nhl, "NHL", typedName);
  }

  // Rule 3.
  const nba = resolveNameAgainstRoster(typedName, ctx.nbaRoster, ctx.nbaSlate, "NBA");
  const nbaHit = nba.status !== "unresolved";
  const nhlHit = nhl.status !== "unresolved";

  if (nbaHit && nhlHit) {
    return { status: "ask", typedName, candidates: [...candidatesOf(nba, "NBA", ctx.nbaRoster), ...candidatesOf(nhl, "NHL", ctx.nhlRoster)] };
  }
  if (nbaHit) return fromLeague(nba, "NBA", typedName);
  if (nhlHit) {
    // Rule 4: the roster says hockey, the number says it can't be.
    if (!fitsHockey) return notHockey(nhl.status === "resolved" ? nhl.playerName : typedName);
    return fromLeague(nhl, "NHL", typedName);
  }
  return { status: "no-hit", reason: 'couldn\'t find "' + typedName + '" on an NBA or NHL roster' };
}
