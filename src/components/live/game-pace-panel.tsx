"use client";

import { useSafePoll } from "@/lib/use-safe-poll";
import { PaceGauge } from "@/components/live/pace-gauge";
import type { MlbPacePayload } from "@/server/data/mlb-pace-data";

// Polled via useSafePoll, same #61 infra GameMomentumPanel uses - see
// docs/live-polling-safeguards.md. A separate poll loop from Momentum's
// (different route, /api/live/pace - see that route's own header for why),
// but both loops ultimately share the SAME cached live-state fetch
// underneath (live-game-state.ts), so running both panels on one game page
// costs one live fetch, not two.
const PACE_POLL_INTERVAL_MS = 25_000;

type PaceResponse = { pace: MlbPacePayload | null };

function paceUrl(gamePk: string, homeTeam: string, awayTeam: string, gameDateIso: string): string {
  const params = new URLSearchParams({
    sport: "baseball_mlb",
    gamePk,
    homeTeam,
    awayTeam,
    gameDate: gameDateIso,
  });
  return `/api/live/pace?${params.toString()}`;
}

async function fetchPace(url: string, signal: AbortSignal): Promise<PaceResponse> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    if (res.status === 429 || res.status === 503) {
      const body = await res.json().catch(() => null);
      const retryAfterSeconds = body && typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null;
      if (retryAfterSeconds !== null) throw { retryAfterMs: retryAfterSeconds * 1000 };
    }
    throw new Error(`pace fetch failed: ${res.status}`);
  }
  return res.json();
}

// Same mt-4 as GameMomentumPanel's own PanelShell (untouched, not imported
// from here - see nfl-momentum.ts's file-independence rationale for why
// Momentum's own files stay unmodified) - matching it exactly means the two
// panels' headers land on the same row when placed side by side in the
// page's grid, rather than one sitting 16px lower than the other.
function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">Pace</div>
      {children}
    </div>
  );
}

// Renders alongside GameMomentumPanel on the MLB game-detail page (see
// live/[gameId]/page.tsx) - two gauges side by side, same minimal polish
// level as Momentum, no Command Center treatment.
export function GamePacePanel({
  gamePk,
  homeTeam,
  awayTeam,
  gameDate,
  isLive,
  isFinal,
}: {
  gamePk: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: string; // ISO
  isLive: boolean;
  isFinal: boolean;
}) {
  const enabled = isLive || isFinal;
  const url = paceUrl(gamePk, homeTeam, awayTeam, gameDate);

  const poll = useSafePoll<PaceResponse>({
    fetcher: (signal) => fetchPace(url, signal),
    enabled,
    intervalMs: PACE_POLL_INTERVAL_MS,
    // Stop for good once the game is final, or as soon as we learn this
    // matchup isn't pace-eligible - a season baseline can't gain a same-day
    // sample mid-game, so nothing is gained by continuing to poll an
    // ineligible matchup.
    stopWhen: (data) => isFinal || data.pace?.eligible === false,
  });

  if (!enabled) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Pace tracking starts once the game goes live.</p>
      </PanelShell>
    );
  }

  if (poll.stopped && !poll.data) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Pace signal unavailable right now - reload to retry.</p>
      </PanelShell>
    );
  }

  const pace = poll.data?.pace ?? null;
  if (!pace) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Loading pace…</p>
      </PanelShell>
    );
  }

  if (!pace.eligible) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">
          Not enough season data yet - Pace needs at least one completed game apiece for {homeTeam} and {awayTeam}.
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <PaceGauge classification={pace.trend.classification} ratio={pace.trend.ratio} readyForRead={pace.trend.readyForRead} />
      {poll.stopped && (
        <p className="border-t border-border-subtle px-5 py-2 text-center text-xs text-muted-foreground">
          Live updates stopped - showing the last signal received.
        </p>
      )}
    </PanelShell>
  );
}
