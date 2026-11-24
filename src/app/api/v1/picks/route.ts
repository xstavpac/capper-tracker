import { NextResponse } from "next/server";
import { parseAllowedLeagues } from "@/lib/ingest-filters";
import { authenticateBearer } from "@/server/api-bearer-auth";
import { API_PICKS_MAX_BODY_BYTES, submitApiPicks, validateApiPicksBody } from "@/server/data/api-picks";
import { isInfraError } from "@/server/data/ingest-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Game matching for every held pick's choices runs inside the request (up to 50 picks).
export const maxDuration = 60;

// POST /api/v1/picks - a user's own bot posts picks with an API token ("bring your own bot").
//   header  Authorization: Bearer bv_live_...
//   body    { capper: string, picks: [{ client_id: string, text: string }] }   (<= 64 KB, 1-50 picks)
//   200     { results: [...] } in the request's order, one per client_id (see lib/api-pick-result.ts)
//   400     { error: "invalid_request", detail }     401 { error: "invalid_token" }     429 { error: "rate_limited", ... }
// Not a session route (see PUBLIC_ROUTES in middleware.ts): the bearer token is the whole authentication.

const badRequest = (detail: string) => NextResponse.json({ error: "invalid_request", detail }, { status: 400 });

export async function POST(req: Request) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return auth.response;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > API_PICKS_MAX_BODY_BYTES) return badRequest("body is larger than 64 KB");
  let raw: unknown;
  try {
    const bodyText = await req.text();
    if (Buffer.byteLength(bodyText, "utf8") > API_PICKS_MAX_BODY_BYTES) return badRequest("body is larger than 64 KB");
    raw = JSON.parse(bodyText);
  } catch {
    return badRequest("body must be valid JSON");
  }
  const checked = validateApiPicksBody(raw);
  if (!checked.ok) return badRequest(checked.detail);

  try {
    const results = await submitApiPicks({ tokenId: auth.tokenId, userId: auth.userId }, checked.body, {
      allowedLeagues: parseAllowedLeagues(process.env.INGEST_ALLOWED_LEAGUES),
    });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[ingest-api] request failed", { tokenId: auth.tokenId, infra: isInfraError(err), error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 });
  }
}
