// NHL player-prop grading: Over/Under and N+ lines on shots on goal, points,
// assists and goalie saves; anytime and first goal scorer (yes/no shaped).
// Wired into grading.ts's resolvePlayerProp for sportName === "NHL" only - the
// NFL grading path is untouched. Same resolution shape as the NFL graders:
// { outcome } or { outcome: null, reason } where null keeps the pick PENDING
// (and `reason` feeds the pending-picks triage view).
//
// Box-score facts this relies on (verified, see nhl-boxscore.ts): shots on goal
// is the "S" column (never "SOG"); saves is "SV"; box-score G/S exclude
// shootout attempts; first-goal ordering uses plays with period <= 4.
//
// Did-not-play policy: a pick resolves PUSH (stake returned) ONLY when ALL hold:
//   1. the NHL roster cache resolves the typed name to EXACTLY ONE espnPlayerId
//      (league-wide, so a name that could be two players never pushes),
//   2. the game is final,
//   3. the box score is complete (both teams have populated skater AND goalie
//      groups),
//   4. that id is absent from the box score (and that player's team is one of
//      the two teams in this game).
// Anything else - a name-only miss, an ambiguous roster hit, a partial box
// score - stays PENDING with the "couldn't find" reason, exactly like NFL. For
// SAVES a goalie absent from the box score pushes; a goalie who appears
// (including one pulled mid-game) grades on his actual SV.
import { isLikelyDuplicateName, normalizeName } from "@/lib/fuzzy-match";
import { parsePlayerPropLine } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import { isNhlPropMarket, nhlAnytimeGoalSide, normalizeNhlNPlus, parseNhlPlayerProp, type NhlPropMarket } from "@/lib/nhl-prop";
import { fetchNhlBoxScore, type NhlBoxScore } from "@/server/data/nhl-boxscore";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type NhlPropPick = {
  playerName: string | null;
  propMarket: string | null;
  betDetail: string | null;
  homeTeam: string;
  awayTeam: string;
};

export type NhlPropResolution = { outcome: "WIN" | "LOSS" | "PUSH" } | { outcome: null; reason: string };

export type NhlPropDeps = {
  fetchBox?: (eventId: string) => Promise<NhlBoxScore | null>;
  // Lazily called - only when the player is missing from the box score.
  getRoster?: () => Promise<RosterPlayer[]>;
};

// Same WIN/LOSS/PUSH rule as grading.ts's gradeAgainstLine (kept local so the
// NFL module is not touched): all NHL stats here are integers, so a PUSH is only
// reachable on a whole-number line.
function gradeAgainstLine(actual: number, line: number, direction: "OVER" | "UNDER"): "WIN" | "LOSS" | "PUSH" {
  if (actual === line) return "PUSH";
  return actual > line === (direction === "OVER") ? "WIN" : "LOSS";
}

function stripSuffix(name: string): string {
  return name.replace(/\s+(jr\.?|sr\.?|II|III|IV|V)$/i, "").trim();
}

type NameMatch<T> = { status: "one"; item: T } | { status: "many" } | { status: "none" };

// Exact normalized full name -> fuzzy full name -> (single typed token only)
// bare surname; each tier counts only if it narrows to exactly one distinct
// player id. Same tier policy as player-roster-fallback.ts.
function matchByName<T extends { espnPlayerId: string }>(
  typed: string,
  items: T[],
  fullName: (i: T) => string,
  lastName: (i: T) => string
): NameMatch<T> {
  const t = stripSuffix(typed);
  const nt = normalizeName(t);
  const distinct = (xs: T[]) => [...new Map(xs.map((x) => [x.espnPlayerId, x])).values()];
  const tiers: T[][] = [
    items.filter((i) => normalizeName(stripSuffix(fullName(i))) === nt),
    items.filter((i) => isLikelyDuplicateName(stripSuffix(fullName(i)), t)),
  ];
  if (!/\s/.test(t)) tiers.push(items.filter((i) => normalizeName(stripSuffix(lastName(i))) === nt));
  for (const tier of tiers) {
    const d = distinct(tier);
    if (d.length === 1) return { status: "one", item: d[0] };
    if (d.length > 1) return { status: "many" };
  }
  return { status: "none" };
}

const lastWord = (full: string) => full.trim().split(/\s+/).pop() ?? full;

export async function gradeNhlPlayerProp(pick: NhlPropPick, eventId: string, deps: NhlPropDeps = {}): Promise<NhlPropResolution> {
  const parsed = pick.betDetail ? parseNhlPlayerProp(pick.betDetail) : null;
  const market: NhlPropMarket | null = isNhlPropMarket(pick.propMarket) ? pick.propMarket : (parsed?.propMarket ?? null);
  if (!market) {
    return { outcome: null, reason: "this bet text isn't a recognized NHL prop market" };
  }

  const rawName = pick.playerName ?? parsed?.playerName ?? null;
  const playerName = rawName ? stripTeamNamesFromPlayerName(rawName, [pick.homeTeam, pick.awayTeam], "NHL") : "";
  if (!playerName) {
    return { outcome: null, reason: "couldn't identify a player name in the bet text" };
  }

  // Line markets need an Over/Under number. Stored betDetail is already N+
  // normalized at import; normalizing again covers legacy/manual text.
  let lineInfo: { line: number; direction: "OVER" | "UNDER" } | null = null;
  if (market !== "ANYTIME_GOAL" && market !== "FIRST_GOAL") {
    lineInfo = parsePlayerPropLine(normalizeNhlNPlus(pick.betDetail ?? ""));
    if (!lineInfo) return { outcome: null, reason: "couldn't find an Over/Under line in this bet text" };
  }

  const fetchBox = deps.fetchBox ?? fetchNhlBoxScore;
  const box = await fetchBox(eventId);
  if (!box) return { outcome: null, reason: "the box score isn't available yet for this game" };
  if (!box.isFinal) return { outcome: null, reason: "the box score isn't final yet for this game" };

  const notFound = { outcome: null, reason: 'couldn\'t find "' + playerName + '" in the box score' } as const;

  // FIRST_GOAL is decided by the game, not the player: no goal in periods 1-4
  // (0-0 into a shootout) is left for manual review, whoever the pick was on.
  if (market === "FIRST_GOAL" && box.goals.length === 0) {
    return { outcome: null, reason: "no goal was scored in regulation or overtime - needs manual grading" };
  }

  const isGoalieMarket = market === "SAVES";
  const skaterHit = matchByName(playerName, box.skaters, (r) => r.playerName, (r) => lastWord(r.playerName));
  const goalieHit = matchByName(playerName, box.goalies, (r) => r.playerName, (r) => lastWord(r.playerName));
  const own = isGoalieMarket ? goalieHit : skaterHit;
  const other = isGoalieMarket ? skaterHit : goalieHit;

  if (own.status === "many") {
    return { outcome: null, reason: '"' + playerName + '" matches more than one player in the box score' };
  }

  let playerId: string | null = null;
  if (own.status === "one") {
    playerId = own.item.espnPlayerId;
  } else if (other.status === "one") {
    // Right name, wrong side of the roster for this market (a skater on a
    // saves pick, or a goalie on a shots/points/assists/goal pick).
    return {
      outcome: null,
      reason:
        '"' + playerName + '" is a ' + (isGoalieMarket ? "skater" : "goalie") + " in this box score, which this market doesn't cover",
    };
  } else {
    // Not in the box score by name. Only an id-verified roster hit can prove
    // absence (or recover a name spelled differently from ESPN's).
    let roster: RosterPlayer[] = [];
    try {
      // Dynamic import: the prisma-backed cache is only loaded on this rare
      // path, and pure callers/tests that inject getRoster never touch prisma.
      const loadRoster = deps.getRoster ?? (async () => (await import("@/server/data/nhl-roster-cache")).getCachedNhlRoster());
      roster = await loadRoster();
    } catch (err) {
      console.error("gradeNhlPlayerProp: NHL roster read failed", err);
      return notFound;
    }
    const rosterHit = matchByName(playerName, roster, (r) => r.playerName, (r) => r.lastName);
    if (rosterHit.status !== "one") return notFound;
    const rp = rosterHit.item;
    const inSkaters = box.skaters.find((r) => r.espnPlayerId === rp.espnPlayerId);
    const inGoalies = box.goalies.find((r) => r.espnPlayerId === rp.espnPlayerId);
    if (isGoalieMarket ? inGoalies : inSkaters) {
      // Same player, different spelling than the box score's displayName.
      playerId = rp.espnPlayerId;
    } else if (inSkaters || inGoalies) {
      return { outcome: null, reason: '"' + playerName + '" is a ' + (isGoalieMarket ? "skater" : "goalie") + " in this box score, which this market doesn't cover" };
    } else {
      // Resolved to exactly one id and that id is not in the box score.
      const positionOk = isGoalieMarket ? rp.position === "G" : rp.position !== "G";
      const inThisGame = rp.team === box.homeTeam || rp.team === box.awayTeam;
      if (!positionOk || !inThisGame || !box.isComplete) return notFound;
      return { outcome: "PUSH" };
    }
  }

  if (market === "FIRST_GOAL") {
    const first = box.goals[0];
    if (!first.scorerId) {
      return { outcome: null, reason: "the first goal's scorer isn't identified in the play data - needs manual grading" };
    }
    return { outcome: first.scorerId === playerId ? "WIN" : "LOSS" };
  }

  if (isGoalieMarket) {
    const g = box.goalies.find((r) => r.espnPlayerId === playerId)!;
    return { outcome: gradeAgainstLine(g.saves, lineInfo!.line, lineInfo!.direction) };
  }

  const s = box.skaters.find((r) => r.espnPlayerId === playerId)!;
  if (market === "ANYTIME_GOAL") {
    const scored = s.goals > 0;
    const yes = nhlAnytimeGoalSide(pick.betDetail ?? "") === "YES";
    return { outcome: scored === yes ? "WIN" : "LOSS" };
  }
  const actual = market === "SHOTS_ON_GOAL" ? s.shotsOnGoal : market === "POINTS" ? s.goals + s.assists : s.assists;
  return { outcome: gradeAgainstLine(actual, lineInfo!.line, lineInfo!.direction) };
}
