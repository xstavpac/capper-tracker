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
import { closestByTime } from "@/lib/dates";
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
// snapshot at all (e.g. the day's fetch was missed) or neither market has
// usable outcomes.
function deriveLedgerFields(
  oddsGames: OddsGame[],
  homeTeam: string,
  awayTeam: string
): { favTeam: string | null; totalLine: number | null } {
  const match = oddsGames.find((g) => g.homeTeam === homeTeam && g.awayTeam === awayTeam);
  if (!match) return { favTeam: null, totalLine: null };

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
      const ledger = needsLedgerFields ? deriveLedgerFields(oddsGames, g.homeTeam, g.awayTeam) : null;
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

  // Picks resolved to a real game on import (see resolveGameForNickname) carry the
  // exact team names, so prefer an exact match over the fuzzy text search below.
  // Also requires the matched game to actually be THIS game, not just the same
  // two teams on some other day within the window - see MAX_GAME_TIME_DRIFT_MS.
  const exact = withinDrift(
    candidates.filter((c) => c.homeTeam === pick.homeTeam && c.awayTeam === pick.awayTeam),
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
    candidates.filter(
      (c) => searchText.includes(teamNickname(c.homeTeam)) && searchText.includes(teamNickname(c.awayTeam))
    ),
    pick.gameTime
  );
  if (fuzzy.length === 0) return null;
  return { game: closestByDate(fuzzy, pick.gameTime), matchType: "fuzzy" };
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

