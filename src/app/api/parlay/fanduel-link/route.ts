import { requireUser } from "@/server/auth";
import { getFanDuelLink } from "@/server/data/fanduel-link";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";

export const dynamic = "force-dynamic";

const MAX_PICK_ID_LENGTH = 64;

// "Send to FanDuel" on /parlay: the legs of one built parlay, named by pick
// id only. The picks are read here, scoped to the signed-in user - no bet,
// FanDuel id or link is ever taken from the request. Called on a tap of the
// button and at no other time (it spends Odds API credits).
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const pickIds = (body as { pickIds?: unknown } | null)?.pickIds;
  if (
    !Array.isArray(pickIds) ||
    pickIds.length === 0 ||
    pickIds.length > MAX_PARLAY_LEGS ||
    !pickIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_PICK_ID_LENGTH)
  ) {
    return Response.json({ error: "invalid pickIds" }, { status: 400 });
  }

  try {
    return Response.json(await getFanDuelLink(user.id, Array.from(new Set(pickIds as string[]))));
  } catch (err) {
    console.error("[fanduel-link] request failed", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
