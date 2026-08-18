import { prisma } from "@/lib/prisma";
import type { GameResult } from "@prisma/client";
import {
  getLiveScoresForSport,
  getOddsForSport,
  getMlbEarlyInningScores,
  getNflFirstHalfScore,
  getNflPlayerTdStats,
  type OddsGame,
} from "@/server/data/odds";
import { closestByTime, sameEasternDay } from "@/lib/dates";
import { extractLine, parseTouchdownProp } from "@/lib/bet-line";
import { findTeamNickname } from "@/lib/parse-catalog";
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
// (MLB's innings-1-5, NFL's Q1+Q2) - period=FIRST_HALF picks in every other
// sport just won't match (see gradePendingPicks) until one is built for
// them too. Both write into the SAME firstFiveHomeScore/AwayScore columns -
// the column names are MLB-flavored (this app's first use), but
// resolveOutcome below already reads them generically for any sport's
// period=FIRST_HALF pick, so NFL didn't need its own columns.
export async function persistFinalScores(sportKey: string): Promise<number> {
  const games = await getLiveScoresForSport(sportKey);
  const finals = games.filter((g) => g.status === "final" && g.scores);
  const supportsFirstFive = sportKey === "baseball_mlb";
  const supportsFirstHalf = sportKey === "americanfootball_nfl";

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
      // game is final" reasoning as MLB's early innings above.
      const needsFirstHalf = supportsFirstHalf && (!existing || existing.firstFiveHomeScore === null);
      const nflFirstHalf = needsFirstHalf ? await getNflFirstHalfScore(g.id) : null;

      const firstHalfHome = early?.firstFive?.home ?? nflFirstHalf?.home ?? null;
      const firstHalfAway = early?.firstFive?.away ?? nflFirstHalf?.away ?? null;

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

type GradeOutcome = "WIN" | "LOSS" | "PUSH" | null;

export function gradePick(
  betType: string,
  betDetail: string,
  line: number | null,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number
): GradeOutcome {
  const detail = betDetail.toLowerCase();
  const homeNick = teamNickname(homeTeam);
  const awayNick = teamNickname(awayTeam);

  const pickedHome = detail.includes(homeNick);
  const pickedAway = detail.includes(awayNick);

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

  if (betType === "NRFI") {
    // Binary market on combined (both teams') first-inning runs - no push.
    // homeScore/awayScore here are the game's first-inning scores, not final
    // (see gradePendingPicks, which selects the score source by betType).
    const runsScored = homeScore + awayScore;
    const pickedNoRun = detail.includes("nrfi") || detail.includes("no run");
    const pickedYesRun = detail.includes("yrfi") || detail.includes("yes run") || detail.includes("run 1st");

    if (pickedNoRun) return runsScored === 0 ? "WIN" : "LOSS";
    if (pickedYesRun) return runsScored > 0 ? "WIN" : "LOSS";
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
  pick: { betType: string; period: string; betDetail: string | null; homeTeam: string; line: number | null },
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

  return gradePick(pick.betType, pick.betDetail ?? pick.homeTeam, pick.line, game.homeTeam, game.awayTeam, homeScore, awayScore);
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
  eventId: string
): Promise<TouchdownPropResolution> {
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
  eventId: string
): Promise<GradeOutcome> {
  return (await resolveTouchdownProp(pick, eventId)).outcome;
}

export async function gradePendingPicks(
  userId: string,
  sportName: string,
  sportKey: string
): Promise<{
  graded: number;
  notMatched: number;
}> {
  const pendingPicks = await prisma.pick.findMany({
    where: { userId, status: "PENDING", sport: { name: sportName } },
  });

  let graded = 0;
  let notMatched = 0;

  for (const pick of pendingPicks) {
    const result = await findMatchingGameResult(sportKey, pick);
    if (!result) {
      notMatched++;
      continue;
    }

    const outcome =
      pick.betType === "PLAYER_PROP"
        ? await gradeTouchdownProp(pick, result.game.externalId)
        : resolveOutcome(pick, result.game);
    if (!outcome) {
      notMatched++;
      continue;
    }

    await prisma.pick.update({
      where: { id: pick.id },
      data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
    });
    graded++;
  }

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
    where: { userId, sport: { name: sportName }, status: { in: ["WIN", "LOSS", "PUSH"] }, gradedViaFuzzyMatch: true },
  });

  let upgraded = 0;

  for (const pick of fuzzyGraded) {
    const result = await findMatchingGameResult(sportKey, pick);
    if (!result || result.matchType !== "exact") continue;

    const outcome =
      pick.betType === "PLAYER_PROP"
        ? await gradeTouchdownProp(pick, result.game.externalId)
        : resolveOutcome(pick, result.game);
    if (!outcome) continue;

    const changed = outcome !== pick.status;
    // gradedAt intentionally untouched - this corrects the original grading, it
    // isn't a new grading event, so it shouldn't reorder recent-form panels.
    await prisma.pick.update({ where: { id: pick.id }, data: { status: outcome, gradedViaFuzzyMatch: false } });
    if (changed) upgraded++;
  }

  return { checked: fuzzyGraded.length, upgraded };
}

// Concurrency cap for the bulk write passes below - bounds how many
// simultaneous pick.update calls hit the DB per chunk. Not tuned against a
// measured ceiling, just a conservative middle ground between "one at a time"
// and "however many happen to be pending."
const BULK_GRADE_CONCURRENCY = 50;

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
): Promise<{ graded: number; notMatched: number; remaining: number }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { graded: 0, notMatched: 0, remaining: 0 };

  const totalPending = await prisma.pick.count({ where: { sportId: sport.id, status: "PENDING" } });
  if (totalPending === 0) return { graded: 0, notMatched: 0, remaining: 0 };

  const toProcess = await prisma.pick.findMany({
    where: { sportId: sport.id, status: "PENDING" },
    orderBy: { gameTime: "asc" },
    take: maxPicks,
  });
  const remaining = totalPending - toProcess.length;

  const minTime = Math.min(...toProcess.map((p) => p.gameTime.getTime())) - 2 * 86400000;
  const maxTime = Math.max(...toProcess.map((p) => p.gameTime.getTime())) + 2 * 86400000;
  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: new Date(minTime), lt: new Date(maxTime) } },
  });

  let graded = 0;
  let notMatched = 0;

  for (let i = 0; i < toProcess.length; i += BULK_GRADE_CONCURRENCY) {
    const chunk = toProcess.slice(i, i + BULK_GRADE_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (pick) => {
        const result = matchGameResult(candidates, pick);
        if (!result) return false;

        const outcome =
          pick.betType === "PLAYER_PROP"
            ? await gradeTouchdownProp(pick, result.game.externalId)
            : resolveOutcome(pick, result.game);
        if (!outcome) return false;

        await prisma.pick.update({
          where: { id: pick.id },
          data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: result.matchType === "fuzzy" },
        });
        return true;
      })
    );
    for (const matched of outcomes) matched ? graded++ : notMatched++;
  }

  return { graded, notMatched, remaining };
}

// Global counterpart to regradeFuzzyMatchedPicks - same "upgrade a fuzzy match
// to an exact one once a better GameResult shows up" logic, across every
// user's fuzzy-graded picks for a sport instead of one user's. Same
// pre-fetched-pool-plus-in-memory-match and bounded-concurrent-write shape as
// gradeAllPendingPicks above, for the same reason.
export async function regradeAllFuzzyMatchedPicks(
  sportKey: string,
  sportName: string
): Promise<{ checked: number; upgraded: number }> {
  const sport = await prisma.sport.findUnique({ where: { name: sportName } });
  if (!sport) return { checked: 0, upgraded: 0 };

  const fuzzyGraded = await prisma.pick.findMany({
    where: { sportId: sport.id, status: { in: ["WIN", "LOSS", "PUSH"] }, gradedViaFuzzyMatch: true },
  });
  if (fuzzyGraded.length === 0) return { checked: 0, upgraded: 0 };

  const minTime = Math.min(...fuzzyGraded.map((p) => p.gameTime.getTime())) - 2 * 86400000;
  const maxTime = Math.max(...fuzzyGraded.map((p) => p.gameTime.getTime())) + 2 * 86400000;
  const candidates = await prisma.gameResult.findMany({
    where: { sportKey, gameDate: { gte: new Date(minTime), lt: new Date(maxTime) } },
  });

  let upgraded = 0;

  for (let i = 0; i < fuzzyGraded.length; i += BULK_GRADE_CONCURRENCY) {
    const chunk = fuzzyGraded.slice(i, i + BULK_GRADE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (pick) => {
        const result = matchGameResult(candidates, pick);
        if (!result || result.matchType !== "exact") return;

        const outcome =
          pick.betType === "PLAYER_PROP"
            ? await gradeTouchdownProp(pick, result.game.externalId)
            : resolveOutcome(pick, result.game);
        if (!outcome) return;

        const changed = outcome !== pick.status;
        // gradedAt intentionally untouched - same reasoning as regradeFuzzyMatchedPicks.
        await prisma.pick.update({ where: { id: pick.id }, data: { status: outcome, gradedViaFuzzyMatch: false } });
        if (changed) upgraded++;
      })
    );
  }

  return { checked: fuzzyGraded.length, upgraded };
}

