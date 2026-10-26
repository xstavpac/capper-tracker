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
  parseSupportedNbaProp,
  explainDroppedNbaProp,
  playerAmbiguityKey,
  findTeamNicknames,
  TEAM_NICKNAME_CANONICAL,
  type AmbiguousOption,
  type ParsedPick,
} from "@/lib/parse-catalog";
import { resolveLineAgainstLiveTeams, parseFallbackBetText, type LiveTeam, type LineResolution } from "@/lib/live-team-fallback";
import {
  resolvePlayerPropAgainstRoster,
  resolvePassingTdQuarterback,
  stripNameSuffix,
  withRosterName,
  type PlayerCandidate,
  type SlateContext,
} from "@/lib/player-roster-fallback";
import { resolveMlbPropAgainstRoster } from "@/lib/mlb-roster-fallback";
import { resolveNbaPropAgainstRosters, type LeagueCandidate } from "@/lib/nba-roster-fallback";
import type { ParsedNbaProp } from "@/lib/nba-prop";
import { parsePlayerProp, isPassingTdsText, pickPeriodFromText, isSidelessOverUnder } from "@/lib/bet-line";
import { parseNhlPlayerProp } from "@/lib/nhl-prop";
import { withRegulationPeriod } from "@/lib/nhl-three-way";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";
import { teamNameEndsWith } from "@/lib/team-name-match";
import type { RosterPlayer } from "@/server/data/nfl-roster";

// The reason an NBA player prop gets when the NBA roster could not be read (not loaded, or the read failed).
const SIDELESS_OVER_UNDER_REASON = "Over/under with no side chosen - add it manually with Over or Under";
const NBA_ROSTER_UNAVAILABLE = "NBA player props need the NBA roster, which isn't available right now";

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

// A near-miss player name (see player-roster-fallback.ts) is placed silently only when the player's team
// is in the pick's game. With no opponent on the line, "the pick's game" is any game on a complete slate
// starting within the next ~36 hours (or under way - started up to 6 hours ago). The whole slate is too
// wide for this: the odds board lists an NFL team's game all week, which would let a typo resolve to any
// player whose team isn't on a bye.
const NEAR_MISS_AHEAD_MS = 36 * 60 * 60 * 1000;
const NEAR_MISS_UNDER_WAY_MS = 6 * 60 * 60 * 1000;

// "49ers" from "San Francisco 49ers" - the team's nickname, for a prompt
// button. Every NFL nickname is the last word of the full name; the NHL and
// MLB have a few two-word ones.
const TWO_WORD_NICKNAME = /(Maple Leafs|Blue Jackets|Red Wings|Golden Knights|Red Sox|White Sox|Blue Jays|Trail Blazers)$/;
function shortTeamName(team: string): string {
  return TWO_WORD_NICKNAME.exec(team)?.[1] ?? team.split(/\s+/).pop() ?? team;
}

// One prompt option per candidate player: "Christian McCaffrey — 49ers RB".
// `nickname` is the full team name lowercased, the same value a resolved
// roster hit puts in teamNicknames.
// `nearMissOf`: the typed name, when it was only a near-miss of these players - choosing one then
// renames it in the pick (resolveAmbiguousPick).
export function playerAmbiguityOptions(sport: string, matches: PlayerCandidate[], nearMissOf?: string): AmbiguousOption[] {
  return matches.map((m) => ({
    label: m.playerName + " — " + shortTeamName(m.team) + " " + m.position,
    sport,
    nickname: m.team.toLowerCase(),
    playerName: m.playerName,
    ...(nearMissOf ? { typedName: nearMissOf } : {}),
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
  slateCompleteSports: string[] = [],
  // Cached NBA roster. Same default as the others: empty means no NBA line is ever resolved here,
  // and every NHL line behaves exactly as it did before NBA props existed.
  nbaRoster: RosterPlayer[] = [],
  // unresolved-line index -> the league of the capper's bare "NBA" / "NHL" sub-header
  // (parseCatalog's unresolvedLeagues).
  leagueHints: Record<number, "NBA" | "NHL"> = {},
  // The clock the near-miss game window is measured from (tests pin it).
  now: number = Date.now()
): RecoverUnresolvedResult {
  const recovered: ParsedPick[] = [];
  const stillUnresolved: string[] = [];
  const reasons: Record<string, string> = {};
  // Why a lowercase NBA-prop line the rosters did not place was handed on to the team resolvers -
  // the reason it keeps if they cannot place it either.
  const nbaMissReasons = new Map<string, string>();

  const isPlayerProp = new Set(unresolved.filter((line) => parsePlayerProp(line) !== null));

  // NBA prop lines naming a player and no team (nba-prop.ts) the NFL parser does not claim.
  // `strict` is a line parseCatalog itself identified as one (a capitalized name) and parked
  // here: it is a player prop whatever the rosters say, so a miss leaves it unresolved. A
  // lowercase one ("jokic o10.5 reb") was never positively a prop: on a roster miss it goes on
  // to the resolvers below, exactly as before.
  const nbaProps = new Map<string, { prop: ParsedNbaProp; strict: boolean }>();
  for (const line of unresolved) {
    if (isPlayerProp.has(line)) continue;
    const strict = parseSupportedNbaProp(line);
    if (strict) {
      if (strict.subject === "person") nbaProps.set(line, { prop: strict.prop, strict: true });
      continue;
    }
    if (detectUnsupportedPropLine(line)) continue;
    const loose = parseSupportedNbaProp(line, { anyCase: true });
    if (loose?.subject === "person") nbaProps.set(line, { prop: loose.prop, strict: false });
  }
  const strictNba = (line: string): boolean => nbaProps.get(line)?.strict === true;
  const hasNbaCode = (line: string): boolean => /\bNBA\b/i.test(line);
  // The verdict detectUnsupportedPropLine gave such a line before the NBA parser existed:
  // "Player prop not supported yet" (no league named) - the lines the NHL rules below call
  // sport-less.
  const isSportlessStatLine = (line: string): boolean =>
    detectUnsupportedPropLine(line)?.reason === UNSUPPORTED_PROP_REASONS.GENERIC || (strictNba(line) && !hasNbaCode(line));

  // NHL prop lines (nhl-prop.ts) the NFL parser does not claim. Eligible only
  // when the line is not a team/game stat total or another sport's prop: i.e.
  // not flagged unsupported at all, flagged NHL, or flagged with the GENERIC
  // reason (sport-less points/assists - basketball vocabulary too, which is why
  // the NHL roster hit below is the ONLY sport evidence such a line gets).
  const isNhlProp = new Set(
    unresolved.filter((line) => {
      if (isPlayerProp.has(line) || parseNhlPlayerProp(line) === null) return false;
      // A points / assists line the NBA parser reads too is eligible exactly when it was
      // before: no "NBA" on it.
      if (strictNba(line)) return !hasNbaCode(line);
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
    if (isPlayerProp.has(line) || isNhlProp.has(line) || isMlbProp.has(line) || detectUnsupportedPropLine(line) || strictNba(line)) continue;
    nonPlayerPropResolutions.set(line, resolveLineAgainstLiveTeams(line, liveTeams));
  }

  // `opponent`: the team an NBA line names after "@" / "vs" - when it reads as a team, the pick's game is
  // that opponent's, and a near-miss is placed only on the team playing it. Otherwise the ~36-hour window.
  const slateFor = (sport: string, opponent?: string): SlateContext => {
    const entries = liveTeams.filter((t) => t.sport === sport);
    const complete = slateCompleteSports.includes(sport);
    let nearMissTeams: string[] | undefined;
    const nicknames = opponent ? findTeamNicknames(opponent, sport).map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n) : [];
    if (nicknames.length > 0) {
      nearMissTeams = entries.filter((t) => t.opponent && nicknames.some((n) => teamNameEndsWith(t.opponent!, n))).map((t) => t.name);
    } else if (complete) {
      nearMissTeams = entries
        .filter((t) => {
          const start = t.commenceTime ? Date.parse(t.commenceTime) : NaN;
          return start >= now - NEAR_MISS_UNDER_WAY_MS && start <= now + NEAR_MISS_AHEAD_MS;
        })
        .map((t) => t.name);
    }
    return { teams: entries.map((t) => t.name), complete, nearMissTeams };
  };

  // A bare surname shared by 2+ rostered players that the slate could not
  // settle, or a near-miss name the pick's game could not (`nearMiss` - the
  // options then carry the typed name, so choosing one renames it): recovered
  // as a pick awaiting the user's choice. The description
  // stays unparsed - resolveAmbiguousPick re-parses it once a player is chosen,
  // same as an ambiguous-team pick.
  const awaitingPlayerChoice = (
    capperName: string,
    sport: "NFL" | "NHL" | "MLB",
    line: string,
    lineForParsing: string,
    gameNumber: ParsedPick["gameNumber"],
    typedName: string,
    matches: PlayerCandidate[],
    nearMiss = false
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
      ambiguous: playerAmbiguityOptions(sport, matches, nearMiss ? typedName : undefined),
      ambiguousKey: playerAmbiguityKey(sport, stripNameSuffix(typedName), matches.map((m) => m.externalPlayerId)),
      ambiguousBetType: parsed.betType,
      ambiguousLine: null,
      teamNicknames: [],
      gameNumber,
    };
  };

  // The text an NBA-roster pick is built from: the league code dropped (the pick carries its
  // sport), and an all-lowercase name capitalized so every later read of the stored text - the
  // N+ rewrite, the bet-type classification - sees the player prop this pass established.
  const nbaPropText = (text: string, typedName: string): string => {
    const noCode = text.replace(/\b(?:NBA|NHL)\b[:\s-]*/gi, " ").replace(/\s{2,}/g, " ").trim();
    if (typedName !== typedName.toLowerCase() || !noCode.includes(typedName)) return noCode;
    return noCode.replace(typedName, typedName.replace(/(^|[\s'-])([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase()));
  };

  // A player both leagues have, or a surname several players share: recovered as a pick
  // awaiting the user's choice, each option carrying its own league.
  const awaitingLeagueChoice = (
    capperName: string,
    line: string,
    text: string,
    gameNumber: ParsedPick["gameNumber"],
    typedName: string,
    candidates: LeagueCandidate[],
    nearMiss = false
  ): ParsedPick => {
    const parsed = parsePickText(text);
    const sports = [...new Set(candidates.map((c) => c.sport))];
    return {
      capperName,
      sportName: sports.length === 1 ? sports[0] : "",
      description: withGameNumberSuffix(text, gameNumber),
      betType: "PLAYER_PROP",
      odds: parsed.odds ?? -110,
      hasExplicitOdds: parsed.odds !== null,
      totalSide: parsed.totalSide,
      units: parsed.units,
      period: parsed.period,
      raw: line,
      ambiguous: candidates.map((c) => ({
        label: c.playerName + " — " + shortTeamName(c.team) + " " + c.position + (sports.length > 1 ? " (" + c.sport + ")" : ""),
        sport: c.sport,
        nickname: c.team.toLowerCase(),
        playerName: c.playerName,
        ...(nearMiss ? { typedName } : {}),
      })),
      ambiguousKey: playerAmbiguityKey(sports.join("/"), stripNameSuffix(typedName), candidates.map((c) => c.sport + ":" + c.externalPlayerId)),
      ambiguousBetType: "PLAYER_PROP",
      ambiguousLine: null,
      teamNicknames: [],
      gameNumber,
    };
  };

  for (let i = 0; i < unresolved.length; i++) {
    const line = unresolved[i];
    const capperName = unresolvedCapperNames[i] ?? "";
    // Same "Game 2"/"G2"/... extraction parseCatalog's own picks already get
    // (see parse-catalog.ts's extractGameNumber) - a recovered line never
    // went through that extraction the first time, since it only failed to
    // resolve. Computed from `line`, not used to change it: isPlayerProp/
    // nonPlayerPropResolutions below are keyed by the exact original `line`
    // string from the lookups built above.
    const { gameNumber, rest: lineForParsing } = extractGameNumber(line);

    const nba = nbaProps.get(line);
    if (nba && nbaRoster.length > 0) {
      // Which player, and for points / assists which league - see nba-roster-fallback.ts.
      const res = resolveNbaPropAgainstRosters(line, nba.prop, {
        nbaRoster,
        nhlRoster,
        nbaSlate: slateFor("NBA", nba.prop.opponent),
        nhlSlate: slateFor("NHL"),
        league: hasNbaCode(line) ? "NBA" : leagueHints[i] ?? null,
      });
      const text = nbaPropText(lineForParsing, nba.prop.playerName);
      if (res.status === "ask") {
        recovered.push(awaitingLeagueChoice(capperName, line, text, gameNumber, res.typedName, res.candidates, res.nearMiss));
        continue;
      }
      if (res.status === "resolved") {
        const parsed = parsePickText(text);
        recovered.push({
          capperName,
          sportName: res.sport,
          description: withGameNumberSuffix(
            res.nearMiss ? withRosterName(parsed.cleanDescription, nba.prop.playerName, res.playerName) : parsed.cleanDescription,
            gameNumber
          ),
          betType: "PLAYER_PROP",
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
      if (res.status === "unresolved" || nba.strict) {
        stillUnresolved.push(line);
        reasons[line] = res.reason;
        continue;
      }
      // No roster knows a lowercase name: not a prop we can place - the resolvers below get it,
      // and if none of them can either, this is why.
      nbaMissReasons.set(line, res.reason);
    } else if (nba && nbaRoster.length === 0 && !nba.strict) {
      nbaMissReasons.set(line, NBA_ROSTER_UNAVAILABLE);
    } else if (nba?.strict && !isNhlProp.has(line)) {
      // No NBA roster to read (not loaded, or the read failed): an NBA prop cannot be placed.
      // A points / assists line still gets the NHL-only handling below, as before.
      stillUnresolved.push(line);
      reasons[line] = NBA_ROSTER_UNAVAILABLE;
      continue;
    }

    if (isNhlProp.has(line)) {
      // Same conservative policy as the NFL branch below: resolves only on
      // EXACTLY ONE distinct NHL player; a shared surname asks the user.
      const res = resolvePlayerPropAgainstRoster(line, nhlRoster, slateFor("NHL"), "NHL");
      // A sport-less points/assists line gets its sport only from a UNIQUE NHL
      // roster hit (see isNhlProp above); a shared surname is no such evidence,
      // so that line stays unresolved instead of prompting with NHL players.
      const sportIsEvident = !isSportlessStatLine(line);
      const nhlTyped = parseNhlPlayerProp(line)!.playerName;
      if (res.status === "ambiguous" && (res.tier === "surname" || res.tier === "near-miss") && sportIsEvident) {
        recovered.push(awaitingPlayerChoice(capperName, "NHL", line, lineForParsing, gameNumber, nhlTyped, res.matches, res.tier === "near-miss"));
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
        description: withGameNumberSuffix(
          res.via === "fuzzy" ? withRosterName(parsed.cleanDescription, nhlTyped, res.playerName) : parsed.cleanDescription,
          gameNumber
        ),
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
      if (res.status === "ambiguous" && (res.reason === "shared-name" || res.reason === "near-miss")) {
        recovered.push(awaitingPlayerChoice(capperName, "MLB", line, lineForParsing, gameNumber, res.typedName, res.matches, res.reason === "near-miss"));
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
        description: withGameNumberSuffix(
          res.nearMiss ? withRosterName(parsed.cleanDescription, res.typedName, res.playerName) : parsed.cleanDescription,
          gameNumber
        ),
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
    if (detectUnsupportedPropLine(line) || strictNba(line)) {
      stillUnresolved.push(line);
      continue;
    }

    if (isPlayerProp.has(line)) {
      // The slate only ever breaks a bare-surname collision (when complete)
      // or places a near-miss name (its ~36-hour window) - an exact full name
      // never reads it. What it can't settle goes to the user, never to a guess.
      const typed = parsePlayerProp(line)!.playerName;
      let team: string;
      // The roster's name when the typed one was only a near-miss of it.
      let rosterName: string | null = null;
      if (isPassingTdsText(line)) {
        // QB-only market: resolves against quarterbacks and reports WHY it failed (a non-QB, an unknown
        // name, no game in the window) instead of the generic unresolved message.
        const qb = resolvePassingTdQuarterback(line, roster, slateFor("NFL"));
        if (qb?.status === "ambiguous") {
          recovered.push(awaitingPlayerChoice(capperName, "NFL", line, lineForParsing, gameNumber, typed, qb.matches, qb.tier === "near-miss"));
          continue;
        }
        if (qb?.status !== "resolved") {
          stillUnresolved.push(line);
          if (qb) reasons[line] = qb.reason;
          continue;
        }
        team = qb.team;
        if (qb.via === "fuzzy") rosterName = qb.playerName;
      } else {
        const res = resolvePlayerPropAgainstRoster(line, roster, slateFor("NFL"));
        if (res.status === "ambiguous" && (res.tier === "surname" || res.tier === "near-miss")) {
          recovered.push(awaitingPlayerChoice(capperName, "NFL", line, lineForParsing, gameNumber, typed, res.matches, res.tier === "near-miss"));
          continue;
        }
        if (res.status !== "resolved") {
          // A full-name collision (2+ distinct players with the same exact
          // name) is deliberately treated the same as "unresolved".
          stillUnresolved.push(line);
          continue;
        }
        team = res.team;
        if (res.via === "fuzzy") rosterName = res.playerName;
      }

      const parsed = parsePickText(lineForParsing);
      recovered.push({
        capperName,
        sportName: "NFL",
        description: withGameNumberSuffix(rosterName ? withRosterName(parsed.cleanDescription, typed, rosterName) : parsed.cleanDescription, gameNumber),
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

    // No side chosen ("o/u 6.5"): parseFallbackBetText would default it to a
    // spread. Stays unresolved instead, with the reason shown.
    if (isSidelessOverUnder(lineForParsing)) {
      stillUnresolved.push(line);
      reasons[line] = SIDELESS_OVER_UNDER_REASON;
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
      // Read from the text like every other import path. Stored as FULL_GAME,
      // a "first quarter" line could never grade: the grader re-reads the
      // quarter from the text and declines the mismatch.
      period: pickPeriodFromText(lineForParsing),
      raw: line,
      teamNicknames: [res.nickname],
      gameNumber,
    });
  }

  // Same hockey 3-way read parseCatalog applies to the lines it placed itself.
  for (const pick of recovered) pick.period = withRegulationPeriod(pick);

  // Every line that reads as an NBA player prop and still is not placed says why (no line is
  // dropped with a blank reason): the roster pass's own verdict when there is one, else why it
  // never reached the roster pass. A line some other rule already explains is left alone.
  for (const line of stillUnresolved) {
    // The generic "Player prop not supported yet" is not an answer for an NBA prop - they are supported.
    const other = detectUnsupportedPropLine(line)?.reason;
    if (reasons[line] || (other && other !== UNSUPPORTED_PROP_REASONS.GENERIC)) continue;
    const reason = nbaMissReasons.get(line) ?? explainDroppedNbaProp(line);
    if (reason) reasons[line] = reason;
  }

  return { recovered, stillUnresolved, reasons };
}
