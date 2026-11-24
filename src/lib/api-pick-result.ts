// The per-pick results of POST /api/v1/picks (bot API tokens), and the snapshot stored on ApiPickSubmission.result.
// Pure: shared by the endpoint (server/data/api-picks.ts) and the review queue (resolveReviewItem), which turns a
// needs_review submission into an accepted one with the same shape.
import type { LineGame, ReviewCandidate } from "@/lib/ingest-line-outcome";

export type ApiAcceptedPick = {
  league: string;
  game: LineGame | null;
  market: string;
  line: number | null;
  odds: number;
  pickId: string;
};

// Every reason a pick can be rejected with: the import's own, plus game_not_scheduled_yet (the endpoint's split of
// no_game_found, see api-picks.ts).
export type ApiRejectReason = string;

export type ApiPickResult =
  | { client_id: string; status: "accepted"; pick: ApiAcceptedPick }
  | { client_id: string; status: "needs_review"; reason: string; candidates: ReviewCandidate[] }
  | { client_id: string; status: "rejected"; reason: ApiRejectReason };

export function acceptedResult(clientId: string, pick: ApiAcceptedPick): ApiPickResult {
  return { client_id: clientId, status: "accepted", pick };
}

// The accepted pick from a stored review choice (the row resolveReviewItem inserts).
export function acceptedPickFromRow(
  row: { sportName: string; awayTeam: string; homeTeam: string; gameTime: Date; betType: string; line?: number | null; odds: number },
  pickId: string
): ApiAcceptedPick {
  return {
    league: row.sportName,
    game: { away: row.awayTeam, home: row.homeTeam, startsAt: row.gameTime.toISOString() },
    market: row.betType,
    line: row.line ?? null,
    odds: row.odds,
    pickId,
  };
}

export function isApiPickResult(value: unknown): value is ApiPickResult {
  if (!value || typeof value !== "object") return false;
  const v = value as { client_id?: unknown; status?: unknown };
  return typeof v.client_id === "string" && (v.status === "accepted" || v.status === "needs_review" || v.status === "rejected");
}

// A stored snapshot (jsonb sorts object keys) rebuilt in the response's own key order, so a resend returns exactly
// the bytes the first response had.
export function canonicalApiPickResult(r: ApiPickResult): ApiPickResult {
  if (r.status === "accepted") {
    const p = r.pick;
    const game = p.game ? { away: p.game.away, home: p.game.home, startsAt: p.game.startsAt } : null;
    return acceptedResult(r.client_id, { league: p.league, game, market: p.market, line: p.line, odds: p.odds, pickId: p.pickId });
  }
  if (r.status === "needs_review") {
    const candidates = r.candidates.map((c) => ({ label: c.label, league: c.league, game: c.game ? { away: c.game.away, home: c.game.home, startsAt: c.game.startsAt } : null }));
    return { client_id: r.client_id, status: "needs_review", reason: r.reason, candidates };
  }
  return { client_id: r.client_id, status: "rejected", reason: r.reason };
}
