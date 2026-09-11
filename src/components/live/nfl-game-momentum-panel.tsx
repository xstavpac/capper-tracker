"use client";

import { useSafePoll } from "@/lib/use-safe-poll";
import { NflMomentumGauge } from "@/components/live/nfl-momentum-gauge";
import type { NflMomentumPayload } from "@/server/data/nfl-momentum-data";

// Polled via useSafePoll (src/lib/use-safe-poll.ts) - the same #61 infra
// MLB's GameMomentumPanel uses, reused directly rather than rebuilt (see
// docs/live-polling-safeguards.md). ESPN's endpoints are unofficial/
// undocumented with no published rate-limit contract, which is exactly why
// this safe-polling layer (backoff, visibility-gating, a hard failure
// ceiling) matters here even more than for MLB's official StatsAPI.
const MOMENTUM_POLL_INTERVAL_MS = 25_000;

type MomentumResponse = { momentum: NflMomentumPayload | null };

function momentumUrl(eventId: string, homeTeam: string, awayTeam: string, gameDateIso: string): string {
  const params = new URLSearchParams({
    sport: "americanfootball_nfl",
    // Query param is named gamePk for historical/shared-route reasons (see
    // api/live/momentum/route.ts) - the value is this game's ESPN event id.
    gamePk: eventId,
    homeTeam,
    awayTeam,
    gameDate: gameDateIso,
  });
  return `/api/live/momentum?${params.toString()}`;
}

async function fetchMomentum(url: string, signal: AbortSignal): Promise<MomentumResponse> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    if (res.status === 429 || res.status === 503) {
      const body = await res.json().catch(() => null);
      const retryAfterSeconds = body && typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null;
      if (retryAfterSeconds !== null) throw { retryAfterMs: retryAfterSeconds * 1000 };
    }
    throw new Error(`momentum fetch failed: ${res.status}`);
  }
  return res.json();
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-card bg-card shadow-soft">
      <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">Momentum</div>
      {children}
    </div>
  );
}

// Replaces GamePulsePanel for NFL on the game-detail page (see
// live/[gameId]/page.tsx) - MLB's GamePulsePanel replacement (and MLB's
// GameMomentumPanel) are untouched; this is the NFL sibling, independent
// per nfl-momentum.ts's file-independence rationale.
export function NflGameMomentumPanel({
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
  // Same pregame/live/final gating as MLB's panel: no poll before kickoff
  // (ESPN's summary winprobability is empty pregame anyway), exactly one
  // fetch for a final game (stopWhen fires after the first success), and
  // normal-cadence polling for the life of this mount while live.
  const enabled = isLive || isFinal;
  const url = momentumUrl(eventId, homeTeam, awayTeam, gameDate);

  const poll = useSafePoll<MomentumResponse>({
    fetcher: (signal) => fetchMomentum(url, signal),
    enabled,
    intervalMs: MOMENTUM_POLL_INTERVAL_MS,
    stopWhen: isFinal ? () => true : undefined,
  });

  if (!enabled) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Momentum tracking starts once the game goes live.</p>
      </PanelShell>
    );
  }

  if (poll.stopped && !poll.data) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Momentum signal unavailable right now - reload to retry.</p>
      </PanelShell>
    );
  }

  const momentum = poll.data?.momentum ?? null;
  if (!momentum) {
    return (
      <PanelShell>
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">Loading momentum…</p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <NflMomentumGauge
        homeTeam={homeTeam}
        awayTeam={awayTeam}
        classification={momentum.trend.classification}
        netShift={momentum.trend.netShift}
        deltasConsidered={momentum.trend.deltasConsidered}
        factors={momentum.factors}
      />
      {poll.stopped && (
        <p className="border-t border-border-subtle px-5 py-2 text-center text-xs text-muted-foreground">
          Live updates stopped - showing the last signal received.
        </p>
      )}
    </PanelShell>
  );
}
