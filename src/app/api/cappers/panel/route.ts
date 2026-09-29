import { requireUser } from "@/server/auth";
import { getPanelRows } from "@/server/data/cappers-page-aggregates";
import { PANEL_KEYS, PANEL_WINDOWS, type PanelKey, type PanelWindow } from "@/lib/cappers-panels";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { RateLimiter, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The /cappers panels' window dropdown: ONE panel at ONE window (a single small statement, at most
// five rows, well under 2 KB), never the whole page. Per-user (requireUser + the userId in every
// query and in the cache key), so nothing crosses accounts; `private, no-store` keeps any shared
// cache from holding it either. The server cache is a 60 s backstop against a user flipping the
// dropdown back and forth; its callback is a pure read, so it has no side effects.
const PANEL_REVALIDATE_SECONDS = 60;
const perUserLimiter = new RateLimiter({ name: "cappers-panel-per-user", limit: 60, windowMs: 60_000 });

export async function GET(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const panel = params.get("panel");
  const window = params.get("window");
  if (!PANEL_KEYS.includes(panel as PanelKey) || !PANEL_WINDOWS.includes(window as PanelWindow)) {
    return Response.json({ error: "invalid panel or window" }, { status: 400 });
  }

  const limit = perUserLimiter.check(user.id);
  if (!limit.ok) return rateLimitResponse(limit.retryAfterSeconds);

  const userId = user.id;
  const rows = await cachedByTag(cacheKeys.cappersPanel(userId, panel!, window!), PANEL_REVALIDATE_SECONDS, () =>
    getPanelRows({ userId, panel: panel as PanelKey, window: window as PanelWindow })
  );
  return Response.json({ rows }, { headers: { "cache-control": "private, no-store" } });
}
