"use server";

// Auto-Generate (Parlay A + its same-game fill + Hedge + Contrarian) for /parlay, over each
// league's unstarted games in its window (auto-generate-window.ts: today, or
// the football week for NFL/NCAAF). Loads data only
// through what Live already uses (getLiveBoardData, and getCapperRecordBundle - the
// query behind getCapperLeagueRecords/getCapperCategoryRecords - all scoped to the signed-in user's own picks
// and cappers) and hands it to the pure builders in auto-generate.ts. Runs
// server-side because rankCandidates' module imports server/data/picks.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { getLiveBoardData } from "@/server/data/live-board-picks";
import { getCapperRecordBundle, type CapperLeagueRecords } from "@/server/data/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import { legCapRejection, MAX_POOL_REQUEST_PICKS } from "@/lib/parlay/leg-cap";
import { buildParlaySet, EMPTY_SLIP, lockParlay, type LockRejection, type SlipHint } from "@/lib/parlay/alternates";
import { autoGenerateWindow } from "@/lib/parlay/auto-generate-window";
import {
  buildAutoParlay,
  buildMixNotes,
  buildSameGameLegs,
  buildSwapParlay,
  filterEmptyNote,
  filterGamesByInclude,
  swapVariantNote,
  toMaxLegsPerGame,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
  type SameGameFill,
  type SwapParlay,
} from "@/lib/parlay/auto-generate";
import { doubleheaderGameIds } from "@/lib/parlay/doubleheader";
import { toGameLinesPct, toIncludePicks, type IncludePicks } from "@/lib/parlay/pick-mix";

export type AutoGenerateResult = {
  parlayA: AutoParlay;
  // Extra legs from games already in Parlay A - empty unless the request's
  // "max legs per game" is 2 or more AND there were fewer games than legs asked
  // for. Hedge and Contrarian are built from Parlay A alone and never see these.
  sameGame: SameGameFill;
  hedge: SwapParlay;
  contrarian: SwapParlay;
  // For PickCard's record block on every rendered pick.
  records: CapperLeagueRecords;
  leaguesSearched: string[];
  // What was actually applied: the Include Picks filter, and the Pick Mix's
  // Game Lines % (null when none - always null unless includePicks is ALL).
  includePicks: IncludePicks;
  gameLinesPct: number | null;
  // Plain-text notes shown with the result: the leagues the filter left empty
  // ("No props available for WNBA right now."), then anything the mix
  // couldn't meet. Empty when there is nothing to say.
  notes: string[];
  // Shown in place of the Hedge/Contrarian result when those can't swap
  // anything (Props, or no game-line legs). null otherwise.
  swapNote: string | null;
  // Every parlay of this set, first to last: on a first Generate the Primary
  // (= parlayA) and up to two alternates; on a Regenerate up to three parlays
  // never shown before this session - parlayA is the first of them, or the
  // Primary when there are none (parlays is then empty).
  parlays: { parlay: AutoParlay; sameGame: SameGameFill }[];
  regenerated: boolean;
  // Fewer distinct parlays than a full set could be found.
  exhausted: boolean;
};

// How many parlays one Generate / Regenerate answers with.
const PARLAYS_PER_SET = 3;

export type AutoGenerateOptions = { slip?: SlipHint; exclude?: string[] | null };

// More than MAX_PARLAY_LEGS legs is refused outright (see leg-cap.ts) - never
// built smaller than asked.
//
// `options.slip` is the Parlay slip by id (lib/parlay/alternates.ts): its
// locks go into Parlay A and every alternate, its picks join their games'
// shortlists. `options.exclude` makes this a Regenerate: the leg sets already
// shown this session (legSetKey), none of which comes back - and the
// deterministic Primary isn't returned again either.
export async function autoGenerateParlayAction(
  leagues: string[],
  legCount: number,
  maxLegsPerGame: number = 1,
  includePicks: IncludePicks = "ALL",
  gameLinesPct: number | null = null,
  options: AutoGenerateOptions = {}
): Promise<AutoGenerateResult | LockRejection> {
  const user = await requireUser();
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  const opts = toOptions(options);
  if (!opts) return { error: INVALID_REQUEST };
  const requested = Math.max(1, Math.floor(legCount) || 1);
  // Never trusted as sent: an unknown filter is All, and a mix applies only
  // with All and only as a whole step from 0 to 100.
  const include = toIncludePicks(includePicks);
  const mixPct = include === "ALL" ? toGameLinesPct(gameLinesPct) : null;
  const sports = LIVE_SPORTS.filter((s) => leagues.includes(s.label));

  const now = new Date();
  const games: GeneratorGame[] = [];

  // Sequential, not Promise.all: each league's board load runs its own
  // picks query, and firing all of them at once is the connection-pool
  // pressure getPicksForGames' own comment warns about.
  for (const sport of sports) {
    const { odds, scores, expanderPicksByGame } = await getLiveBoardData(user.id, sport.key, sport.label);
    const inWindow = autoGenerateWindow(
      sport.label,
      odds.map((g) => g.commenceTime),
      now
    );
    // From the whole board, not just the window: the other game of a
    // doubleheader may already be under way.
    const doubleheaders = doubleheaderGameIds(odds, scores);
    odds.forEach((game, i) => {
      if (!inWindow(game.commenceTime)) return;
      const picks = expanderPicksByGame[i].filter(
        (p): p is GeneratorPick => p.status === "PENDING" && typeof p.datePosted === "string"
      );
      games.push({
        gameId: game.id,
        gameLabel: picks[0]?.gameLabel ?? game.awayTeam + " @ " + game.homeTeam,
        gameTime: game.commenceTime,
        leagueName: sport.label,
        picks,
        doubleheader: doubleheaders.has(game.id),
      });
    });
  }

  // Everything below - records, Parlay A, same-game fill, Hedge/Contrarian -
  // sees only the picks the filter keeps.
  const scoped = filterGamesByInclude(games, include);
  const allPicks = scoped.flatMap((g) => g.picks);
  // One bundle query for both shapes (was two in parallel, each scanning the
  // same cappers' history): every record is computed per capper/category
  // independently, so asking for both at once returns the same values.
  const { leagueRecords: records, categoryRecords } = await getCapperRecordBundle(user.id, {
    leagueEntries: allPicks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })),
    categoryPairs: allPicks
      .filter((p): p is GeneratorPick & { category: PickCategoryKey } => p.category !== null)
      .map((p) => ({ capperId: p.capperId, category: p.category })),
  });

  const leaguesSearched = sports.map((s) => s.label);
  // Parlay A exactly as before; with no slip locks lockParlay hands it back as is.
  const primary = lockParlay(buildAutoParlay(scoped, records, requested, mixPct), scoped, records, opts.slip);
  if ("error" in primary) return primary;
  const maxPerGame = toMaxLegsPerGame(maxLegsPerGame);
  const fills = new Map<AutoParlay, SameGameFill>();
  const sameGameOf = (p: AutoParlay) => {
    if (!fills.has(p)) fills.set(p, buildSameGameLegs(p, scoped, categoryRecords, maxPerGame));
    return fills.get(p)!;
  };
  const set = buildParlaySet({
    games: scoped,
    records,
    slip: opts.slip,
    primary,
    includePrimary: opts.exclude === null,
    count: PARLAYS_PER_SET,
    exclude: new Set(opts.exclude ?? []),
    extraLegs: (p) => sameGameOf(p).legs.map((l) => l.pick.pickId),
    rng: Math.random,
  });
  // The set's first parlay - the Primary on a first Generate - is the one
  // Hedge and Contrarian vary and the notes describe. A Regenerate that
  // found nothing new still answers with the Primary here, and no `parlays`.
  const parlayA = set.parlays[0] ?? primary;
  const sameGame = sameGameOf(parlayA);
  const emptyNote = filterEmptyNote(games, include, leaguesSearched);
  return {
    parlayA,
    sameGame,
    parlays: set.parlays.map((parlay) => ({ parlay, sameGame: sameGameOf(parlay) })),
    regenerated: opts.exclude !== null,
    exhausted: set.exhausted,
    hedge: buildSwapParlay(parlayA, scoped, "AUTO_HEDGE", categoryRecords),
    contrarian: buildSwapParlay(parlayA, scoped, "CONTRARIAN", categoryRecords),
    records,
    leaguesSearched,
    includePicks: include,
    gameLinesPct: mixPct,
    notes: [...(emptyNote ? [emptyNote] : []), ...buildMixNotes(parlayA, sameGame)],
    swapNote: swapVariantNote(include, parlayA),
  };
}

const INVALID_REQUEST = "That request isn't valid - refresh the page and try again.";
const MAX_ID_LENGTH = 64;
const MAX_EXCLUDED_SETS = 1000;
const MAX_KEY_LENGTH = (MAX_ID_LENGTH + 1) * 40;

// Never trusted as sent - ids only, bounded, or the request is refused.
function toOptions(options: unknown): { slip: SlipHint; exclude: string[] | null } | null {
  if (options === undefined || options === null) return { slip: EMPTY_SLIP, exclude: null };
  if (typeof options !== "object") return null;
  const { slip, exclude } = options as Record<string, unknown>;
  const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
  const items = (list: unknown, idKey: string) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > MAX_POOL_REQUEST_PICKS) return null;
    const out: { id: string; locked: boolean }[] = [];
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null || !okId((raw as Record<string, unknown>)[idKey])) return null;
      out.push({ id: (raw as Record<string, string>)[idKey], locked: (raw as Record<string, unknown>).locked === true });
    }
    return out;
  };
  let hint: SlipHint = EMPTY_SLIP;
  if (slip !== undefined) {
    if (typeof slip !== "object" || slip === null) return null;
    const picks = items((slip as Record<string, unknown>).picks, "pickId");
    const gameItems = items((slip as Record<string, unknown>).games, "gameId");
    if (!picks || !gameItems) return null;
    hint = {
      picks: picks.map((p) => ({ pickId: p.id, locked: p.locked })),
      games: gameItems.map((g) => ({ gameId: g.id, locked: g.locked })),
    };
  }
  if (exclude === undefined || exclude === null) return { slip: hint, exclude: null };
  if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDED_SETS) return null;
  if (!exclude.every((k) => typeof k === "string" && k.length <= MAX_KEY_LENGTH)) return null;
  return { slip: hint, exclude: exclude as string[] };
}
