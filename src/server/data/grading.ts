import { prisma } from "@/lib/prisma";
import type { GameResult, Pick, PickedSide } from "@prisma/client";
import {
  getLiveScoresForSport,
  getOddsForSport,
  getMlbEarlyInningScores,
  getNflGameFacts,
  getNcaafFirstHalfScore,
  getNbaFirstHalfScore,
  getNflPlayerTdStats,
  type OddsGame,
} from "@/server/data/odds";
import { closestByTime, sameEasternDay } from "@/lib/dates";
import { extractLine, parseTouchdownProp, nrfiSide } from "@/lib/bet-line";
import { findTeamNickname, NCAAF_CANONICAL_SUFFIX } from "@/lib/parse-catalog";
import { isLikelyDuplicateName } from "@/lib/fuzzy-match";

function findMarket(game: OddsGame, key: string) {
  for (const b of game.bookmakers) {
    const m = b.markets.find((m) => m.key === key);
    if (m) return m;
  }
  return undefined;
}

// Derives the team-trend ledger fields (see schema.prisma's GameResult
// comment) from whichever odds snapshot is already cached for this sport
// today - the SAME cache getOddsForSport always uses, not a separate fetch.
// Not a rigorous closing line (see the schema comment); still the best data
// this app captures today. Returns nulls when the game isn't in that
// snapshot at all (e.g. the day's fetch was missed), no candidate falls on
// the same Eastern day as referenceTime, or neither market has usable
// outcomes.
//
// oddsGames is no longer pre-narrowed to today/tomorrow by getOddsForSport
// (it can now hold a full week of NFL games) - so this does its own
// same-day scoping here, then closestByTime to disambiguate same-team
// rematches within that day, same disambiguation resolveOddsGame already
// uses. referenceTime should be the actual finished game's own commenceTime
// (what the caller has on hand), not "now" - grading can run well after the
// game itself.
function deriveLedgerFields(
  oddsGames: OddsGame[],
  homeTeam: string,
  awayTeam: string,
  referenceTime: Date
): { favTeam: string | null; totalLine: number | null } {
  const candidates = oddsGames.filter((g) => g.homeTeam === homeTeam && g.awayTeam === awayTeam);
  const sameDay = candidates.filter((g) => sameEasternDay(new Date(g.commenceTime), referenceTime));
  if (sameDay.length === 0) return { favTeam: null, totalLine: null };
  const match = closestByTime(sameDay, (g) => new Date(g.commenceTime).getTime(), referenceTime.getTime());

  const h2h = findMarket(match, "h2h");
  const homeOutcome = h2h?.outcomes.find((o) => o.name === match.homeTeam);
  const awayOutcome = h2h?.outcomes.find((o) => o.name === match.awayTeam);
  const favTeam =
    homeOutcome && awayOutcome ? (homeOutcome.price < awayOutcome.price ? match.homeTeam : match.awayTeam) : null;

  const totals = findMarket(match, "totals");
  const totalLine = totals?.outcomes.find((o) => o.point !== undefined)?.point ?? null;

  return { favTeam, totalLine };
}

// Persists final scores for a sport's finished games into GameResult, so
// gradePendingPicks has something to grade against. First-half scores are
// only captured for sports with a free box-score-by-half source wired up
// (MLB's innings-1-5, NFL/NCAAF/NBA's Q1+Q2) - period=FIRST_HALF picks in
// every other sport just won't match (see gradePendingPicks) until one is
// built for them too. All four write into the SAME firstFiveHomeScore/
// AwayScore columns - the column names are MLB-flavored (this app's first
// use), but resolveOutcome below already reads them generically for any
// sport's period=FIRST_HALF pick, so none of the other three needed their
// own columns.
export async function persistFinalScores(sportKey: string): Promise<number> {
  const games = await getLiveScoresForSport(sportKey);
  const finals = games.filter((g) => g.status === "final" && g.scores);
  const supportsFirstFive = sportKey === "baseball_mlb";
  const supportsFirstHalf =
    sportKey === "americanfootball_nfl" || sportKey === "americanfootball_ncaaf" || sportKey === "basketball_nba";

  // Same daily cache getOddsForSport always serves elsewhere - fetched once
  // for this whole batch (not per-game) to derive the team-trend ledger
  // fields below. A cache hit costs nothing extra; a miss just means no
  // ledger fields for this batch, same as any other day the fetch failed.
  const oddsGames = await getOddsForSport(sportKey);

  // Each game's persist is independent - was previously a sequential for-loop,
  // which meant a day with many newly-final games (each potentially needing a
  // first-five fetch against MLB's heavier live-feed endpoint) made every
  // Picks page load wait on the sum of all of them instead of the slowest one.
  const results = await Promise.all(
    finals.map(async (g) => {
      const homeScore = g.scores!.find((s) => s.name === g.homeTeam)?.score;
      const awayScore = g.scores!.find((s) => s.name === g.awayTeam)?.score;
      if (homeScore === undefined || awayScore === undefined) return false;

      const existing = await prisma.gameResult.findUnique({
        where: { sportKey_externalId: { sportKey, externalId: g.id } },
      });

      // Early-inning scores are immutable once captured, and fetching them hits the
      // heavier live-feed endpoint - only fetch what's still missing. Checking both
      // fields (not just firstFive) matters for GameResult rows persisted before
      // first-inning capture existed - those already have firstFive set, so a
      // firstFive-only check would skip them and leave firstInning null forever.
      const needsEarlyInnings =
        supportsFirstFive && (!existing || existing.firstFiveHomeScore === null || existing.firstInningHomeScore === null);
      const early = needsEarlyInnings ? await getMlbEarlyInningScores(g.id) : null;
      const firstInning = early?.firstInning ?? null;

      // Same "only fetch what's still missing, values are immutable once a
      // game is final" reasoning as MLB's early innings above. NFL, NCAAF,
      // and NBA each have their own ESPN summary endpoint (different sport
      // path), so which fetcher runs depends on sportKey - not a shared
      // function, matching getNflGameFacts/getNcaafFirstHalfScore/
      // getNbaFirstHalfScore's own precedent of one function per sport
      // rather than a generic dispatcher.
      const needsFirstHalf = supportsFirstHalf && (!existing || existing.firstFiveHomeScore === null);

      // NFL Game Pulse fields (see nfl-game-pulse-situations.ts) - gated
      // independently of needsFirstHalf since a row captured before this
      // shipped may already have firstFiveHomeScore set but still be
      // missing these. All three come from the same summary-endpoint fetch
      // (getNflGameFacts), so they're gated as one bundle rather than
      // separately - "any of them still missing" is enough to justify the
      // one fetch that fills in all three at once.
      const needsNflGamePulseFacts =
        sportKey === "americanfootball_nfl" &&
        (!existing || existing.quartersJson === null || existing.scoringPlaysJson === null || existing.homeTurnovers === null);

      // One fetch covers both needs for NFL - the old getNflFirstHalfScore
      // hit this same summary endpoint on its own just for Q1+Q2; folding
      // that into getNflGameFacts means a game needing both first-half
      // grading AND Game Pulse capture (the common case for any newly-final
      // NFL game) makes one request instead of two.
      const nflFacts =
        sportKey === "americanfootball_nfl" && (needsFirstHalf || needsNflGamePulseFacts)
          ? await getNflGameFacts(g.id)
          : null;

      const espnFirstHalf = needsFirstHalf
        ? sportKey === "americanfootball_nfl"
          ? nflFacts?.firstHalf ?? null
          : sportKey === "americanfootball_ncaaf"
            ? await getNcaafFirstHalfScore(g.id)
            : await getNbaFirstHalfScore(g.id)
        : null;

      const firstHalfHome = early?.firstFive?.home ?? espnFirstHalf?.home ?? null;
      const firstHalfAway = early?.firstFive?.away ?? espnFirstHalf?.away ?? null;

      // undefined (matching inningsJson's own convention just below, and
      // Prisma's JSON-field typing, which rejects a literal null here in
      // favor of Prisma.JsonNull/omission) when not fetched this run OR the
      // fetch didn't return usable data - the update spread only writes a
      // field when it has a real value, so an existing row's already-set
      // column is left untouched either way; a brand-new row with no value
      // yet gets an implicit NULL from omitting the key, and picks the data
      // up on a later run once ESPN has it.
      const quartersJson = needsNflGamePulseFacts ? (nflFacts?.quarters ?? undefined) : undefined;
      const scoringPlaysJson = needsNflGamePulseFacts ? (nflFacts?.scoringPlays ?? undefined) : undefined;
      // Turnovers is a plain Int, not an array/object - 0 is a common, valid
      // value (a team with a clean game), so the update-gate below checks
      // `!== null` rather than truthiness, unlike quartersJson/scoringPlaysJson.
      const homeTurnovers = needsNflGamePulseFacts ? (nflFacts?.turnovers?.home ?? null) : null;
      const awayTurnovers = needsNflGamePulseFacts ? (nflFacts?.turnovers?.away ?? null) : null;

      // g.innings already comes for free with the same schedule-API fetch
      // getLiveScoresForSport just made (see getMlbLiveScores) - no separate
      // "needs" gate or extra fetch required, unlike firstInning/firstHalf
      // above. MLB-only; g.innings is always null for every other sport.
      const inningsJson = g.innings ?? undefined;

      // Same immutable-once-set reasoning as the first-half fields above -
      // only derive when this row doesn't already have a favTeam.
      const needsLedgerFields = !existing || existing.favTeam === null;
      const ledger = needsLedgerFields
        ? deriveLedgerFields(oddsGames, g.homeTeam, g.awayTeam, new Date(g.commenceTime))
        : null;
      const ledgerHasData = ledger && (ledger.favTeam !== null || ledger.totalLine !== null);

      await prisma.gameResult.upsert({
        where: { sportKey_externalId: { sportKey, externalId: g.id } },
        update: {
          homeScore: parseInt(homeScore, 10),
          awayScore: parseInt(awayScore, 10),
          ...(firstHalfHome !== null ? { firstFiveHomeScore: firstHalfHome, firstFiveAwayScore: firstHalfAway } : {}),
          ...(firstInning
            ? { firstInningHomeScore: firstInning.home, firstInningAwayScore: firstInning.away }
            : {}),
          ...(inningsJson ? { inningsJson } : {}),
          ...(quartersJson ? { quartersJson } : {}),
          ...(scoringPlaysJson ? { scoringPlaysJson } : {}),
          ...(homeTurnovers !== null ? { homeTurnovers, awayTurnovers } : {}),
          ...(ledgerHasData
            ? { favTeam: ledger!.favTeam, totalLine: ledger!.totalLine, lineSource: "odds_snapshot" }
            : {}),
        },
        create: {
          sportKey,
          externalId: g.id,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          homeScore: parseInt(homeScore, 10),
          awayScore: parseInt(awayScore, 10),
          firstFiveHomeScore: firstHalfHome,
          firstFiveAwayScore: firstHalfAway,
          firstInningHomeScore: firstInning?.home ?? null,
          firstInningAwayScore: firstInning?.away ?? null,
          inningsJson,
          quartersJson,
          scoringPlaysJson,
          homeTurnovers,
          awayTurnovers,
          gameDate: new Date(g.commenceTime),
          favTeam: ledger?.favTeam ?? null,
          totalLine: ledger?.totalLine ?? null,
          lineSource: ledgerHasData ? "odds_snapshot" : null,
        },
      });
      return true;
    })
  );

  return results.filter(Boolean).length;
}

function teamNickname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

// Reverse of NCAAF_CANONICAL_SUFFIX (parse-catalog.ts): real full team name
// ("alabama crimson tide") -> bare school key ("alabama") - null for every
// team outside the curated 68. teamNickname() above (the mascot / last word)
// is what a capper types for every other sport, but NCAAF bettors just as
// often name the SCHOOL ("Alabama ML", "Ohio State -7") - a real gap found
// during the pre-launch grading investigation: identical bet, identical
// game, "Crimson Tide ML" graded fine while "Alabama ML" stayed ungraded
// forever, since the text-match fallback below only ever checked the mascot.
const NCAAF_SCHOOL_BY_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(NCAAF_CANONICAL_SUFFIX).map(([school, canonical]) => [canonical, school])
);

function ncaafSchoolKey(fullName: string): string | null {
  return NCAAF_SCHOOL_BY_CANONICAL[fullName.trim().toLowerCase()] ?? null;
}

// Whether `detail` names `school`, guarding against the same nested-name
// problem parse-catalog.ts's detectSport already solves for import parsing
// (e.g. "arizona" is a whole word inside "arizona state", "virginia" inside
// "west virginia") - scoped here to just this one pick's two actual teams
// rather than all 68 schools, since gradePick only ever has two candidates
// to tell apart. A match only counts when the OTHER team's school name isn't
// ALSO present as the more specific (longer) match at the same word - e.g.
// "Arizona State ML" must resolve to Arizona State only, never spuriously
// flag Arizona too just because "arizona" is a literal substring of it.
function matchesSchoolName(detail: string, school: string, otherSchool: string | null): boolean {
  const re = new RegExp("\\b" + school.replace(/ /g, "\\s+") + "\\b");
  if (!re.test(detail)) return false;
  if (otherSchool && otherSchool.length > school.length && otherSchool.includes(school)) {
    const otherRe = new RegExp("\\b" + otherSchool.replace(/ /g, "\\s+") + "\\b");
    if (otherRe.test(detail)) return false;
  }
  return true;
}

type GradeOutcome = "WIN" | "LOSS" | "PUSH" | null;

export function gradePick(
  betType: string,
  betDetail: string,
  line: number | null,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number,
  // Which side this pick landed on, captured once at import time (see
  // schema.prisma's Pick.pickedSide comment) - authoritative when present,
  // since resolveGameAndOdds already refused to set it for anything
  // ambiguous. Falls back to the text-match heuristic below only for picks
  // that predate this field (pickedSide null/undefined).
  pickedSide?: PickedSide | null
): GradeOutcome {
  const detail = betDetail.toLowerCase();
  const homeNick = teamNickname(homeTeam);
  const awayNick = teamNickname(awayTeam);

  let pickedHome: boolean;
  let pickedAway: boolean;
  if (pickedSide) {
    pickedHome = pickedSide === "HOME";
    pickedAway = pickedSide === "AWAY";
  } else {
    // Same-mascot matchup (e.g. Clemson Tigers @ LSU Tigers) - homeNick and
    // awayNick are identical, so detail.includes() would match BOTH sides at
    // once and silently grade off whichever branch runs first below. No two
    // teams share a mascot in any other sport this app grades today, so this
    // only ever fires for a same-mascot NCAAF matchup with no pickedSide on
    // record - forcing both flags false here makes every branch below fall
    // through to its safe "can't tell which side was picked" null/PUSH-on-tie
    // path instead of guessing.
    const sameMascot = homeNick === awayNick;

    // School-name match is independent of the sameMascot guard above (and
    // must stay that way): Duke Blue Devils and Arizona State Sun Devils
    // share a mascot ("Devils"), but their SCHOOL names ("duke"/"arizona
    // state") don't collide at all, so "Duke ML" can - and should - still
    // grade correctly even though "Devils ML" correctly can't. Resolves to
    // null (not the mascot) for every non-NCAAF team, so this is a no-op
    // everywhere else.
    const homeSchool = ncaafSchoolKey(homeTeam);
    const awaySchool = ncaafSchoolKey(awayTeam);
    const homeSchoolMatch = homeSchool !== null && matchesSchoolName(detail, homeSchool, awaySchool);
    const awaySchoolMatch = awaySchool !== null && matchesSchoolName(detail, awaySchool, homeSchool);

    pickedHome = (!sameMascot && detail.includes(homeNick)) || homeSchoolMatch;
    pickedAway = (!sameMascot && detail.includes(awayNick)) || awaySchoolMatch;
  }

  if (betType === "MONEYLINE") {
    if (pickedHome && homeScore > awayScore) return "WIN";
    if (pickedHome && homeScore < awayScore) return "LOSS";
    if (pickedAway && awayScore > homeScore) return "WIN";
    if (pickedAway && awayScore < homeScore) return "LOSS";
    if (homeScore === awayScore) return "PUSH";
    return null;
  }

  if (betType === "SPREAD") {
    // Prefer the line stored at pick-creation time; older picks fall back to
    // regex-parsing it out of the free-text betDetail.
    const spread = line ?? extractLine("SPREAD", detail);
    if (spread === null) return null;

    if (pickedHome) {
      const adjusted = homeScore + spread;
      if (adjusted > awayScore) return "WIN";
      if (adjusted < awayScore) return "LOSS";
      return "PUSH";
    }
    if (pickedAway) {
      const adjusted = awayScore + spread;
      if (adjusted > homeScore) return "WIN";
      if (adjusted < homeScore) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  if (betType === "TOTAL") {
    const totalLine = line ?? extractLine("TOTAL", detail);
    if (totalLine === null) return null;
    const actual = homeScore + awayScore;
    const isOver = detail.includes("over");
    const isUnder = detail.includes("under");

    if (isOver) {
      if (actual > totalLine) return "WIN";
      if (actual < totalLine) return "LOSS";
      return "PUSH";
    }
    if (isUnder) {
      if (actual < totalLine) return "WIN";
      if (actual > totalLine) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  if (betType === "TEAM_TOTAL") {
    // A team total is ONE team's own score vs a line - never the combined
    // score TOTAL uses above. Reuses the exact same pickedHome/pickedAway
    // (pickedSide when present, else the mascot/school-name text-match
    // fallback) every other team-specific bet type already relies on, so a
    // team total's side is resolved identically to how a Moneyline/Spread
    // pick's side is - not a separate, parallel mechanism. Confirmed as a
    // real, already-happened bug during the Team Total investigation: 7 real
    // logged team-total picks had been silently graded against the combined
    // score (TOTAL's logic) before this branch existed.
    const totalLine = line ?? extractLine("TEAM_TOTAL", detail);
    if (totalLine === null) return null;
    const teamScore = pickedHome ? homeScore : pickedAway ? awayScore : null;
    if (teamScore === null) return null;
    const isOver = detail.includes("over");
    const isUnder = detail.includes("under");

    if (isOver) {
      if (teamScore > totalLine) return "WIN";
      if (teamScore < totalLine) return "LOSS";
      return "PUSH";
    }
    if (isUnder) {
      if (teamScore < totalLine) return "WIN";
      if (teamScore > totalLine) return "LOSS";
      return "PUSH";
    }
    return null;
  }

  if (betType === "NRFI") {
    // Binary market on combined (both teams') first-inning runs - no push.
    // homeScore/awayScore here are the game's first-inning scores, not final
    // (see gradePendingPicks, which selects the score source by betType).
    const runsScored = homeScore + awayScore;
    const side = nrfiSide(detail);

    if (side === "NO_RUN") return runsScored === 0 ? "WIN" : "LOSS";
    if (side === "YES_RUN") return runsScored > 0 ? "WIN" : "LOSS";
    return null;
  }

  return null;
}

function closestByDate<T extends { gameDate: Date }>(items: T[], reference: Date): T {
  return closestByTime(items, (item) => item.gameDate.getTime(), reference.getTime());
}

type GameMatch = { game: GameResult; matchType: "exact" | "fuzzy" };

// How close a GameResult's actual gameDate must be to a pick's own gameTime
// to be treated as the SAME game, not just the same two teams. The same
// matchup can appear multiple times within the ±2-day candidate window below
// (an MLB series is 2-4 consecutive-day games against the same opponent, all
// sharing identical home/away team names) - team names alone can't tell them
// apart. 6 hours is tight enough to reject "a different day's game in this
// series" (typically ~24h apart) while still tolerating the normal slop
// between a pick's recorded gameTime and the game's real start (rain delays,
// odds-API-vs-schedule discrepancies). A postponed-and-replayed-next-day game
// will correctly fail to match here and stay Pending rather than risk
// grading against the wrong day. Also exported for matchPicksToGame
// (picks.ts), which has this exact same "same matchup, which day's game"
// ambiguity when attaching picks to a game card on the Live page.
export const MAX_GAME_TIME_DRIFT_MS = 6 * 3600000;

function withinDrift<T extends { gameDate: Date }>(candidates: T[], reference: Date): T[] {
  return candidates.filter((c) => Math.abs(c.gameDate.getTime() - reference.getTime()) <= MAX_GAME_TIME_DRIFT_MS);
}

// Pure (no DB I/O) matching core, shared by findMatchingGameResult (single pick,
// fetches its own ±2-day candidate pool) and gradeAllPendingPicks (many picks
// against one pre-fetched pool spanning all of them) - same exact/fuzzy logic
// either way, just filtered from a wider in-memory array instead of a per-pick
// query, so a bulk grading run can't silently match differently than a single
// page-load grade would have.
export function matchGameResult(
  candidates: GameResult[],
  pick: {
    gameTime: Date;
    homeTeam: string;
    awayTeam: string;
    betDetail: string | null;
  }
): GameMatch | null {
  const windowStart = pick.gameTime.getTime() - 2 * 86400000;
  const windowEnd = pick.gameTime.getTime() + 2 * 86400000;
  const inWindow = candidates.filter((c) => {
    const t = c.gameDate.getTime();
    return t >= windowStart && t < windowEnd;
  });
  if (inWindow.length === 0) return null;

  // Picks resolved to a real game on import (see resolveGameForNickname) carry the
  // exact team names, so prefer an exact match over the fuzzy text search below.
  // Also requires the matched game to actually be THIS game, not just the same
  // two teams on some other day within the window - see MAX_GAME_TIME_DRIFT_MS.
  const exact = withinDrift(
    inWindow.filter((c) => c.homeTeam === pick.homeTeam && c.awayTeam === pick.awayTeam),
    pick.gameTime
  );
  if (exact.length > 0) return { game: closestByDate(exact, pick.gameTime), matchType: "exact" };

  // Legacy/manual picks may only have raw text in homeTeam/betDetail - fall back to
  // matching by team nickname substring. Requires BOTH teams' nicknames to appear,
  // not just one - matching on a single side let this latch onto a candidate that
  // shares one team but is actually a different matchup entirely (e.g. a pick's own
  // game result hasn't been persisted yet, so this fell through to some other game
  // that same team played on an adjacent day, against a different opponent, and
  // silently graded against that instead). Requiring both sides keeps the fallback
  // scoped to "this exact matchup, just spelled differently" the way it was intended.
  const searchText = ((pick.betDetail ?? "") + " " + pick.homeTeam + " " + pick.awayTeam).toLowerCase();
  const fuzzy = withinDrift(
    inWindow.filter(
      (c) => searchText.includes(teamNickname(c.homeTeam)) && searchText.includes(teamNickname(c.awayTeam))
    ),
    pick.gameTime
  );
  if (fuzzy.length === 0) return null;
  return { game: closestByDate(fuzzy, pick.gameTime), matchType: "fuzzy" };
}

export async function findMatchingGameResult(
  sportKey: string,
  pick: {
    gameTime: Date;
    homeTeam: string;
    awayTeam: string;
    betDetail: string | null;
  }
): Promise<GameMatch | null> {
  const windowStart = new Date(pick.gameTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(pick.gameTime.getTime() + 2 * 86400000);

  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: windowStart, lt: windowEnd } },
  });
  if (candidates.length === 0) return null;

  return matchGameResult(candidates, pick);
}

// Shared by gradePendingPicks and regradeFuzzyMatchedPicks - picks the right score
// pair for the bet (final / first-five / first-inning) and runs gradePick. Also
// exported for getPendingPicksForUser (picks.ts), which uses a null result here
// (game matched, but nothing gradable came out) to tell "waiting on a game to
// finish" apart from "matched fine, but the bet text itself can't be graded" -
// e.g. a TOTAL pick with no parseable number anywhere in it.
export function resolveOutcome(
  pick: {
    betType: string;
    period: string;
    betDetail: string | null;
    homeTeam: string;
    line: number | null;
    pickedSide?: PickedSide | null;
  },
  game: GameResult
): GradeOutcome {
  const homeScore =
    pick.betType === "NRFI"
      ? game.firstInningHomeScore
      : pick.period === "FIRST_HALF"
        ? game.firstFiveHomeScore
        : game.homeScore;
  const awayScore =
    pick.betType === "NRFI"
      ? game.firstInningAwayScore
      : pick.period === "FIRST_HALF"
        ? game.firstFiveAwayScore
        : game.awayScore;

  if (homeScore === null || awayScore === null) return null;

  return gradePick(
    pick.betType,
    pick.betDetail ?? pick.homeTeam,
    pick.line,
    game.homeTeam,
    game.awayTeam,
    homeScore,
    awayScore,
    pick.pickedSide
  );
}

export type TouchdownPropResolution =
  | { outcome: "WIN" | "LOSS" }
  // Mirrors resolveOutcome/gradePick's "matched the game fine, but couldn't
  // confidently grade the bet itself" null - `reason` is the specific why,
  // for getPendingPicksForUser's triage view (picks.ts), which otherwise has
  // no way to tell "not a recognized TD prop" apart from "matched fine, box
  // score just isn't posted yet" apart from "couldn't find this player."
  | { outcome: null; reason: string };

// NFL touchdown-prop grading - a different shape than resolveOutcome above
// (async, no PUSH, and reads player-level box-score data instead of
// GameResult's team scores), so it's a separate path rather than a new case
// inside gradePick/resolveOutcome. A straight "did they score anytime" market
// has no real-world push, so this only ever resolves to WIN, LOSS, or
// unresolved (stays PENDING for manual review). The single source of truth
// for both the actual grading (gradeTouchdownProp below) and the triage
// page's reason text (getPendingPicksForUser, picks.ts) - both call this,
// neither re-implements the parsing/matching steps.
export async function resolveTouchdownProp(
  pick: { betDetail: string | null; homeTeam: string; awayTeam: string },
  eventId: string,
  sportName: string
): Promise<TouchdownPropResolution> {
  // getNflPlayerTdStats below fetches ESPN's football/nfl box-score endpoint
  // specifically - there's no per-sport dispatch here the way getEspnScores
  // has for live scores, so calling it with an eventId sourced from any other
  // sport's GameResult would hit the wrong endpoint entirely (NFL summary
  // data for a numeric ID that actually identifies some other sport's game).
  // Gated here, first, before any of the NFL-specific team-nickname stripping
  // below even runs - the whole rest of this function assumes NFL.
  if (sportName !== "NFL") {
    return { outcome: null, reason: "touchdown-prop grading isn't available for " + sportName + " yet" };
  }

  const parsed = pick.betDetail ? parseTouchdownProp(pick.betDetail) : null;
  if (!parsed) {
    return { outcome: null, reason: "this bet text isn't a recognized touchdown prop" };
  }

  // Strip a leading/trailing team nickname if the capper included one (it's
  // usually needed for game resolution at import time, e.g. "Rams Puka
  // Nacua Anytime TD") - only reliable to do here, not in parseTouchdownProp
  // itself, since this is the first point the pick's real matched
  // homeTeam/awayTeam (not just whatever text the capper typed) are known.
  let playerName = parsed.playerName;
  for (const team of [pick.homeTeam, pick.awayTeam]) {
    const nick = findTeamNickname(team, "NFL");
    if (nick) playerName = playerName.replace(new RegExp("\\b" + nick.replace(/ /g, "\\s+") + "\\b", "i"), "").trim();
    // findTeamNickname can return a longer disambiguated phrase for a team
    // shared with another sport (e.g. "carolina panthers", not just
    // "panthers" - see DISAMBIGUATED_TEAMS) - a capper writing just
    // "Panthers Haynes King TD" wouldn't match that full phrase, so also
    // strip the team's own last word (its plain short nickname) directly.
    const lastWord = team.trim().split(/\s+/).pop();
    if (lastWord) playerName = playerName.replace(new RegExp("\\b" + lastWord + "\\b", "i"), "").trim();
  }
  playerName = playerName.replace(/\s{2,}/g, " ").trim();
  if (!playerName) {
    return { outcome: null, reason: "couldn't identify a player name in the bet text" };
  }

  const stats = await getNflPlayerTdStats(eventId);
  if (!stats) {
    return { outcome: null, reason: "the box score isn't available yet for this game" };
  }

  const match = stats.find((s) => isLikelyDuplicateName(s.playerName, playerName));
  if (!match) {
    // Not found anywhere in the box score - don't guess, leave it for manual
    // grading (could be a name mismatch, or a player who didn't play at all).
    return { outcome: null, reason: 'couldn\'t find "' + playerName + '" in the box score' };
  }

  const scored =
    parsed.propType === "RUSHING"
      ? match.rushTds > 0
      : parsed.propType === "RECEIVING"
        ? match.recTds > 0
        : match.rushTds + match.recTds > 0;

  return { outcome: scored ? "WIN" : "LOSS" };
}

export async function gradeTouchdownProp(
  pick: { betDetail: string | null; homeTeam: string; awayTeam: string },
  eventId: string,
  sportName: string
): Promise<GradeOutcome> {
  return (await resolveTouchdownProp(pick, eventId, sportName)).outcome;
}

// Per-user counterpart of gradeAllPendingPicks, run opportunistically when a
// user loads /picks or /live/[gameId]. Same one-pool-plus-chunked-writes path
// (gradePickPool) - not a per-pick query loop.
export async function gradePendingPicks(
  userId: string,
  sportName: string,
  sportKey: string
): Promise<{ graded: number; notMatched: number }> {
  const pendingPicks = await prisma.pick.findMany({
    where: { userId, status: "PENDING", sport: { name: sportName } },
  });
  const { graded, notMatched } = await gradePickPool(pendingPicks, sportKey, sportName);
  return { graded, notMatched };
}

// A fuzzy match is the best information available at grading time, but it's still a
// guess scoped to "this team, roughly this date" rather than a confirmed same-game
// match. Once a real exact-team-name GameResult shows up for the game, re-grade
// against that instead - this is what let the Tigers/Giants mis-grades go
// undetected: they were graded fuzzy, then never looked at again even after the
// correct game result was persisted. Only picks currently flagged fuzzy are
// checked - exact matches are already the highest-confidence result there is, and
// manually-graded picks (gradedViaFuzzyMatch null) are intentionally never touched.
export async function regradeFuzzyMatchedPicks(
  userId: string,
  sportName: string,
  sportKey: string
): Promise<{ checked: number; upgraded: number }> {
  const fuzzyGraded = await prisma.pick.findMany({
    where: {
      userId,
      sport: { name: sportName },
      status: { in: ["WIN", "LOSS", "PUSH"] },
      gradedViaFuzzyMatch: true,
      gameTime: { gte: regradeLookbackCutoff() },
    },
    orderBy: { gameTime: "desc" },
    take: REGRADE_MAX_ROWS,
  });
  const { checked, upgraded } = await regradeFuzzyPool(fuzzyGraded, sportKey, sportName);
  return { checked, upgraded };
}

// Concurrency cap for the bulk write passes below - bounds how many
// simultaneous pick.update calls hit the DB per chunk. Not tuned against a
// measured ceiling, just a conservative middle ground between "one at a time"
// and "however many happen to be pending."
const BULK_GRADE_CONCURRENCY = 50;

// ---- Regrade-job bounds (see regradeFuzzyMatchedPicks /
// regradeAllFuzzyMatchedPicks / regradeAllFuzzyMatchedLegs) ----
//
// The regrade pass only exists to upgrade a fuzzy-matched grade to an exact
// one once a better GameResult row appears. Exact rows are persisted by
// persistFinalScores, which runs on every /picks and /live/[gameId] load for
// a resolvable sport plus the daily refresh-scores cron - so the correct
// exact result for a finished game almost always lands within 24-48h. A pick
// still fuzzy after two weeks either already got upgraded on an earlier pass
// or never will (a team-name mismatch that won't resolve), so re-scanning it
// every 15 minutes forever is pure waste and, unbounded, eventually blows the
// grade-picks function's time limit.
//
// 14 days (not 3/7): comfortably covers weather postponements, a multi-day
// cron/deploy outage, and a stale catalog imported last week, while capping
// every run's scan at ~2 weeks of one sport's fuzzy picks regardless of total
// history. REGRADE_MAX_ROWS is a hard per-run ceiling so a burst can't blow
// the time limit either - leftovers are picked up on the next run. Both are
// env-overridable: each regrade logs checked/upgraded, so if a genuine
// late upgrade ever shows up in the logs, bump REGRADE_LOOKBACK_DAYS without
// a deploy.
export const REGRADE_LOOKBACK_DAYS = clampPositiveInt(process.env.REGRADE_LOOKBACK_DAYS, 14);
export const REGRADE_MAX_ROWS = clampPositiveInt(process.env.REGRADE_MAX_ROWS, 2000);

function clampPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The earliest gameTime a regrade pass will look back to.
export function regradeLookbackCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REGRADE_LOOKBACK_DAYS * 86400000);
}

// ---- Shared grading passes ----
// The cron (all users) and page-load (one user) paths both funnel into these,
// so match-and-write has exactly one implementation - no parallel logic to
// drift. Each caller runs its own query for the pick set (by sportId for the
// cron, by userId for the page), then hands the rows here. The GameResult
// candidate pool is fetched once for the whole set (window = oldest gameTime
// - 2d .. newest + 2d, the same window findMatchingGameResult applies per
// pick), matched in memory via the pure matchGameResult, and writes go out in
// BULK_GRADE_CONCURRENCY-sized concurrent chunks - never one await per pick.
// changedUserIds is returned so a Route Handler caller (the cron) can
// revalidateTag each affected user's cached surfaces; the page-load callers
// ignore it (revalidateTag is illegal during render - they rely on the cache
// TTL instead).

async function fetchCandidatePool(picks: { gameTime: Date }[], sportKey: string): Promise<GameResult[]> {
  const times = picks.map((p) => p.gameTime.getTime());
  const min = Math.min(...times) - 2 * 86400000;
  const max = Math.max(...times) + 2 * 86400000;
  return prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: new Date(min), lt: new Date(max) } },
  });
}

async function inChunks<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BULK_GRADE_CONCURRENCY) {
    await Promise.all(items.slice(i, i + BULK_GRADE_CONCURRENCY).map(fn));
  }
}

// Exported for grading-idempotency-acceptance-test.ts (the conditional-write
// behavior). Not a public API - gradeAllPendingPicks / gradePendingPicks are.
export async function gradePickPool(
  picks: Pick[],
  sportKey: string,
  sportName: string
): Promise<{ graded: number; notMatched: number; changedUserIds: Set<string> }> {
  const changedUserIds = new Set<string>();
  if (picks.length === 0) return { graded: 0, notMatched: 0, changedUserIds };

  const candidates = await fetchCandidatePool(picks, sportKey);
  let graded = 0;
  let notMatched = 0;

  await inChunks(picks, async (pick) => {
    const result = matchGameResult(candidates, pick);
    if (!result) {
      notMatched++;
      return;
    }
    const outcome =
      pick.betType === "PLAYER_PROP"
        ? await gradeTouchdownProp(pick, result.game.externalId, sportName)
        : resolveOutcome(pick, result.game);
    if (!outcome) {
      notMatched++;
      return;
    }
    // updateMany with a status:PENDING guard, not update({ where: { id } }):
    //  - if the pick was already graded (page-load fast path, a concurrent
    //    grading pass, or a duplicate queue delivery) this matches 0 rows and
    //    is a clean no-op - the other writer computed the identical
    //    deterministic outcome from the same GameResult, so nothing is lost.
    //  - if the pick was DELETED mid-run (the /picks delete feature),
    //    update({ where: { id } }) throws P2025, which propagates out of
    //    Promise.all and 500s the whole cron run with no retry. updateMany
    //    returns { count: 0 } and the run carries on.
    const { count } = await prisma.pick.updateMany({
      where: { id: pick.id, status: "PENDING" },
      data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
    });
    if (count === 1) {
      graded++;
      changedUserIds.add(pick.userId);
    }
  });

  return { graded, notMatched, changedUserIds };
}

// Exported for grading-idempotency-acceptance-test.ts, same as gradePickPool.
export async function regradeFuzzyPool(
  picks: Pick[],
  sportKey: string,
  sportName: string
): Promise<{ checked: number; upgraded: number; changedUserIds: Set<string> }> {
  const changedUserIds = new Set<string>();
  if (picks.length === 0) return { checked: 0, upgraded: 0, changedUserIds };

  const candidates = await fetchCandidatePool(picks, sportKey);
  let upgraded = 0;

  await inChunks(picks, async (pick) => {
    const result = matchGameResult(candidates, pick);
    if (!result || result.matchType !== "exact") return;
    const outcome =
      pick.betType === "PLAYER_PROP"
        ? await gradeTouchdownProp(pick, result.game.externalId, sportName)
        : resolveOutcome(pick, result.game);
    if (!outcome) return;
    const changed = outcome !== pick.status;
    // gradedAt intentionally untouched - a correction, not a new grading event.
    // Guard on gradedViaFuzzyMatch (not status - regrade targets already-graded
    // WIN/LOSS/PUSH picks): if another pass already upgraded this pick to an
    // exact match, or it was deleted mid-run, this matches 0 rows instead of
    // throwing P2025. count === 0 also short-circuits the stale-`pick.status`
    // comparison above.
    const { count } = await prisma.pick.updateMany({
      where: { id: pick.id, gradedViaFuzzyMatch: true },
      data: { status: outcome, gradedViaFuzzyMatch: false },
    });
    if (count === 1 && changed) {
      upgraded++;
      changedUserIds.add(pick.userId);
    }
  });

  return { checked: picks.length, upgraded, changedUserIds };
}

// Global counterpart to gradePendingPicks - grades every user's pending picks
// for a sport in one pass, instead of requiring each user to load /picks or
// /live/[gameId] themselves before their own picks get graded (see the cron
// route this backs: grading was otherwise entirely page-load-triggered, so a
// finished game's picks could sit PENDING for as long as nobody happened to
// visit those two pages).
//
// Two things make this scale where a per-user loop wouldn't: the GameResult
// candidate pool is fetched once for the whole batch (not once per pick, and
// not once per user) and matched in memory via matchGameResult - the exact
// same matching logic findMatchingGameResult uses, just fed a pre-filtered
// array instead of issuing its own query; and writes go out in bounded
// concurrent chunks instead of one sequential await per pick.
//
// maxPicks caps how many picks one invocation will touch, oldest-gameTime-first,
// so a pathological backlog can't blow a function's execution time limit in a
// single run - each write is independent and PENDING-gated, so anything left
// over just gets picked up whole by the next scheduled run.
export async function gradeAllPendingPicks(
  sportKey: string,
  sportName: string,
  maxPicks = 500
): Promise<{ graded: number; notMatched: number; remaining: number; changedUserIds: Set<string> }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { graded: 0, notMatched: 0, remaining: 0, changedUserIds: new Set() };

  const totalPending = await prisma.pick.count({ where: { sportId: sport.id, status: "PENDING" } });
  if (totalPending === 0) return { graded: 0, notMatched: 0, remaining: 0, changedUserIds: new Set() };

  const toProcess = await prisma.pick.findMany({
    where: { sportId: sport.id, status: "PENDING" },
    orderBy: { gameTime: "asc" },
    take: maxPicks,
  });
  const remaining = totalPending - toProcess.length;

  const { graded, notMatched, changedUserIds } = await gradePickPool(toProcess, sportKey, sportName);
  return { graded, notMatched, remaining, changedUserIds };
}

// Global counterpart to regradeFuzzyMatchedPicks - same "upgrade a fuzzy match
// to an exact one once a better GameResult shows up" logic, across every
// user's fuzzy-graded picks for a sport instead of one user's. Same
// pre-fetched-pool-plus-in-memory-match and bounded-concurrent-write shape as
// gradeAllPendingPicks above, for the same reason.
export async function regradeAllFuzzyMatchedPicks(
  sportKey: string,
  sportName: string
): Promise<{ checked: number; upgraded: number; changedUserIds: Set<string> }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { checked: 0, upgraded: 0, changedUserIds: new Set() };

  const fuzzyGraded = await prisma.pick.findMany({
    where: {
      sportId: sport.id,
      status: { in: ["WIN", "LOSS", "PUSH"] },
      gradedViaFuzzyMatch: true,
      gameTime: { gte: regradeLookbackCutoff() },
    },
    orderBy: { gameTime: "desc" },
    take: REGRADE_MAX_ROWS,
  });
  return regradeFuzzyPool(fuzzyGraded, sportKey, sportName);
}

