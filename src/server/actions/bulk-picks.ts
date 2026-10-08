"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { importRowCapError } from "@/lib/import-limits";
import { insertPicksWithEntitlementCheck } from "@/server/data/subscriptions";
import {
  resolveImportRefs,
  resolveOrCreateCapperId,
  resolveOrCreateSportId,
  type PendingPickInsert,
} from "@/server/data/import-refs";
import {
  resolveGameForNickname,
  resolveGameForTeams,
  findMarketPrice,
  findMarketSpreadLine,
  findMarketTotalLine,
  findFavoredSide,
  createRequestOddsLoader,
  type OddsLoader,
  LIVE_SPORTS,
  RESOLVABLE_SPORT_KEYS,
} from "@/server/data/odds";
import { resolvePropOdds } from "@/server/data/nfl-prop-odds";
import { resolvePickPrice, type PickOddsSource } from "@/lib/odds-source";
import { extractLine, parsePlayerPropLine, parsePlayerProp, parseAnyPlayerProp, isAnytimeTdPick } from "@/lib/bet-line";
import { isInvalidOdds } from "@/lib/pick-validation";
import { TEAM_NICKNAME_CANONICAL, stripTeamNamesFromPlayerName } from "@/lib/parse-catalog";
import { normalizeName } from "@/lib/fuzzy-match";
import { pickCategory, betTypeLabel } from "@/server/data/stats";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { computeDuplicateFlags, dedupCategory, type ResolvedDupCandidate, type DuplicateFlag } from "@/lib/duplicate-pick-detection";
import {
  EXISTING_PICK_SELECT,
  dbDuplicateLabel,
  existingPicksWhere,
  sportIdsByLowerName,
  type DbDupCandidate,
} from "@/server/data/duplicate-db-match";
import { recordImportSkippedLines, type SkippedLineEntry } from "@/server/data/import-skipped-lines";
import { createParlayBet, type LegCreateInput } from "@/server/data/parlays";
import type { BetType, Period } from "@prisma/client";

export type BulkImportItem = {
  capperName: string;
  sportName: string;
  description: string;
  betType: BetType;
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  units: number;
  period: Period;
  // Set only once the client has shown the user the auto-filled total line
  // (see previewMissingTotalLines) and they've confirmed it - never set for
  // a TOTAL pick that already has a real, valid number in its own text, and
  // never trusted server-side unless the pick's own text genuinely has no
  // parseable number (see bulkImportPicksAction).
  inferredLine?: number;
  // 1 or 2, from the pick's own "Game 2"/"G2"/... text (see parse-catalog.ts's
  // gameNumber extraction), or a user's choice on a previously-flagged
  // doubleheader pick. Null for every pick with no such signal - resolution
  // then falls back to PR #105's existing doubleheader flag (never guesses).
  gameNumber: 1 | 2 | null;
  // The pick's exact pasted line, for the import skipped-line log only -
  // never used for resolution. Falls back to `description` when absent.
  raw?: string;
};

// A pick the user (or the default) excluded as a possible duplicate. These
// never reach the resolution loop, so the client reports them for the
// skipped-line log alongside the picks that do.
export type SkippedDuplicateItem = { capperName: string; sportName: string; raw: string };

export type BulkImportResult =
  | {
      success: true;
      imported: number;
      skipped: number;
      errors: string[];
      unmatchedGames: string[];
      // A doubleheader (MLB confirms it) whose every leg was already final
      // when this pick was resolved - the earliest-not-final default
      // (pickBestScheduleCandidate) had nothing left to fall back to, so
      // this genuinely needs manual entry, not a "double-check the matchup"
      // schedule-mismatch message. Disjoint from unmatchedGames.
      doubleheaderBothFinal: string[];
      // Set only when the ENTIRE batch was rejected by the Free-plan pick
      // limit (never a partial import) - distinct from `errors`, which is
      // per-item failures unrelated to billing (bad data, unresolved game,
      // etc). See createPicksWithEntitlementCheck.
      pickLimitBlocked?: { message: string; remaining: number };
    }
  | { success: false; error: string };

type ResolvableItem = {
  sportName: string;
  betType: BetType;
  hasExplicitOdds: boolean;
  odds: number;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  description: string;
  gameNumber: 1 | 2 | null;
};

// How long a line with no matching game waits before its one second look.
const UNMATCHED_RETRY_DELAY_MS = 1000;

function lookupGame(liveSportKey: string, nicknames: string[], gameNumber: 1 | 2 | null, getOdds: OddsLoader) {
  if (nicknames.length >= 2) return resolveGameForTeams(liveSportKey, nicknames[0], nicknames[1], { gameNumber, getOdds });
  if (nicknames.length === 1) return resolveGameForNickname(liveSportKey, nicknames[0], { gameNumber, getOdds });
  return Promise.resolve({ game: null, doubleheaderBothLegsFinal: false });
}

// Shared by the real import (bulkImportPicksAction) and the read-only preview
// enrichment (previewBulkImportOdds) below - only attempts resolution for
// sports with a real score source wired up (see RESOLVABLE_SPORT_KEYS),
// otherwise every pick in an unsupported sport would spuriously get flagged
// as unmatched when resolution was never actually possible for it.
//
// IMPORTANT: homeTeam/awayTeam/gameTime below are only ever meaningful when
// `matched` is true. bulkImportPicksAction must not persist a Pick using
// these fields when matched is false - they're return-shape placeholders,
// not usable data (previously this fell back to dumping the raw bet text
// into homeTeam and "-" into awayTeam, which silently created picks that
// could never be graded or re-matched, since the real opponent was never
// captured anywhere on the row - see the Porter PICKS/Cardinals incident).
//
// getOdds is the calling action's one createRequestOddsLoader(): every line in
// the request shares it, so each sport's OddsSnapshot is read at most once per
// request however many lines (and lookups per line) need it.
//
// retryOnMiss: a line with no matching game waits 1 s and looks once more
// (below). That is right for the callers that resolve every line concurrently -
// the waits overlap, so a paste costs 1 s at most. The pick import turns it off
// and does one retry for the whole batch instead (see bulkImportPicksAction).
async function resolveGameAndOdds(
  item: ResolvableItem,
  getOdds: OddsLoader,
  { retryOnMiss = true }: { retryOnMiss?: boolean } = {}
): Promise<{
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  odds: number;
  // Where `odds` came from - stored on Pick.oddsSource (see lib/odds-source.ts).
  oddsSource: PickOddsSource;
  resolvable: boolean; // sport has a real score source wired up at all
  matched: boolean; // and a specific game was actually found in it
  // Which side of homeTeam/awayTeam this pick is actually on, captured once
  // here (see schema.prisma's Pick.pickedSide comment) rather than re-derived
  // from betDetail text at grading time. Deliberately MORE conservative than
  // the odds-lookup `side` below: only set for a single-nickname ML/SPREAD/
  // TEAM_TOTAL pick, and only when exactly one of home/away ends with that
  // nickname - a same-mascot NCAAF matchup (Clemson Tigers @ LSU Tigers)
  // makes both true at once, and there's no way to tell them apart from a
  // bare nickname alone, so this stays null rather than guessing. TEAM_TOTAL
  // needs this exactly as much as ML/SPREAD does - gradePick's TEAM_TOTAL
  // branch reads the SAME pickedHome/pickedAway they do, so without this a
  // team-total pick would only ever get the weaker mascot/school text-match
  // fallback at grading time, never the authoritative side captured here.
  pickedSide: "HOME" | "AWAY" | null;
  // Which side the real h2h market had as the moneyline favorite, for MONEYLINE
  // picks only (see schema.prisma's Pick.mlFavoredSide and favoriteOrUnderdog).
  // null for every non-MONEYLINE pick and whenever the game couldn't be matched
  // to a live odds row with a usable h2h market.
  mlFavoredSide: "HOME" | "AWAY" | null;
  // Whichever leg actually got resolved, whenever the resolved game is
  // confirmed part of a real MLB doubleheader (game.doubleHeaderStatus "Y"
  // or "S") - read straight from that game's own MLB gameNumber metadata,
  // regardless of whether item.gameNumber came from the pick's own text or
  // pickBestScheduleCandidate's earliest-not-final default. Null whenever
  // the resolved game isn't actually part of a doubleheader at all (a single
  // game on the slate; see the ignored-gameNumber review-note log below).
  // Written to Pick.gameNumber as-is by the caller.
  resolvedGameNumber: 1 | 2 | null;
  // Set only when resolution failed BECAUSE this is a confirmed doubleheader
  // (MLB flags it) whose every leg is already final - the one failure reason
  // that gets its own caller-facing message ("add manually") instead of the
  // generic "couldn't match to today's schedule" one, since there's nothing
  // left to default to. False for every other unmatched reason.
  doubleheaderBothLegsFinal: boolean;
}> {
  let homeTeam = item.description;
  let awayTeam = "-";
  let gameTime = new Date();
  // A price read from the odds feed for a line that has none of its own. Every
  // lookup below runs only when !item.hasExplicitOdds.
  let feedPrice: number | null = null;
  let matched = false;
  let pickedSide: "HOME" | "AWAY" | null = null;
  let mlFavoredSide: "HOME" | "AWAY" | null = null;
  let resolvedGameNumber: 1 | 2 | null = null;
  let doubleheaderBothLegsFinal = false;

  const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())?.key;
  const resolvable = Boolean(liveSportKey && RESOLVABLE_SPORT_KEYS.includes(liveSportKey));
  if (liveSportKey && resolvable) {
    // Some parse-catalog nicknames aren't a SUFFIX of the real live-schedule
    // team name the way a bare mascot is ("cubs" ends "Chicago Cubs"):
    // NCAAF school keys are a PREFIX ("lsu"), and the curated pro slang
    // aliases ("halos", "dbacks", "habs") are neither. TEAM_NICKNAME_CANONICAL
    // translates each to the canonical mascot phrase that IS the suffix, so
    // every endsWith check below (lookupGame's game-resolution, pickedSide,
    // and the odds-lookup side) keeps working unchanged. A no-op for a bare
    // mascot (not in the table -> falls back to itself), and a no-op for any
    // nickname that somehow isn't in the table (same safe "just won't match"
    // behavior as today). Deduped after translation: a capper who writes
    // both the full name and an alias ("Diamondbacks (Dbacks) -1.5") would
    // otherwise hand lookupGame two nicknames that both resolve to the same
    // team, which it reads as a two-team matchup and fails.
    const nicknames = [...new Set(item.teamNicknames.map((n) => TEAM_NICKNAME_CANONICAL[n] ?? n))];
    let lookup = await lookupGame(liveSportKey, nicknames, item.gameNumber, getOdds);
    // One retry before giving up - covers a transient miss/blip against the
    // live schedule source rather than treating it as a genuine non-match.
    if (!lookup.game && retryOnMiss) {
      await new Promise((resolve) => setTimeout(resolve, UNMATCHED_RETRY_DELAY_MS));
      lookup = await lookupGame(liveSportKey, nicknames, item.gameNumber, getOdds);
    }
    const game = lookup.game;
    doubleheaderBothLegsFinal = lookup.doubleheaderBothLegsFinal;
    if (game) {
      matched = true;
      homeTeam = game.homeTeam;
      awayTeam = game.awayTeam;
      gameTime = new Date(game.commenceTime);

      if (game.doubleHeaderStatus === "Y" || game.doubleHeaderStatus === "S") {
        // Confirmed part of a real MLB doubleheader - stamp whichever leg
        // actually got resolved (read from the resolved game's own MLB
        // metadata, not blindly item.gameNumber), whether that came from the
        // pick's own text or pickBestScheduleCandidate's earliest-not-final
        // default when the text had no game-number signal at all.
        if (typeof game.gameNumber === "number") {
          resolvedGameNumber = game.gameNumber as 1 | 2;
        }
      } else if (item.gameNumber !== null) {
        // The pick's text specified a game number, but the resolved game
        // isn't actually part of a doubleheader (single game on the slate -
        // see pickBestScheduleCandidate's early "one candidate" return,
        // which never even looks at gameNumber). Non-blocking: resolved
        // normally, gameNumber just isn't stamped on the row.
        console.log(
          "[resolveGameAndOdds] pick specified a game number but only one game was found for this matchup on the slate - resolved normally, gameNumber not stamped",
          JSON.stringify({ description: item.description, gameNumber: item.gameNumber, homeTeam, awayTeam, gameTime })
        );
      }

      if (
        (item.betType === "MONEYLINE" || item.betType === "SPREAD" || item.betType === "TEAM_TOTAL") &&
        nicknames.length === 1
      ) {
        const homeMatch = game.homeTeam.toLowerCase().endsWith(nicknames[0]);
        const awayMatch = game.awayTeam.toLowerCase().endsWith(nicknames[0]);
        pickedSide = homeMatch && !awayMatch ? "HOME" : awayMatch && !homeMatch ? "AWAY" : null;
      }

      if (item.betType === "MONEYLINE") {
        // The real favored side from the h2h market - the one signal the odds
        // sign can't recover for a juiced near-pick'em (both sides negative).
        // MONEYLINE only; SPREAD's fav/dog already comes correctly off the line
        // sign. One getOddsForSport read, memoized within the request (and
        // already triggered above for any no-explicit-odds pick in the batch).
        mlFavoredSide = await findFavoredSide(liveSportKey, game, getOdds);
      }

      if (!item.hasExplicitOdds && item.betType === "PLAYER_PROP") {
        // Separate from the MONEYLINE/SPREAD/TOTAL path below - a player
        // prop has no home/away side, so it needs its own parsed identity
        // (player + market + Over/Under + line) rather than the
        // nicknames[0]-vs-homeTeam side derivation the other bet types use.
        // Re-parses item.description (the same text becoming betDetail) the
        // same way playerProp does further down in bulkImportPicksAction -
        // never a separate/parallel parse, same "one function, re-read
        // wherever needed" pattern as parseTouchdownProp/extractLine.
        const parsedProp = parsePlayerProp(item.description);
        const parsedLine = parsePlayerPropLine(item.description);
        // Anytime TD is the one market with no Over/Under line (one-sided
        // "Yes", see nfl-prop-odds.ts), so it's priced without parsedLine -
        // but only for a genuine full-game anytime-TD pick (isAnytimeTdPick
        // excludes first-TD, multi-TD, Over/Under-TD, rushing-/receiving-only
        // and half/quarter-scoped text, none of which that market prices).
        if (parsedProp && parsedProp.propMarket === "TD") {
          if (isAnytimeTdPick(item.description)) {
            const tdName = stripTeamNamesFromPlayerName(parsedProp.playerName, [game.homeTeam, game.awayTeam], item.sportName);
            const tdPrice = tdName ? await resolvePropOdds(liveSportKey, game, { playerName: tdName, propMarket: "TD" }, getOdds) : null;
            if (tdPrice !== null) {
              feedPrice = tdPrice;
            }
          }
        } else if (parsedProp && parsedLine) {
          // parsePlayerProp leaves a capper-included team nickname in the
          // player name untouched (e.g. "Chiefs Travis Kelce" from "Chiefs
          // Travis Kelce Over 42.5 Receiving Yards" - it's needed for game
          // resolution, done separately before this point). Strip it the
          // same way resolveTouchdownProp does before fuzzy-matching against
          // a real name, or "Travis Kelce" in the odds snapshot would never
          // match "Chiefs Travis Kelce" here.
          const playerName = stripTeamNamesFromPlayerName(parsedProp.playerName, [game.homeTeam, game.awayTeam], item.sportName);
          const propPrice = playerName
            ? await resolvePropOdds(
                liveSportKey,
                game,
                {
                  playerName,
                  propMarket: parsedProp.propMarket,
                  side: parsedLine.direction === "OVER" ? "Over" : "Under",
                  point: parsedLine.line,
                },
                getOdds
              )
            : null;
          if (propPrice !== null) {
            feedPrice = propPrice;
          }
        }
      } else if (!item.hasExplicitOdds) {
        // Unchanged from before pickedSide existed - always resolves to
        // "home" or "away" for a non-TOTAL bet, same as it always has, for
        // the market-price lookup only. Deliberately NOT reused for
        // pickedSide above: this always picks a side even when ambiguous,
        // which is fine for "which market price to fetch" (worst case, a
        // same-mascot pick's auto-filled odds come from the wrong side's
        // price) but not for the DB field grading depends on to decide
        // WIN/LOSS, which must stay null rather than guess.
        const side =
          item.betType === "TOTAL" || item.betType === "TEAM_TOTAL"
            ? item.totalSide
            : game.homeTeam.toLowerCase().endsWith(nicknames[0])
            ? "home"
            : "away";

        // No real market exists for team totals in this app's cached odds
        // (getOddsForSport only fetches h2h/spreads/totals) - findMarketPrice
        // has no TEAM_TOTAL case and returns null for it, same as it already
        // does for NRFI, so this is a no-op price lookup rather than a real
        // one; team-total picks keep whatever odds the capper typed (or the
        // -110 default), same as before this bet type existed.
        const marketPrice =
          side && item.betType !== "TEAM_TOTAL" ? await findMarketPrice(liveSportKey, game, item.betType, side, getOdds) : null;
        if (marketPrice !== null) {
          feedPrice = marketPrice;
        }
      }
    }
  }

  const { odds, oddsSource } = resolvePickPrice(item, feedPrice);

  return {
    homeTeam,
    awayTeam,
    gameTime,
    odds,
    oddsSource,
    resolvable,
    matched,
    pickedSide,
    mlFavoredSide,
    resolvedGameNumber,
    doubleheaderBothLegsFinal,
  };
}

// Read-only preview enrichment: the client-side catalog parser has no access
// to live odds (it only runs parseCatalog in the browser), so the "Drop
// Catalog" preview always showed the -110 default even when a real price was
// about to be looked up at actual import time - confusing, since the two
// numbers could silently differ. This runs the same resolution+lookup logic
// bulkImportPicksAction uses, without persisting anything, so the preview
// matches what actually gets saved.
export async function previewBulkImportOdds(items: ResolvableItem[]): Promise<Record<number, number>> {
  return (await previewBulkImportMatches(items)).odds;
}

// The game a preview row resolved to - gameTime as an ISO string so it
// crosses the server-action boundary unchanged.
export type PreviewMatchedGame = { homeTeam: string; awayTeam: string; gameTime: string };

// previewBulkImportOdds plus the matchup each row resolved to, for the Match
// results panel's "Away @ Home - time" sub-line. Purely additive: `games` is
// read off the SAME resolveGameAndOdds result the odds come from - no extra
// lookup. A row with the capper's own odds is still never resolved here (as
// before), so it has no entry and the panel falls back to its own text.
export async function previewBulkImportMatches(
  items: ResolvableItem[]
): Promise<{ odds: Record<number, number>; games: Record<number, PreviewMatchedGame> }> {
  await requireUser();
  const getOdds = createRequestOddsLoader();

  const enriched: Record<number, number> = {};
  const games: Record<number, PreviewMatchedGame> = {};
  await Promise.all(
    items.map(async (item, i) => {
      if (item.hasExplicitOdds) return;
      const { odds, matched, homeTeam, awayTeam, gameTime } = await resolveGameAndOdds(item, getOdds);
      if (matched && odds !== item.odds) enriched[i] = odds;
      if (matched) games[i] = { homeTeam, awayTeam, gameTime: gameTime.toISOString() };
    })
  );
  return { odds: enriched, games };
}

export type MissingTotalLineResult = {
  inferredLine: number;
  reason: "missing" | "garbled"; // no digit anywhere in the text vs. some non-parseable number-ish token
};

// Read-only preview, same shape as previewBulkImportOdds: flags TOTAL picks
// whose raw bet text had no parseable number at all (e.g. "Cubs under a")
// and looks up today's real market total for that specific game, so the UI
// can show it to the user for explicit confirm/reject before import - see
// bulkImportPicksAction, which refuses to persist a TOTAL pick with no
// number unless the client already confirmed an inferredLine for it.
//
// Deliberately never touches a TOTAL pick that already has a real, valid
// number - extractLine returning non-null means the capper specified an
// actual (possibly alternate) line, which must never be overridden.
export async function previewMissingTotalLines(items: ResolvableItem[]): Promise<Record<number, MissingTotalLineResult>> {
  await requireUser();
  const getOdds = createRequestOddsLoader();

  const results: Record<number, MissingTotalLineResult> = {};
  await Promise.all(
    items.map(async (item, i) => {
      if (item.betType !== "TOTAL" || !item.totalSide) return;
      if (extractLine("TOTAL", item.description) !== null) return;

      const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())?.key;
      if (!liveSportKey || !RESOLVABLE_SPORT_KEYS.includes(liveSportKey)) return;

      const { matched, homeTeam, awayTeam, gameTime } = await resolveGameAndOdds(item, getOdds);
      if (!matched) return;

      const point = await findMarketTotalLine(
        liveSportKey,
        { homeTeam, awayTeam, commenceTime: gameTime.toISOString() },
        item.totalSide,
        getOdds
      );
      if (point === null) return;

      results[i] = { inferredLine: point, reason: /\d/.test(item.description) ? "garbled" : "missing" };
    })
  );
  return results;
}

export type DuplicateCheckItem = ResolvableItem & { capperName: string; period: Period };
// Re-exported so callers of checkDuplicatePicksAction keep importing it from
// here; the shape lives in @/lib/duplicate-pick-detection now.
export type { DuplicateFlag };

// A duplicate is specifically the SAME capper + SAME game + SAME bet type
// AND side AND game-segment (e.g. two "Cubs Moneyline" picks) - NOT just the
// same team, and NOT the same capper on the same game with a different bet (a
// capper can legitimately have both "Cubs Moneyline" and "Cubs -1.5" on one
// game, or a full-game "Over 54.5" AND a "Q1 Over 12.5").
// pickCategory draws the side-aware line (FAV_ML vs DOG_ML, SPREAD_MINUS vs
// SPREAD_PLUS, OVER vs UNDER), so it's reused here rather than re-deriving
// "same side" from scratch - but pickCategory only forks by period for
// FIRST_HALF, so `period` is compared alongside it: a quarter / 2nd-half /
// period pick classifies into the same OVER/UNDER/ML/SPREAD bucket as its
// full-game counterpart, and only the period tells them apart.
// Odds/line/units are deliberately never compared - two picks on the same
// side and segment with different prices are still the same pick logged
// twice, per how this was scoped with the user, so "Clemson +6.5" and
// "Clemson +7" are already the same SPREAD_PLUS pick here.
//
// Each item is checked against BOTH (a) this user's already-logged picks
// and (b) the EARLIER items in this same paste. (b) is what catches the
// "Clemson +6.5"/"Clemson +7" case: those never touch the database yet, so
// a DB-only check (all this used to do) let a paste duplicate itself
// silently. The first occurrence in the paste imports; the second onward is
// flagged, exactly like a re-import of an already-logged pick.
//
// Read-only, same pattern as previewBulkImportOdds: keyed by each item's
// position in the input array so the caller can remap into `parsed` indices.
export async function checkDuplicatePicksAction(items: DuplicateCheckItem[]): Promise<Record<number, DuplicateFlag>> {
  const user = await requireUser();
  const getOdds = createRequestOddsLoader();

  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id }, select: { id: true, name: true } });
  const capperByNormalizedName = new Map(existingCappers.map((c) => [normalizeName(c.name), c]));

  // Phase 1 - resolve every item (no database): which game, which side, which
  // dedup key. The schedule/odds lookups are cached and shared per request.
  type Resolved = Omit<ResolvedDupCandidate, "dbDuplicateLabel"> & { capperId: string | null; sportName: string };
  const resolved = await Promise.all(
    items.map(async (item, index): Promise<Resolved | null> => {
      const normalized = normalizeName(item.capperName);
      const capper = capperByNormalizedName.get(normalized);
      const capperKey = capper ? capper.id : "new:" + normalized;
      const capperName = capper ? capper.name : item.capperName;

      // Only checked once resolved to a real scheduled game - without that,
      // "same game" has nothing reliable to compare against (see
      // resolveGameAndOdds; unresolved items fall back to placeholder
      // homeTeam/awayTeam values that aren't safe to match on).
      const { homeTeam, awayTeam, gameTime, odds, matched, pickedSide, mlFavoredSide } =
        await resolveGameAndOdds(item, getOdds);
      if (!matched) return null;

      // odds (not item.odds) - for a pick with no explicit price, item.odds
      // is still the parser's un-resolved default and would misclassify a
      // moneyline's favorite/underdog side (see favoriteOrUnderdog). odds is
      // resolveGameAndOdds' resolved real market price for this exact pick.
      // pickedSide + mlFavoredSide let pickCategory tell FAV_ML from DOG_ML in a
      // juiced pick'em, where without them "Phillies ML" and "Diamondbacks ML"
      // both classify as FAV_ML and the real opposite-side pick gets wrongly
      // flagged here as a duplicate of the first.
      const period = item.period;
      const line = extractLine(item.betType, item.description);
      const category = pickCategory({
        betType: item.betType,
        period,
        betDetail: item.description,
        odds,
        line,
        sportName: item.sportName,
        pickedSide,
        mlFavoredSide,
      });
      // Can't determine a comparable side for this bet (e.g. a player prop,
      // or a first-half spread) - don't guess at a match either way.
      if (!category) return null;
      // TEAM_TOTAL-only widening - see dedupCategory's own comment. A no-op
      // for every other bet type (pickCategory's output already differs by
      // side there).
      const dedupKey = dedupCategory(category, item.betType, item.description, pickedSide);

      return {
        index,
        capperKey,
        capperName,
        capperId: capper ? capper.id : null,
        sportName: item.sportName,
        homeTeam,
        awayTeam,
        gameTimeMs: gameTime.getTime(),
        category: dedupKey,
        period,
        description: item.description,
      };
    })
  );

  // Phase 2 - the already-logged check, as two statements for the whole paste
  // (it was one sport lookup and one pick read per item, issued concurrently:
  // see duplicate-db-match.ts). A brand-new capper (not yet in this user's
  // list) can't already have a pick logged, by definition, so only items with
  // an existing capper take part.
  const withCapper = resolved.filter((r): r is Resolved & { capperId: string } => r !== null && r.capperId !== null);

  // Sport ids, so the read can scope by sportId: without it, two picks that
  // happen to share literal homeTeam/awayTeam strings across different sports
  // (or a stale/mis-resolved row from an earlier import) can false-positive as
  // a duplicate here even though getPicksForGame - which DOES filter by
  // sportId - would never attribute that row to this game at all, making the
  // flagged "duplicate" invisible under the game's own expander. One query for
  // every distinct name, up front, instead of a per-item lookup racing its own
  // cache under Promise.all.
  const sportNames = Array.from(new Set(withCapper.map((r) => r.sportName.toLowerCase())));
  const sportIdByLowerName =
    sportNames.length === 0
      ? new Map<string, string>()
      : sportIdsByLowerName(
          await prisma.sport.findMany({
            where: { OR: sportNames.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
            select: { id: true, name: true },
            orderBy: { id: "asc" },
          })
        );

  // No Sport row yet for a name means no pick could possibly reference it -
  // those items are left out of the read rather than queried with an
  // impossible id.
  const dbCandidates = new Map<number, DbDupCandidate>();
  for (const r of withCapper) {
    const sportId = sportIdByLowerName.get(r.sportName.toLowerCase());
    if (!sportId) continue;
    dbCandidates.set(r.index, {
      capperId: r.capperId,
      sportId,
      sportName: r.sportName,
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      gameTimeMs: r.gameTimeMs,
      period: r.period,
      dedupKey: r.category,
    });
  }
  const where = existingPicksWhere(user.id, Array.from(dbCandidates.values()), MAX_GAME_TIME_DRIFT_MS);
  const existingPicks = where
    ? await prisma.pick.findMany({ where, select: EXISTING_PICK_SELECT, orderBy: { id: "asc" } })
    : [];

  // The DB-vs-earlier-in-paste decision is pure (see duplicate-pick-detection.ts).
  return computeDuplicateFlags(
    resolved
      .filter((r): r is Resolved => r !== null)
      .map(({ capperId: _capperId, sportName: _sportName, ...r }): ResolvedDupCandidate => {
        const candidate = dbCandidates.get(r.index);
        return {
          ...r,
          dbDuplicateLabel: candidate ? dbDuplicateLabel(existingPicks, candidate, MAX_GAME_TIME_DRIFT_MS) : null,
        };
      }),
    MAX_GAME_TIME_DRIFT_MS
  );
}

export async function bulkImportPicksAction(
  items: BulkImportItem[],
  skippedDuplicates: SkippedDuplicateItem[] = []
): Promise<BulkImportResult> {
  const user = await requireUser();
  const getOdds = createRequestOddsLoader();

  // Refused before any work. See import-limits.ts for the number and its reasoning.
  const capError = importRowCapError(items.length);
  if (capError) return { success: false, error: capError };

  // Nothing is written until the single transaction at the end: this function
  // resolves every item first (no database), then cappers, sports and picks are
  // created together or not at all. It used to find-or-create each item's
  // capper and sport as it went, so an import that timed out part-way, threw,
  // or was refused by the pick limit left cappers behind with no picks.
  //
  // Resolution: every item at once, not one after another. Each lookup reads
  // the same cached schedule/odds feeds, so the items do not wait on each
  // other - and neither do their retries: a line with no matching game used to
  // sleep 1 s and look again, serially, so a paste of N unmatched lines (a day-
  // old card) took N seconds before anything else happened. Now every miss gets
  // ONE shared wait and one more look, with a fresh odds loader so a failed
  // odds read is not just replayed.
  type Resolution = Awaited<ReturnType<typeof resolveGameAndOdds>>;
  type Outcome = { ok: true; resolved: Resolution } | { ok: false; err: unknown };
  const resolveOne = (item: BulkImportItem, loader: OddsLoader): Promise<Outcome> =>
    resolveGameAndOdds(item, loader, { retryOnMiss: false }).then(
      (resolved): Outcome => ({ ok: true, resolved }),
      (err: unknown): Outcome => ({ ok: false, err })
    );
  const outcomes = await Promise.all(items.map((item) => resolveOne(item, getOdds)));
  const missed = outcomes.flatMap((o, i) => (o.ok && o.resolved.resolvable && !o.resolved.matched ? [i] : []));
  if (missed.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, UNMATCHED_RETRY_DELAY_MS));
    const retryOdds = createRequestOddsLoader();
    const second = await Promise.all(missed.map((i) => resolveOne(items[i], retryOdds)));
    missed.forEach((i, k) => {
      outcomes[i] = second[k];
    });
  }

  const errors: string[] = [];
  const unmatchedGames: string[] = [];
  const doubleheaderBothFinal: string[] = [];
  // Every item that resolves cleanly gets queued here, not inserted yet -
  // the pick-limit check has to see the FULL batch size before any row is
  // written, or a Free user at 995 picks importing 20 could see the first 5
  // silently succeed before the 6th trips the limit. Items that fail for
  // unrelated reasons (bad data, no matching game) still go to `errors`
  // individually and are simply never queued - that's a different kind of
  // per-item failure than the billing gate below, which is all-or-nothing
  // across whatever DID resolve.
  const toInsert: PendingPickInsert[] = [];
  // Every item dropped below, for the skipped-line log - written once, in one
  // batch, after the loop. Pure bookkeeping: nothing here affects the result.
  const skippedLog: SkippedLineEntry[] = skippedDuplicates.map((d) => ({
    stage: "DUPLICATE_SKIPPED",
    capperName: d.capperName,
    rawText: d.raw,
    guessedSport: d.sportName,
    reason: "Flagged as a possible duplicate and excluded from the import",
  }));
  const logSkip = (item: BulkImportItem, stage: SkippedLineEntry["stage"], reason: string) =>
    skippedLog.push({ stage, capperName: item.capperName, rawText: item.raw ?? item.description, guessedSport: item.sportName, reason });

  // In input order, so errors / unmatched lists / the skipped-line log read
  // exactly as they did when resolution itself was serial.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // The capper is only created in the transaction below, so its one
      // per-item failure (findOrCreateCapper's own rule) is checked here.
      if (!item.capperName.trim()) throw new Error("Capper name is required.");
      const outcome = outcomes[i];
      if (!outcome.ok) throw outcome.err;

      const {
        homeTeam,
        awayTeam,
        gameTime,
        odds,
        oddsSource,
        resolvable,
        matched,
        pickedSide,
        mlFavoredSide,
        resolvedGameNumber,
        doubleheaderBothLegsFinal,
      } = outcome.resolved;
      if (resolvable && !matched) {
        // Don't persist this item at all - homeTeam/awayTeam/gameTime from
        // resolveGameAndOdds are just placeholders when matched is false,
        // and a Pick written with them can never be graded or re-matched
        // later (the real opponent/game time was never actually resolved).
        // A confirmed doubleheader whose every leg is already final gets its
        // own message (nothing left to default to - the pick genuinely needs
        // manual entry) instead of the generic "couldn't match" one, which
        // wrongly implies the schedule lookup itself failed.
        if (doubleheaderBothLegsFinal) {
          doubleheaderBothFinal.push(item.capperName + " - " + item.description);
          logSkip(item, "DOUBLEHEADER_FINAL", "Doubleheader with every leg already final");
        } else {
          unmatchedGames.push(item.capperName + " - " + item.description);
          logSkip(item, "GAME_UNMATCHED", "No scheduled game matched");
        }
        continue;
      }

      if (isInvalidOdds(odds)) {
        // Same rule createPickAction enforces for manual entry (picks.ts),
        // via the shared isInvalidOdds check. odds here is the fully-resolved
        // value (explicit text, real market price, or the -110 default), so
        // this also catches the vanishingly-unlikely case of a market/prop-
        // price lookup itself resolving to 0.
        errors.push(item.capperName + " - " + item.description + ": Odds must be a valid non-zero number.");
        logSkip(item, "INVALID_ODDS", "Odds must be a valid non-zero number (resolved " + odds + ")");
        continue;
      }

      const extractedLine = extractLine(item.betType, item.description);
      if (item.betType === "TOTAL" && extractedLine === null && item.inferredLine === undefined) {
        // No number anywhere in this pick's own text, and the client never
        // confirmed an auto-filled market line for it (either it bypassed
        // the confirmation step, or the lookup itself found nothing to
        // propose) - refuse to persist an ungradeable TOTAL pick, same
        // principle as the unmatched-game rejection above.
        unmatchedGames.push(item.capperName + " - " + item.description);
        logSkip(item, "TOTAL_NO_LINE", "TOTAL with no number and no confirmed inferred line");
        continue;
      }

      // Re-reads item.description (the same text becoming betDetail below)
      // through the same shared parser parsePickText already used to decide
      // item.betType === "PLAYER_PROP" - never a separate/parallel market
      // detection, same "one function, re-read wherever the structured
      // result is needed" pattern as parseTouchdownProp/grading.ts. Only
      // set on the row being created right now; never used to update any
      // other row.
      const playerProp = item.betType === "PLAYER_PROP" ? parseAnyPlayerProp(item.description) : null;

      toInsert.push({
        capperName: item.capperName,
        sportName: item.sportName,
        homeTeam,
        awayTeam,
        betType: item.betType,
        betDetail: item.description,
        odds,
        oddsSource,
        line: extractedLine ?? item.inferredLine ?? null,
        period: item.period,
        units: item.units,
        gameTime,
        pickedSide,
        mlFavoredSide,
        playerName: playerProp?.playerName,
        propMarket: playerProp?.propMarket,
        gameNumber: resolvedGameNumber,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(item.capperName + " - " + item.description + ": " + message);
    }
  }

  // The single all-or-nothing billing gate for this whole batch - see
  // createPicksWithEntitlementCheck. Nothing above this point has written a
  // Pick row yet.
  // The skipped-line write runs concurrently with the insert so it adds no
  // latency, and never throws (see recordImportSkippedLines), so it can't
  // fail the import. Awaited (not fire-and-forget) so serverless doesn't
  // freeze the function mid-write.
  const [result] = await Promise.all([
    // Cappers and sports are found or created INSIDE the transaction, after
    // the pick-limit gate - a refused or failed import creates neither.
    insertPicksWithEntitlementCheck(user.id, toInsert.length, (tx) => resolveImportRefs(tx, user.id, toInsert)),
    recordImportSkippedLines(user.id, skippedLog),
  ]);

  // Bust this user's cached Dashboard aggregations by tag (see
  // getDashboardSummary) - revalidatePath does not reliably evict
  // unstable_cache entries.
  revalidateTag(cacheKeys.dashboard(user.id));
  revalidatePath("/picks");
  revalidatePath("/dashboard");
  revalidatePath("/cappers");

  if (!result.allowed) {
    return {
      success: true,
      imported: 0,
      skipped: items.length,
      errors,
      unmatchedGames,
      doubleheaderBothFinal,
      pickLimitBlocked: { message: result.message, remaining: result.remaining },
    };
  }

  return {
    success: true,
    imported: result.created.length,
    skipped: items.length - result.created.length,
    errors,
    unmatchedGames,
    doubleheaderBothFinal,
  };
}

// ---- MLP (moneyline parlay) import ----
//
// Two independently-resolvable picks coupled into one heads-up bet (e.g.
// "Lions +12.5 + Lions/Bills o47 mlp") - each leg is resolved to a real
// scheduled game exactly the way a normal single pick is (resolveGameAndOdds,
// unchanged), and persisted as a ParlayBet + 2 Legs (see
// server/data/parlays.ts) instead of 2 separate Picks. The parlay's combined
// price is intentionally never stored here - see the Leg model's own comment
// in schema.prisma - it's computed live from surviving (non-PUSH) legs'
// individual Leg.odds at grading/display time.

export type BulkImportParlayLegItem = ResolvableItem & { period: Period };

export type BulkImportParlayItem = {
  capperName: string;
  units: number;
  legs: [BulkImportParlayLegItem, BulkImportParlayLegItem];
};

export type BulkImportParlaysResult =
  | { success: true; imported: number; skipped: number; errors: string[]; unmatchedParlays: string[] }
  | { success: false; error: string };

// The one deliberate divergence from resolveGameAndOdds: for a SPREAD/TOTAL
// leg, the number written next to it in the paste is a leg label pointing at
// a real pick, NOT gradable truth (see ParsedParlay's own comment in
// parse-catalog.ts - a capper's "Lions +12.5" can really mean the live
// "Lions +4.5"). So the persisted `line` for those two bet types always
// comes from today's live market point, via the same findMarketSpreadLine/
// findMarketTotalLine lookups used elsewhere for a missing/garbled number -
// applied here unconditionally, never gated on the text having no number at
// all. `lineUnresolved` tells the caller when that live lookup itself came
// up empty (no market for this exact game/side yet) - the whole parlay must
// be rejected then, never falling back to trusting the leg's own written
// number instead (see the "bad data worse than unresolved" project rule).
//
// MONEYLINE/TEAM_TOTAL/PLAYER_PROP/NRFI legs have no live line to force (a
// TEAM_TOTAL leg has no real market source at all, same limitation as a
// normal single TEAM_TOTAL pick) - line stays null here, and the caller
// falls back to extractLine(betType, description) same as a normal pick.
async function resolveLegAndOdds(item: ResolvableItem, getOdds: OddsLoader): Promise<{
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  odds: number;
  line: number | null;
  resolvable: boolean;
  matched: boolean;
  pickedSide: "HOME" | "AWAY" | null;
  mlFavoredSide: "HOME" | "AWAY" | null;
  lineUnresolved: boolean;
}> {
  const base = await resolveGameAndOdds(item, getOdds);
  if (!base.matched || (item.betType !== "SPREAD" && item.betType !== "TOTAL")) {
    return { ...base, line: null, lineUnresolved: false };
  }

  const liveSportKey = LIVE_SPORTS.find((s) => s.label.toUpperCase() === item.sportName.toUpperCase())!.key;
  const game = { homeTeam: base.homeTeam, awayTeam: base.awayTeam, commenceTime: base.gameTime.toISOString() };

  let line: number | null;
  if (item.betType === "SPREAD") {
    // pickedSide can be null for a same-mascot matchup - same "don't guess"
    // rule resolveGameAndOdds itself already follows; without a determined
    // side there's no live spread line to look up for it.
    const side = base.pickedSide === "HOME" ? "home" : base.pickedSide === "AWAY" ? "away" : null;
    line = side ? await findMarketSpreadLine(liveSportKey, game, side, getOdds) : null;
  } else {
    line = item.totalSide ? await findMarketTotalLine(liveSportKey, game, item.totalSide, getOdds) : null;
  }

  return { ...base, line, lineUnresolved: line === null };
}

export async function bulkImportParlaysAction(items: BulkImportParlayItem[]): Promise<BulkImportParlaysResult> {
  const user = await requireUser();
  const getOdds = createRequestOddsLoader();

  const existingCappers = await prisma.capper.findMany({ where: { userId: user.id } });
  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();
  const errors: string[] = [];
  const unmatchedParlays: string[] = [];
  let imported = 0;

  for (const item of items) {
    try {
      const capperId = await resolveOrCreateCapperId(user.id, item.capperName, existingCappers, capperCache);

      const legsData: LegCreateInput[] = [];
      let rejected = false;

      for (const legItem of item.legs) {
        const resolved = await resolveLegAndOdds(legItem, getOdds);
        if ((resolved.resolvable && !resolved.matched) || resolved.lineUnresolved) {
          rejected = true;
          break;
        }

        const sportId = await resolveOrCreateSportId(legItem.sportName, sportCache);
        // resolved.line only carries a real value when a live lookup was
        // actually attempted (resolved.matched - see resolveLegAndOdds).
        // For a sport with no live score source at all (resolvable: false,
        // never matched, never rejected above), there's nothing to look up
        // against, so this falls back to the leg's own written number, same
        // as a normal single pick in an unresolvable sport already does -
        // never silently drops a real number just because MLP normally
        // distrusts it.
        const line =
          resolved.matched && (legItem.betType === "SPREAD" || legItem.betType === "TOTAL")
            ? resolved.line
            : extractLine(legItem.betType, legItem.description);

        legsData.push({
          sportId,
          homeTeam: resolved.homeTeam,
          awayTeam: resolved.awayTeam,
          betType: legItem.betType,
          betDetail: legItem.description,
          odds: resolved.odds,
          line,
          period: legItem.period,
          gameTime: resolved.gameTime,
        });
      }

      if (rejected || legsData.length !== item.legs.length) {
        unmatchedParlays.push(item.capperName + " - " + item.legs.map((l) => l.description).join(" + "));
        continue;
      }

      await createParlayBet(user.id, { capperId, units: item.units, legs: legsData });
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(item.capperName + ": " + message);
    }
  }

  // Parlays themselves are in no cached read, but this import can create
  // cappers, and the cached roster / cappers bundle carry the capper list.
  revalidateTag(cacheKeys.dashboard(user.id));
  revalidatePath("/picks");
  revalidatePath("/dashboard");

  return { success: true, imported, skipped: items.length - imported, errors, unmatchedParlays };
}
