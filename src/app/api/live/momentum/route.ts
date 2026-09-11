import { requireUser } from "@/server/auth";
import { getMlbMomentum } from "@/server/data/mlb-momentum-data";
import { RateLimiter, rateLimitResponse } from "@/lib/rate-limit";
import { CircuitOpenError } from "@/lib/circuit-breaker";

export const dynamic = "force-dynamic";

// Polled client-side by GameMomentumPanel (useSafePoll) to keep the MLB
// Momentum gauge live. Distinct from /api/live/scores (one batch call per
// sport) - this is per-GAME, so it needs its own rate-limit ceilings on top
// of the shared per-game response cache (live-game-state.ts). Three
// independent RateLimiter instances, exactly the three keys proposed in
// docs/live-polling-safeguards.md's "server-side hard ceiling" table:
// per-user+game guards one runaway tab, per-user guards one client opening
// many game tabs, and the route-global instance is the physical backstop if
// both of those are somehow defeated.
const perGameLimiter = new RateLimiter({ name: "momentum-per-game", limit: 12, windowMs: 60_000 });
const perUserLimiter = new RateLimiter({ name: "momentum-per-user", limit: 40, windowMs: 60_000 });
const globalLimiter = new RateLimiter({ name: "momentum-global", limit: 500, windowMs: 60_000 });

function circuitOpenResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: "momentum_upstream_unavailable", retryAfterSeconds },
    { status: 503, headers: { "retry-after": String(retryAfterSeconds) } }
  );
}

export async function GET(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sportKey = searchParams.get("sport");
  const gamePk = searchParams.get("gamePk");
  const homeTeam = searchParams.get("homeTeam");
  const awayTeam = searchParams.get("awayTeam");
  const gameDateRaw = searchParams.get("gameDate");

  if (!sportKey || !gamePk || !homeTeam || !awayTeam || !gameDateRaw) {
    return Response.json({ error: "missing required query params" }, { status: 400 });
  }

  // Momentum has an engine for MLB only (Task A's scope - Pace and every
  // other sport are explicitly out of scope this round). Reporting
  // `momentum: null` rather than 404 means a future sport's client code can
  // point at this same route before its own engine lands, matching
  // live-game-state.ts's getLiveGameState dispatch shape.
  if (sportKey !== "baseball_mlb") {
    return Response.json({ momentum: null });
  }

  const gameDate = new Date(gameDateRaw);
  if (Number.isNaN(gameDate.getTime())) {
    return Response.json({ error: "invalid gameDate" }, { status: 400 });
  }

  const gameLimit = perGameLimiter.check(`${user.id}:${gamePk}`);
  if (!gameLimit.ok) return rateLimitResponse(gameLimit.retryAfterSeconds);
  const userLimit = perUserLimiter.check(user.id);
  if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfterSeconds);
  const globalLimit = globalLimiter.check("momentum-route");
  if (!globalLimit.ok) return rateLimitResponse(globalLimit.retryAfterSeconds);

  try {
    const momentum = await getMlbMomentum({ gamePk, homeTeam, awayTeam, gameDate });
    return Response.json({ momentum });
  } catch (err) {
    if (err instanceof CircuitOpenError) return circuitOpenResponse(err.retryAfterMs);
    console.error("[api/live/momentum] failed", err);
    return Response.json({ error: "momentum_unavailable" }, { status: 502 });
  }
}
