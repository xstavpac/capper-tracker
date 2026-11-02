import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { parseAllowedLeagues } from "@/lib/ingest-filters";
import { ingestTelegramBatch, isInfraError } from "@/server/data/telegram-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Game matching for every held pick's choices runs inside the request; a normal batch is a handful of lines.
export const maxDuration = 60;

// POST /api/ingest/telegram - the local Telegram reader posts one Drop Catalog batch per call.
//   header  x-picks-token: <PICKS_INGEST_TOKEN>
//   body    { channelId: string, messageId: number, day: "YYYY-MM-DD", text: string (<= 20 KB) }
// Not a session route (see PUBLIC_ROUTES in middleware.ts): the token is the whole authentication.

const MAX_TEXT_BYTES = 20 * 1024;
// Anything bigger than this is refused before it is parsed at all.
const MAX_BODY_BYTES = 64 * 1024;

// Compares digests, not the secrets: both buffers are always 32 bytes, so timingSafeEqual never throws on a length
// mismatch and the secret's length is not observable.
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

type Body = { channelId: string; messageId: number; day: string; text: string };

function validate(raw: unknown): { ok: true; body: Body } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const { channelId, messageId, day, text } = raw as Record<string, unknown>;
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 200) return { ok: false, error: "channelId must be a non-empty string (<= 200 chars)" };
  if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId < 0 || messageId > 2147483647) return { ok: false, error: "messageId must be an integer (0 to 2147483647)" };
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + "T00:00:00Z"))) return { ok: false, error: "day must be YYYY-MM-DD" };
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, error: "text must be a non-empty string" };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { ok: false, error: "text is larger than 20 KB" };
  return { ok: true, body: { channelId, messageId, day, text } };
}

export async function POST(req: Request) {
  const token = process.env.PICKS_INGEST_TOKEN;
  const userId = process.env.INGEST_USER_ID;
  if (!token || !userId) return NextResponse.json({ error: "ingest is not configured" }, { status: 503 });

  if (!tokenMatches(req.headers.get("x-picks-token"), token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 400 });
  let raw: unknown;
  try {
    const bodyText = await req.text();
    if (bodyText.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 400 });
    raw = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const checked = validate(raw);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  try {
    const result = await ingestTelegramBatch(checked.body, {
      userId,
      allowedLeagues: parseAllowedLeagues(process.env.INGEST_ALLOWED_LEAGUES),
    });
    return NextResponse.json(result);
  } catch (err) {
    // The database is unreachable (or the batch could not even be stored): 5xx, so the reader retries.
    console.error("[ingest-telegram] infrastructure error", { infra: isInfraError(err), channelId: checked.body.channelId, messageId: checked.body.messageId });
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503 });
  }
}
