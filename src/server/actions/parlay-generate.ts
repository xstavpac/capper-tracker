"use server";

// The Parlay Generator's one server action (PR 4 of the consolidation). It
// loads the generator's SNAPSHOT (server/data/generator-snapshot.ts, shared with
// Consensus Hybrid) - the pool of games and picks, the slip's
// picks and both record maps - and answers with it plus the Primary built from
// it (buildGeneratedParlay, lib/parlay/generator.ts).
//
// The snapshot goes back to the browser on purpose: Regenerate, and any
// setting that doesn't change the pool (leg count, max per game, Include
// Picks, Pick Mix, Fill from), runs the same pure engine there on the snapshot
// it already holds - no request, no database read. The browser only comes
// back here when the pool itself changes (slip picks, targets, leagues) or the
// snapshot goes stale (generator-session.ts decides).
//
// Reads, per call: the slip's own rows (getOwnedSlipPickRows), one board per
// league needed (getLiveBoardData - sequential, as everywhere), and ONE record
// bundle (getCapperRecordBundle: every slip pick's and candidate's card - its
// in-league and all-time market record - in a single query). Nothing about a pick or a game
// is taken from the client: the request names picks and games by id.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { loadGeneratorSnapshot } from "@/server/data/generator-snapshot";
import { normalizeMinWinPct } from "@/lib/parlay/gate";
import { legCapRejection, MAX_POOL_REQUEST_PICKS, type ParlayRejection } from "@/lib/parlay/leg-cap";
import { selectedCategories, toIncludeSelection, toPickMix } from "@/lib/parlay/include-picks";
import {
  buildGeneratedParlay,
  type FillFrom,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";

export type GenerateTarget = { gameId: string; leagueName: string };

export type GenerateRequest = {
  // League scope: the full slate (no targets) is these leagues' games in
  // Auto-Generate's window (auto-generate-window.ts).
  leagues: string[];
  slipPickIds: string[];
  targets: GenerateTarget[];
  settings: GeneratorSettings;
};

export type GenerateResponse = { snapshot: GeneratorSnapshot; parlay: GeneratedParlay };

const INVALID_REQUEST = "That request isn't valid - refresh the page and try again.";
const TOO_MANY = `Too many picks or games in one request - ${MAX_POOL_REQUEST_PICKS} at most.`;
const MAX_ID_LENGTH = 64;
const LIVE_LABELS = new Set(LIVE_SPORTS.map((s) => s.label));
const okId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;

// Never trusted as sent: ids only, bounded, leagues from the Live list.
function parseRequest(raw: unknown): GenerateRequest | ParlayRejection {
  if (typeof raw !== "object" || raw === null) return { error: INVALID_REQUEST };
  const { leagues, slipPickIds, targets, settings } = raw as Record<string, unknown>;
  if (!Array.isArray(leagues) || !leagues.every((l) => typeof l === "string" && LIVE_LABELS.has(l))) return { error: INVALID_REQUEST };
  if (!Array.isArray(slipPickIds) || !Array.isArray(targets)) return { error: INVALID_REQUEST };
  if (slipPickIds.length > MAX_POOL_REQUEST_PICKS || targets.length > MAX_POOL_REQUEST_PICKS) return { error: TOO_MANY };
  if (!slipPickIds.every(okId)) return { error: INVALID_REQUEST };
  const parsedTargets: GenerateTarget[] = [];
  for (const t of targets) {
    if (typeof t !== "object" || t === null) return { error: INVALID_REQUEST };
    const { gameId, leagueName } = t as Record<string, unknown>;
    if (!okId(gameId) || typeof leagueName !== "string" || !LIVE_LABELS.has(leagueName)) return { error: INVALID_REQUEST };
    if (!parsedTargets.some((p) => p.gameId === gameId)) parsedTargets.push({ gameId, leagueName });
  }
  if (typeof settings !== "object" || settings === null) return { error: INVALID_REQUEST };
  const s = settings as Record<string, unknown>;
  const legCount = typeof s.legCount === "number" ? s.legCount : NaN;
  if (!Number.isFinite(legCount)) return { error: INVALID_REQUEST };
  const rejection = legCapRejection(legCount);
  if (rejection) return rejection;
  const fillFrom: FillFrom = s.fillFrom === "YOUR_PICKS_ONLY" ? "YOUR_PICKS_ONLY" : "BEST_AVAILABLE";
  const include = toIncludeSelection(s.include);
  return {
    leagues: Array.from(new Set(leagues as string[])),
    slipPickIds: Array.from(new Set(slipPickIds as string[])),
    targets: parsedTargets,
    settings: {
      legCount,
      maxLegsPerGame: typeof s.maxLegsPerGame === "number" ? s.maxLegsPerGame : 1,
      include,
      mix: toPickMix(s.mix, selectedCategories(include)),
      fillFrom,
      // Anything but a whole step in range is the 55% default.
      minWinPct: normalizeMinWinPct(s.minWinPct),
    },
  };
}

export async function generateParlayAction(request: GenerateRequest): Promise<GenerateResponse | ParlayRejection> {
  const user = await requireUser();
  const req = parseRequest(request);
  if ("error" in req) return req;

  const now = new Date();
  const loaded = await loadGeneratorSnapshot(user.id, req, now);
  if ("error" in loaded) return loaded;
  const { snapshot } = loaded;
  return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, now) };
}
