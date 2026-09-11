"use client";

import { useSafePoll } from "@/lib/use-safe-poll";
import { PaceGauge } from "@/components/live/pace-gauge";
import type { NflPacePayload } from "@/server/data/nfl-pace-data";

// NFL sibling of game-pace-panel.tsx - see that file's header for the
// shared-live-fetch/separate-route rationale, identical here.
const PACE_POLL_INTERVAL_MS = 25_000;

type PaceResponse = { pace: NflPacePayload | null };

function paceUrl(eventId: string, homeTeam: string, awayTeam: string, gameDateIso: string): string {
  const params = new URLSearchParams({
    sport: "americanfootball_nfl",
    gamePk: eventId,
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

// Same mt-4 as NflGameMomentumPanel's own PanelShell (untouched) - see
// game-pace-panel.tsx's identical comment for why this must match exactly.
function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">Pace</div>
      {children}
    </div>
  );
}

// Renders alongside NflGameMomentumPanel on the NFL game-detail page (see
// live/[gameId]/page.tsx). Most NFL matchups will show "not enough data"
// for a while - baseline eligibility needs one completed REGULAR-SEASON
// game per team, so this stays quiet until Sunday's slate starts finishing
// (see nfl-pace-data.ts's header) - expected, not a bug.
export function NflGamePacePanel({
  eventId,
  homeTeam,
  awayTeam,
  gameDate,
  isLive,
  isFinal,
}: {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: string; // ISO
  isLive: boolean;
  isFinal: boolean;
}) {
  const enabled = isLive || isFinal;
  const url = paceUrl(eventId, homeTeam, awayTeam, gameDate);

  const poll = useSafePoll<PaceResponse>({
    fetcher: (signal) => fetchPace(url, signal),
    enabled,
    intervalMs: PACE_POLL_INTERVAL_MS,
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
