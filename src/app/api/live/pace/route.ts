import { requireUser } from "@/server/auth";
import { getMlbPace } from "@/server/data/mlb-pace-data";
import { getNflPace } from "@/server/data/nfl-pace-data";
import { RateLimiter, rateLimitResponse } from "@/lib/rate-limit";
import { CircuitOpenError } from "@/lib/circuit-breaker";

export const dynamic = "force-dynamic";

// Polled client-side by GamePacePanel/NflGamePacePanel (useSafePoll) to keep
// the Pace gauge live. A separate route from /api/live/momentum (not a
// shared handler) so Pace's own rate-limit ceilings can never eat into
// Momentum's already-shipped budget or vice versa - own RateLimiter
// instances below, same three-tier shape docs/live-polling-safeguards.md
// specifies (per-game, per-user, route-global). The underlying live fetch
// is still shared (see mlb-pace-data.ts/nfl-pace-data.ts headers) - only the
// route-level rate limiting is duplicated, deliberately, for isolation.
const perGameLimiter = new RateLimiter({ name: "pace-per-game", limit: 12, windowMs: 60_000 });
const perUserLimiter = new RateLimiter({ name: "pace-per-user", limit: 40, windowMs: 60_000 });
const globalLimiter = new RateLimiter({ name: "pace-global", limit: 500, windowMs: 60_000 });

function circuitOpenResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: "pace_upstream_unavailable", retryAfterSeconds },
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
  // Named `gamePk` for consistency with /api/live/momentum's own query shape
  // (MLB's own id there; ESPN's event id for NFL).
  const gamePk = searchParams.get("gamePk");
  const homeTeam = searchParams.get("homeTeam");
  const awayTeam = searchParams.get("awayTeam");
  const gameDateRaw = searchParams.get("gameDate");

  if (!sportKey || !gamePk || !homeTeam || !awayTeam || !gameDateRaw) {
    return Response.json({ error: "missing required query params" }, { status: 400 });
  }

  // Pace has an engine for MLB and NFL only, same scope as Momentum.
  // Reporting `pace: null` rather than 404 means a future sport's client
  // code can point at this same route before its own engine lands.
  if (sportKey !== "baseball_mlb" && sportKey !== "americanfootball_nfl") {
    return Response.json({ pace: null });
  }

  const gameDate = new Date(gameDateRaw);
  if (Number.isNaN(gameDate.getTime())) {
    return Response.json({ error: "invalid gameDate" }, { status: 400 });
  }

  const gameLimit = perGameLimiter.check(`${user.id}:${gamePk}`);
  if (!gameLimit.ok) return rateLimitResponse(gameLimit.retryAfterSeconds);
  const userLimit = perUserLimiter.check(user.id);
  if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfterSeconds);
  const globalLimit = globalLimiter.check("pace-route");
  if (!globalLimit.ok) return rateLimitResponse(globalLimit.retryAfterSeconds);

  try {
    const pace =
      sportKey === "baseball_mlb"
        ? await getMlbPace({ gamePk, homeTeam, awayTeam, gameDate })
        : await getNflPace({ eventId: gamePk, homeTeam, awayTeam, gameDate });
    return Response.json({ pace });
  } catch (err) {
    if (err instanceof CircuitOpenError) return circuitOpenResponse(err.retryAfterMs);
    console.error("[api/live/pace] failed", err);
    return Response.json({ error: "pace_unavailable" }, { status: 502 });
  }
}
