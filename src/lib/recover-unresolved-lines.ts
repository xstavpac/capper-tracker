// Pure core of the catalog-import recovery pass (server/actions/recover-
// unresolved-picks.ts is the async, "use server" wrapper that fetches
// liveTeams/roster and calls this). Split out - same reason nfl-prop-odds.ts
// splits resolvePropOdds/resolvePropOddsFromGame and live-team-fallback.ts
// stays a plain module - the "use server" action file transitively imports
// requireUser (@/server/auth), which imports React's cache() and can't be
// loaded outside a Next.js request; a pure file with no such import is the
// only way this logic is unit-testable with fixture data (no network, no DB,
// no auth).
//
// Attribution: unresolvedCapperNames[i] is the capper header active in
// parseCatalog's own pass when unresolved[i] was pushed - the ONLY place
// that association is ever known, since a line in `unresolved` is plain text
// with no capper of its own. Used directly here (by index) instead of being
// re-derived after the fact by scanning already-resolved picks for the
// nearest one before this line's position (the old approach) - that
// reconstruction broke whenever the recovered line was the only, or first,
// pick under its header (a real reported bug: the header matched correctly
// during parseCatalog's own pass, but the resulting recovered pick still
// showed "Unknown", because there was no earlier resolved pick under that
// same header for the reconstruction to find), and it broke similarly for a
// capper whose picks ALL needed recovery - none of their own lines ever
// entered the resolved-picks list either, so every one of them was
// attributed to whichever earlier capper's pick happened to appear first.
import {
  parsePickText,
  extractGameNumber,
  withGameNumberSuffix,
  detectUnsupportedPropLine,
  parseSupportedMlbProp,
  playerAmbiguityKey,
  type AmbiguousOption,
  type ParsedPick,
} from "@/lib/parse-catalog";
import { resolveLineAgainstLiveTeams, parseFallbackBetText, type LiveTeam, type LineResolution } from "@/lib/live-team-fallback";
import {
  resolvePlayerPropAgainstRoster,
  resolvePassingTdQuarterback,
  stripNameSuffix,
  type PlayerCandidate,
  type SlateContext,
} from "@/lib/player-roster-fallback";
import { resolveMlbPropAgainstRoster } from "@/lib/mlb-roster-fallback";
import { parsePlayerProp, isPassingTdsText } from "@/lib/bet-line";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type RecoverUnresolvedResult = {
  // Includes picks still awaiting a "which player?" answer (a bare surname 2+
  // rostered players share): those carry `ambiguous`/`ambiguousKey` and flow
  // through the same prompt as an ambiguous team name.
  recovered: ParsedPick[];
  stillUnresolved: string[];
  // Specific, user-facing reason for a stillUnresolved line, keyed by the exact line text. Only set
  // where the resolver knows why (today: passing-TDs QB resolution); other lines keep the generic message.
  reasons: Record<string, string>;
};

// "49ers" from "San Francisco 49ers" - the team's nickname, for a prompt
// button. Every NFL nickname is the last word of the full name; the NHL and
// MLB have a few two-word ones.
const TWO_WORD_NICKNAME = /(Maple Leafs|Blue Jackets|Red Wings|Golden Knights|Red Sox|White Sox|Blue Jays)$/;
function shortTeamName(team: string): string {
  return TWO_WORD_NICKNAME.exec(team)?.[1] ?? team.split(/\s+/).pop() ?? team;
}

// One prompt option per candidate player: "Christian McCaffrey — 49ers RB".
// `nickname` is the full team name lowercased, the same value a resolved
// roster hit puts in teamNicknames.
export function playerAmbiguityOptions(sport: string, matches: PlayerCandidate[]): AmbiguousOption[] {
  return matches.map((m) => ({
    label: m.playerName + " — " + shortTeamName(m.team) + " " + m.position,
    sport,
    nickname: m.team.toLowerCase(),
  }));
}

export function recoverUnresolvedLines(
  unresolved: string[],
  unresolvedCapperNames: string[],
  liveTeams: LiveTeam[],
  roster: RosterPlayer[],
  // No longer consulted (2026-10): these are the picks parseCatalog resolved
  // on its first pass, once used as "paste context" to choose between players
  // sharing a name. A team named in another pick must not decide that. Kept
  // only so the argument order stays stable for callers.
  _resolvedPicks: ParsedPick[] = [],
  // Cached NHL roster. Optional/empty by default, in which case NHL lines stay
  // unresolved exactly as before NHL props existed.
  nhlRoster: RosterPlayer[] = [],
  // Cached MLB 40-man roster. Same default: empty means MLB lines stay unresolved as before.
  mlbRoster: RosterPlayer[] = [],
  // Sport labels ("NFL", "NHL", "MLB") whose slate in `liveTeams` is known complete -
  // see SlateContext. A sport not listed here (the default) never has its
  // slate used to choose between players sharing a surname.
  slateCompleteSports: string[] = []
): RecoverUnresolvedResult {
  const recovered: ParsedPick[] = [];
  const stillUnresolved: string[] = [];
  const reasons: Record<string, string> = {};

  const isPlayerProp = new Set(unresolved.filter((line) => parsePlayerProp(line) !== null));

  // NHL prop lines (nhl-prop.ts) the NFL parser does not claim. Eligible only
  // when the line is not a team/game stat total or another sport's prop: i.e.
  // not flagged unsupported at all, flagged NHL, or flagged with the GENERIC
  // reason (sport-less points/assists - basketball vocabulary too, which is why
  // the NHL roster hit below is the ONLY sport evidence such a line gets).
  const isNhlProp = new Set(
    unresolved.filter((line) => {
      if (isPlayerProp.has(line) || parseNhlPlayerProp(line) === null) return false;
      const unsupported = detectUnsupportedPropLine(line);
      return !unsupported || unsupported.sport === "NHL" || unsupported.reason === UNSUPPORTED_PROP_REASONS.GENERIC;
    })
  );

  // MLB prop lines (mlb-prop.ts) neither the NFL nor NHL parser claims. parseSupportedMlbProp already
  // requires MLB vocabulary/code plus a PERSON subject (team totals never qualify); the MLB roster hit
  // below - position-aware, unique - is the only thing that ever gives a sport-less line its sport.
  const isMlbProp = new Set(
    unresolved.filter((line) => !isPlayerProp.has(line) && !isNhlProp.has(line) && parseSupportedMlbProp(line) !== null)
  );

  // Every non-player-prop unresolved line's own team-fallback resolution.
  // Pure and cheap (no network call - resolveLineAgainstLiveTeams only matches
  // against the liveTeams already fetched).
  const nonPlayerPropResolutions = new Map<string, LineResolution>();
  for (const line of unresolved) {
    if (isPlayerProp.has(line) || isNhlProp.has(line) || isMlbProp.has(line) || detectUnsupportedPropLine(line)) continue;
    nonPlayerPropResolutions.set(line, resolveLineAgainstLiveTeams(line, liveTeams));
  }

  const slateFor = (sport: string): SlateContext => ({
    teams: liveTeams.filter((t) => t.sport === sport).map((t) => t.name),
    complete: slateCompleteSports.includes(sport),
  });

  // A bare surname shared by 2+ rostered players that the slate could not
  // settle: recovered as a pick awaiting the user's choice. The description
  // stays unparsed - resolveAmbiguousPick re-parses it once a player is chosen,
  // same as an ambiguous-team pick.
  const awaitingPlayerChoice = (
    capperName: string,
    sport: "NFL" | "NHL" | "MLB",
    line: string,
    lineForParsing: string,
    gameNumber: ParsedPick["gameNumber"],
    typedName: string,
    matches: PlayerCandidate[]
  ): ParsedPick => {
    const parsed = parsePickText(lineForParsing);
    return {
      capperName,
      sportName: sport,
      description: withGameNumberSuffix(lineForParsing, gameNumber),
      betType: parsed.betType,
      odds: parsed.odds ?? -110,
      hasExplicitOdds: parsed.odds !== null,
      totalSide: parsed.totalSide,
      units: parsed.units,
      period: parsed.period,
      raw: line,
      ambiguous: playerAmbiguityOptions(sport, matches),
      ambiguousKey: playerAmbiguityKey(sport, stripNameSuffix(typedName), matches.map((m) => m.externalPlayerId)),
      ambiguousBetType: parsed.betType,
      ambiguousLine: null,
      teamNicknames: [],
      gameNumber,
    };
  };

  for (let i = 0; i < unresolved.length; i++) {
    const line = unresolved[i];
    const capperName = unresolvedCapperNames[i] ?? "Unknown";
    // Same "Game 2"/"G2"/... extraction parseCatalog's own picks already get
    // (see parse-catalog.ts's extractGameNumber) - a recovered line never
    // went through that extraction the first time, since it only failed to
    // resolve. Computed from `line`, not used to change it: isPlayerProp/
    // nonPlayerPropResolutions below are keyed by the exact original `line`
    // string from the lookups built above.
    const { gameNumber, rest: lineForParsing } = extractGameNumber(line);

    if (isNhlProp.has(line)) {
      // Same conservative policy as the NFL branch below: resolves only on
      // EXACTLY ONE distinct NHL player; a shared surname asks the user.
      const res = resolvePlayerPropAgainstRoster(line, nhlRoster, slateFor("NHL"), "NHL");
      // A sport-less points/assists line gets its sport only from a UNIQUE NHL
      // roster hit (see isNhlProp above); a shared surname is no such evidence,
      // so that line stays unresolved instead of prompting with NHL players.
      const sportIsEvident = detectUnsupportedPropLine(line)?.reason !== UNSUPPORTED_PROP_REASONS.GENERIC;
      if (res.status === "ambiguous" && res.tier === "surname" && sportIsEvident) {
        const typed = parseNhlPlayerProp(line)!.playerName;
        recovered.push(awaitingPlayerChoice(capperName, "NHL", line, lineForParsing, gameNumber, typed, res.matches));
        continue;
      }
      if (res.status !== "resolved") {
        stillUnresolved.push(line);
        continue;
      }
      const parsed = parsePickText(lineForParsing);
      recovered.push({
        capperName,
        sportName: res.sport,
        description: withGameNumberSuffix(parsed.cleanDescription, gameNumber),
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        period: parsed.period,
        raw: line,
        teamNicknames: [res.team.toLowerCase()],
        gameNumber,
      });
      continue;
    }

    if (isMlbProp.has(line)) {
      // Same conservative policy: resolves only on EXACTLY ONE position-fitting MLB player. A name
      // 2+ of them share asks the user unless a complete slate has exactly one of their teams on it;
      // a name that is ambiguous between SPORTS stays unresolved.
      const res = resolveMlbPropAgainstRoster(line, mlbRoster, slateFor("MLB"), [nhlRoster]);
      if (res.status === "ambiguous" && res.reason === "shared-name") {
        recovered.push(awaitingPlayerChoice(capperName, "MLB", line, lineForParsing, gameNumber, res.typedName, res.matches));
        continue;
      }
      if (res.status !== "resolved") {
        stillUnresolved.push(line);
        continue;
      }
      const parsed = parsePickText(lineForParsing);
      recovered.push({
        capperName,
        sportName: res.sport,
        description: withGameNumberSuffix(parsed.cleanDescription, gameNumber),
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        period: parsed.period,
        raw: line,
        teamNicknames: [res.team.toLowerCase()],
        gameNumber,
      });
      continue;
    }

    // MLB/NHL player props have no roster or team path yet - never let the
    // live-team fallback match a word inside a player's name to a team.
    // (Supported NHL markets took the isNhlProp branch above.)
    if (detectUnsupportedPropLine(line)) {
      stillUnresolved.push(line);
      continue;
    }

    if (isPlayerProp.has(line)) {
      // The slate only ever breaks a bare-surname collision, and only when
      // complete - it never affects the exact/fuzzy full-name tiers. A
      // collision it can't settle goes to the user, never to a guess.
      const typed = parsePlayerProp(line)!.playerName;
      let team: string;
      if (isPassingTdsText(line)) {
        // QB-only market: resolves against quarterbacks and reports WHY it failed (a non-QB, an unknown
        // name, no game in the window) instead of the generic unresolved message.
        const qb = resolvePassingTdQuarterback(line, roster, slateFor("NFL"));
        if (qb?.status === "ambiguous") {
          recovered.push(awaitingPlayerChoice(capperName, "NFL", line, lineForParsing, gameNumber, typed, qb.matches));
          continue;
        }
        if (qb?.status !== "resolved") {
          stillUnresolved.push(line);
          if (qb) reasons[line] = qb.reason;
          continue;
        }
        team = qb.team;
      } else {
        const res = resolvePlayerPropAgainstRoster(line, roster, slateFor("NFL"));
        if (res.status === "ambiguous" && res.tier === "surname") {
          recovered.push(awaitingPlayerChoice(capperName, "NFL", line, lineForParsing, gameNumber, typed, res.matches));
          continue;
        }
        if (res.status !== "resolved") {
          // A full-name collision (2+ distinct players with the same exact or
          // fuzzy name) is deliberately treated the same as "unresolved".
          stillUnresolved.push(line);
          continue;
        }
        team = res.team;
      }

      const parsed = parsePickText(lineForParsing);
      recovered.push({
        capperName,
        sportName: "NFL",
        description: withGameNumberSuffix(parsed.cleanDescription, gameNumber),
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        period: parsed.period,
        raw: line,
        teamNicknames: [team.toLowerCase()],
        gameNumber,
      });
      continue;
    }

    const res = nonPlayerPropResolutions.get(line)!;
    if (res.status !== "resolved") {
      // "ambiguous" is deliberately treated the same as "unresolved" here -
      // a collision is exactly the case where we must NOT guess.
      stillUnresolved.push(line);
      continue;
    }

    const bet = parseFallbackBetText(lineForParsing);
    recovered.push({
      capperName,
      sportName: res.sport,
      description: withGameNumberSuffix(lineForParsing, gameNumber),
      betType: bet.betType,
      odds: bet.odds,
      hasExplicitOdds: bet.hasExplicitOdds,
      totalSide: bet.totalSide,
      units: bet.units,
      period: "FULL_GAME",
      raw: line,
      teamNicknames: [res.nickname],
      gameNumber,
    });
  }

  return { recovered, stillUnresolved, reasons };
}
