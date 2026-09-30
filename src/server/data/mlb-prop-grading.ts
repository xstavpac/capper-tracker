// MLB player-prop grading: Over/Under and N+ lines on pitcher strikeouts and outs recorded, and
// hitter total bases, hits, walks, runs, RBIs and home runs. Wired into grading.ts's
// resolvePlayerProp for sportName === "MLB" only - the NFL and NHL grading paths are untouched.
// Same resolution shape as the NFL/NHL graders: { outcome } or { outcome: null, reason } where null
// keeps the pick PENDING (and `reason` feeds the pending-picks triage view).
//
// Source: the MLB Stats API box score (mlb-boxscore.ts); `eventId` is GameResult.externalId = gamePk.
//
// Stat rules (verified against 238 real box scores, see mlb-boxscore.ts):
//   STRIKEOUTS pitching.strikeOuts      OUTS_RECORDED pitching.outs (IP x 3)
//   TOTAL_BASES batting.totalBases      HITS batting.hits     WALKS batting.baseOnBalls
//   RUNS batting.runs                   RBIS batting.rbi      HOME_RUNS batting.homeRuns
//
// Absence / zero-stat policy (owner-specified):
//   - PITCHER markets require the named pitcher to have STARTED (gamesStarted = 1). A named pitcher
//     who did not start pushes - even if he later appeared in relief. A pitcher who started and
//     recorded 0 outs / 0 Ks is a real result and grades normally.
//   - HITTER contact markets (hits, total bases, home runs, RBIs) and WALKS: PA = 0 in a final box
//     score (or no batting line at all) pushes - the player did not bat. PA > 0 grades off the real
//     recorded value; a 0 there is a result, not an absence.
//   - RUNS grades off the recorded value regardless of PA (a pinch runner scores without one). A
//     player with no batting line at all did not play and pushes.
//   - TRUE ABSENCE: a typed name not found in the box score pushes ONLY when ALL hold: (1) the MLB
//     roster cache resolves it to EXACTLY ONE mlbPlayerId whose position fits the market, (2) the
//     game is final, (3) the box score is complete (both teams have batting and pitching lines),
//     (4) that id is absent from the box and the player's team is one of this game's two teams.
//     Anything else stays PENDING with the "couldn't find" reason.
// Position-aware: a hitter named on a K/outs line (batter strikeouts are not a market) and a pitcher
// named on a hitter market stay PENDING with an explicit reason - never graded as the wrong stat.
import { parsePlayerPropLine } from "@/lib/bet-line";
import { stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import {
  isMlbPaGatedMarket,
  isMlbPitcherMarket,
  isMlbPropMarket,
  mlbPositionFitsMarket,
  normalizeMlbNPlus,
  parseMlbPlayerProp,
  type MlbPropMarket,
} from "@/lib/mlb-prop";
import { matchMlbName } from "@/lib/mlb-name-match";
import { fetchMlbBoxScore, type MlbBoxPlayer, type MlbBoxScore } from "@/server/data/mlb-boxscore";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type MlbPropPick = {
  playerName: string | null;
  propMarket: string | null;
  betDetail: string | null;
  homeTeam: string;
  awayTeam: string;
};

export type MlbPropResolution = { outcome: "WIN" | "LOSS" | "PUSH" } | { outcome: null; reason: string };

export type MlbPropDeps = {
  fetchBox?: (gamePk: string) => Promise<MlbBoxScore | null>;
  // Lazily called - only when the player is missing from the box score, or (two-way check) named on
  // a pitcher market while showing no pitching line.
  getRoster?: () => Promise<RosterPlayer[]>;
};

// Same WIN/LOSS/PUSH rule as grading.ts's gradeAgainstLine (kept local so the NFL module is not
// touched): every MLB stat here is an integer, so a PUSH is only reachable on a whole-number line.
function gradeAgainstLine(actual: number, line: number, direction: "OVER" | "UNDER"): "WIN" | "LOSS" | "PUSH" {
  if (actual === line) return "PUSH";
  return actual > line === (direction === "OVER") ? "WIN" : "LOSS";
}

export async function gradeMlbPlayerProp(pick: MlbPropPick, gamePk: string, deps: MlbPropDeps = {}): Promise<MlbPropResolution> {
  const parsed = pick.betDetail ? parseMlbPlayerProp(pick.betDetail) : null;
  const market: MlbPropMarket | null = isMlbPropMarket(pick.propMarket) ? pick.propMarket : (parsed?.propMarket ?? null);
  if (!market) return { outcome: null, reason: "this bet text isn't a recognized MLB prop market" };

  const rawName = pick.playerName ?? parsed?.playerName ?? null;
  const playerName = rawName ? stripTeamNamesFromPlayerName(rawName, [pick.homeTeam, pick.awayTeam], "MLB") : "";
  if (!playerName) return { outcome: null, reason: "couldn't identify a player name in the bet text" };

  // Stored betDetail is already N+ normalized at import; normalizing again covers legacy/manual text.
  const lineInfo = parsePlayerPropLine(normalizeMlbNPlus(pick.betDetail ?? ""));
  if (!lineInfo) return { outcome: null, reason: "couldn't find an Over/Under line in this bet text" };

  const box = await (deps.fetchBox ?? fetchMlbBoxScore)(gamePk);
  if (!box) return { outcome: null, reason: "the box score isn't available yet for this game" };
  if (!box.isFinal) return { outcome: null, reason: "the box score isn't final yet for this game" };

  const pitcherMarket = isMlbPitcherMarket(market);
  const notFound = { outcome: null, reason: 'couldn\'t find "' + playerName + '" in the box score' } as const;
  const wrongSide = (): MlbPropResolution => ({
    outcome: null,
    reason: pitcherMarket
      ? '"' + playerName + '" is a hitter in this box score - only pitcher strikeouts and outs recorded are graded (not batter strikeouts)'
      : '"' + playerName + '" is a pitcher in this box score, which this market doesn\'t cover',
  });

  // Does a box-score row belong on this market's side? A pitcher market wants someone who pitched or
  // is a listed pitcher; a hitter market wants anyone who is not a pure pitcher. A pitcher CAN carry a
  // zero batting line (every pitcher who enters a game shows atBats 0 / PA 0 - verified), so only a
  // batting line with a real plate appearance makes a "P" a hitter here (a two-way player or a position
  // player who pitched).
  const fits = (p: MlbBoxPlayer) =>
    pitcherMarket ? p.pitching !== null || p.position === "P" : p.position !== "P" || (p.batting?.plateAppearances ?? 0) > 0;
  const id = (p: MlbBoxPlayer) => p.mlbPlayerId;
  const name = (p: MlbBoxPlayer) => p.playerName;
  const own = matchMlbName(playerName, box.players.filter(fits), id, name);
  const other = matchMlbName(playerName, box.players.filter((p) => !fits(p)), id, name);

  if (own.status === "many") return { outcome: null, reason: '"' + playerName + '" matches more than one player in the box score' };

  let roster: RosterPlayer[] | null = null;
  const loadRoster = async (): Promise<RosterPlayer[] | null> => {
    if (roster) return roster;
    try {
      // Dynamic import: the prisma-backed cache is only loaded on this rare path, and pure callers/tests
      // that inject getRoster never touch prisma.
      const load = deps.getRoster ?? (async () => (await import("@/server/data/mlb-roster-cache")).getCachedMlbRoster());
      roster = await load();
    } catch (err) {
      console.error("gradeMlbPlayerProp: MLB roster read failed", err);
      return null;
    }
    return roster;
  };

  let player: MlbBoxPlayer | null = null;
  if (own.status === "one") {
    player = own.item;
  } else if (other.status === "one") {
    // Right name, wrong side of the roster for this market. The one legitimate crossover: a two-way
    // player (roster position TWP) named on a pitcher market on a day he only hit - he didn't start
    // as a pitcher, so the pick pushes. Proven by the roster, never by the box position alone.
    let twoWay = false;
    if (pitcherMarket) {
      const r = await loadRoster();
      twoWay = !!r?.some((rp) => rp.externalPlayerId === other.item.mlbPlayerId && rp.position === "TWP");
    }
    if (!twoWay) return wrongSide();
    player = other.item;
  } else {
    // Not in the box by name. Only an id-verified roster hit can prove absence (or recover a name
    // spelled differently from the box's).
    const r = await loadRoster();
    if (!r) return notFound;
    const rosterHit = matchMlbName(
      playerName,
      r.filter((rp) => mlbPositionFitsMarket(rp.position, market)),
      (rp) => rp.externalPlayerId,
      (rp) => rp.playerName
    );
    if (rosterHit.status !== "one") return notFound;
    const rp = rosterHit.item;
    const inBox = box.players.find((p) => p.mlbPlayerId === rp.externalPlayerId);
    if (inBox) {
      player = inBox; // same player, different spelling than the box's fullName
    } else {
      // Resolved to exactly one id and that id is not in the box score.
      const inThisGame = rp.team === box.homeTeam || rp.team === box.awayTeam;
      if (!inThisGame || !box.isComplete) return notFound;
      return { outcome: "PUSH" };
    }
  }

  if (pitcherMarket) {
    const pit = player.pitching;
    // Named pitcher must have started; a reliever appearance (or none) voids the pick.
    if (!pit || pit.gamesStarted < 1) return { outcome: "PUSH" };
    return { outcome: gradeAgainstLine(market === "STRIKEOUTS" ? pit.strikeouts : pit.outs, lineInfo.line, lineInfo.direction) };
  }

  const bat = player.batting;
  if (!bat) return { outcome: "PUSH" }; // in the box (active roster) but never played
  if (isMlbPaGatedMarket(market) && bat.plateAppearances === 0) return { outcome: "PUSH" }; // did not bat
  const actual =
    market === "TOTAL_BASES"
      ? bat.totalBases
      : market === "HITS"
        ? bat.hits
        : market === "WALKS"
          ? bat.walks
          : market === "RUNS"
            ? bat.runs
            : market === "RBIS"
              ? bat.rbis
              : bat.homeRuns;
  return { outcome: gradeAgainstLine(actual, lineInfo.line, lineInfo.direction) };
}
