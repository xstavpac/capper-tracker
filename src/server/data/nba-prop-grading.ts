// NBA player-prop grading: Over/Under and N+ lines on points, rebounds, assists,
// threes made, steals, blocks and the four combined markets (PRA, P+R, P+A,
// R+A); double-double (yes/no shaped). Wired into grading.ts's resolvePlayerProp
// for sportName === "NBA" only - the NFL, NHL and MLB paths are untouched. The
// NBA twin of nhl-prop-grading.ts, same resolution shape: { outcome } or
// { outcome: null, reason } where null keeps the pick PENDING (and `reason`
// feeds the pending-picks triage view).
//
// POINTS and ASSISTS are enum values the NHL shares (nba-prop.ts). This module is
// only ever reached for an NBA pick, so they are read as basketball stats here.
//
// Box-score facts this relies on (verified live, see nba-boxscore.ts): stats are
// read by ESPN's `keys`; threes made is the made half of the 3PT column; a player
// who did not play is LISTED with didNotPlay: true and no stats, or is absent.
//
// Did-not-play policy (the NHL rule, adapted to ESPN listing DNPs): a pick
// resolves PUSH (stake returned) ONLY when ALL hold:
//   1. the NBA roster cache resolves the typed name to EXACTLY ONE player id
//      (league-wide, so a name that could be two players never pushes),
//   2. the game is final,
//   3. that id is in this box score marked did-not-play - or, absent from it,
//      the box score is complete and that player's team is one of the two
//      teams in this game.
// Anything else - a name-only miss, an ambiguous roster hit, a partial box
// score, a DNP row the roster can't tie to one id - stays PENDING with a reason.
import { isLikelyDuplicateName, normalizeName } from "@/lib/fuzzy-match";
import { parsePlayerPropLine } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import { isNbaPropMarket, nbaDoubleDoubleSide, normalizeNbaNPlus, parseNbaProp, type NbaPropMarket } from "@/lib/nba-prop";
import { fetchNbaBoxScore, type NbaBoxScore, type NbaPlayerRow } from "@/server/data/nba-boxscore";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type NbaPropPick = {
  playerName: string | null;
  propMarket: string | null;
  betDetail: string | null;
  homeTeam: string;
  awayTeam: string;
};

export type NbaPropResolution = { outcome: "WIN" | "LOSS" | "PUSH" } | { outcome: null; reason: string };

export type NbaPropDeps = {
  fetchBox?: (eventId: string) => Promise<NbaBoxScore | null>;
  // Lazily called - only when the name can't be graded from the box score alone.
  getRoster?: () => Promise<RosterPlayer[]>;
};

// Same WIN/LOSS/PUSH rule as grading.ts's gradeAgainstLine (kept local so the
// NFL module is not touched): every NBA stat here is an integer, so a PUSH is
// only reachable on a whole-number line.
function gradeAgainstLine(actual: number, line: number, direction: "OVER" | "UNDER"): "WIN" | "LOSS" | "PUSH" {
  if (actual === line) return "PUSH";
  return actual > line === (direction === "OVER") ? "WIN" : "LOSS";
}

function stripSuffix(name: string): string {
  return name.replace(/\s+(jr\.?|sr\.?|II|III|IV|V)$/i, "").trim();
}

// normalizeName drops every non a-z character, so an accented letter would
// vanish ("Jokić" -> "joki") instead of matching its plain form. Fold first.
function fold(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

type NameMatch<T> = { status: "one"; item: T } | { status: "many" } | { status: "none" };

// Exact normalized full name -> fuzzy full name -> (single typed token only)
// bare surname; each tier counts only if it narrows to exactly one distinct
// player id. Same tier policy as nhl-prop-grading.ts / player-roster-fallback.ts.
function matchByName<T>(typed: string, items: T[], id: (i: T) => string, fullName: (i: T) => string, lastName: (i: T) => string): NameMatch<T> {
  const t = stripSuffix(fold(typed));
  const nt = normalizeName(t);
  const distinct = (xs: T[]) => [...new Map(xs.map((x) => [id(x), x])).values()];
  const tiers: T[][] = [
    items.filter((i) => normalizeName(stripSuffix(fold(fullName(i)))) === nt),
    items.filter((i) => isLikelyDuplicateName(stripSuffix(fold(fullName(i))), t)),
  ];
  if (!/\s/.test(t)) tiers.push(items.filter((i) => normalizeName(stripSuffix(fold(lastName(i)))) === nt));
  for (const tier of tiers) {
    const d = distinct(tier);
    if (d.length === 1) return { status: "one", item: d[0] };
    if (d.length > 1) return { status: "many" };
  }
  return { status: "none" };
}

const lastWord = (full: string) => stripSuffix(full).trim().split(/\s+/).pop() ?? full;

function statFor(row: NbaPlayerRow, market: Exclude<NbaPropMarket, "DOUBLE_DOUBLE">): number {
  switch (market) {
    case "POINTS":
      return row.points;
    case "REBOUNDS":
      return row.rebounds;
    case "ASSISTS":
      return row.assists;
    case "THREES_MADE":
      return row.threesMade;
    case "STEALS":
      return row.steals;
    case "BLOCKS":
      return row.blocks;
    case "POINTS_REBOUNDS_ASSISTS":
      return row.points + row.rebounds + row.assists;
    case "POINTS_REBOUNDS":
      return row.points + row.rebounds;
    case "POINTS_ASSISTS":
      return row.points + row.assists;
    case "REBOUNDS_ASSISTS":
      return row.rebounds + row.assists;
  }
}

// 10+ in at least two of points, rebounds, assists, steals, blocks.
export function isDoubleDouble(row: NbaPlayerRow): boolean {
  return [row.points, row.rebounds, row.assists, row.steals, row.blocks].filter((v) => v >= 10).length >= 2;
}

export async function gradeNbaPlayerProp(pick: NbaPropPick, eventId: string, deps: NbaPropDeps = {}): Promise<NbaPropResolution> {
  const parsed = pick.betDetail ? parseNbaProp(pick.betDetail) : null;
  const market: NbaPropMarket | null = isNbaPropMarket(pick.propMarket) ? pick.propMarket : (parsed?.propMarket ?? null);
  if (!market) {
    // An NBA prop this app recognizes but has no grader for (triple-double,
    // turnovers, first basket, ...) says so; anything else is not an NBA prop.
    if (parsed?.unsupported) return { outcome: null, reason: parsed.unsupported };
    return { outcome: null, reason: "this bet text isn't a recognized NBA prop market" };
  }

  const rawName = pick.playerName ?? parsed?.playerName ?? null;
  const playerName = rawName ? stripTeamNamesFromPlayerName(rawName, [pick.homeTeam, pick.awayTeam], "NBA") : "";
  if (!playerName) {
    return { outcome: null, reason: "couldn't identify a player name in the bet text" };
  }

  // Line markets need an Over/Under number. Stored betDetail is already N+
  // normalized at import; normalizing again covers legacy/manual text.
  let lineInfo: { line: number; direction: "OVER" | "UNDER" } | null = null;
  if (market !== "DOUBLE_DOUBLE") {
    lineInfo = parsePlayerPropLine(normalizeNbaNPlus(pick.betDetail ?? ""));
    if (!lineInfo) return { outcome: null, reason: "couldn't find an Over/Under line in this bet text" };
  }

  const fetchBox = deps.fetchBox ?? fetchNbaBoxScore;
  const box = await fetchBox(eventId);
  if (!box) return { outcome: null, reason: "the box score isn't available yet for this game" };
  if (!box.isFinal) return { outcome: null, reason: "the box score isn't final yet for this game" };

  const notFound = { outcome: null, reason: 'couldn\'t find "' + playerName + '" in the box score' } as const;

  // The roster is read at most once, and only on the paths that need it.
  let rosterCache: RosterPlayer[] | null = null;
  const rosterMatch = async (): Promise<NameMatch<RosterPlayer> | null> => {
    if (!rosterCache) {
      try {
        // Dynamic import: the prisma-backed cache is only loaded on this rare
        // path, and pure callers/tests that inject getRoster never touch prisma.
        const loadRoster = deps.getRoster ?? (async () => (await import("@/server/data/nba-roster-cache")).getCachedNbaGradingRoster());
        rosterCache = await loadRoster();
      } catch (err) {
        console.error("gradeNbaPlayerProp: NBA roster read failed", err);
        return null;
      }
    }
    return matchByName(playerName, rosterCache, (r) => r.externalPlayerId, (r) => r.playerName, (r) => r.lastName);
  };

  const boxHit = matchByName(playerName, box.players, (r) => r.espnPlayerId, (r) => r.playerName, (r) => lastWord(r.playerName));
  if (boxHit.status === "many") {
    return { outcome: null, reason: '"' + playerName + '" matches more than one player in the box score' };
  }

  let row: NbaPlayerRow;
  if (boxHit.status === "one") {
    row = boxHit.item;
    if (row.didNotPlay) {
      // Listed as did-not-play. Push only when the roster ties the typed name to
      // exactly this one player id - a surname that is also someone else's in
      // the league is not proof the pick was on this player.
      const rh = await rosterMatch();
      if (rh?.status === "one" && rh.item.externalPlayerId === row.espnPlayerId) return { outcome: "PUSH" };
      return {
        outcome: null,
        reason: '"' + playerName + '" matches ' + row.playerName + ", who did not play, but the NBA roster can't confirm that's the only player this name could be - needs manual grading",
      };
    }
  } else {
    // Not in the box score by name. Only an id-verified roster hit can prove
    // absence (or recover a name spelled differently from ESPN's).
    const rh = await rosterMatch();
    if (!rh || rh.status !== "one") return notFound;
    const rp = rh.item;
    const inBox = box.players.find((r) => r.espnPlayerId === rp.externalPlayerId);
    if (inBox) {
      if (inBox.didNotPlay) return { outcome: "PUSH" };
      row = inBox;
    } else {
      const inThisGame = rp.team === box.homeTeam || rp.team === box.awayTeam;
      if (!inThisGame || !box.isComplete) return notFound;
      return { outcome: "PUSH" };
    }
  }

  if (market === "DOUBLE_DOUBLE") {
    const yes = nbaDoubleDoubleSide(pick.betDetail ?? "") === "YES";
    return { outcome: isDoubleDouble(row) === yes ? "WIN" : "LOSS" };
  }
  return { outcome: gradeAgainstLine(statFor(row, market), lineInfo!.line, lineInfo!.direction) };
}
