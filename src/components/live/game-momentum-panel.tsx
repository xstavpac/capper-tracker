"use client";

import { useSafePoll } from "@/lib/use-safe-poll";
import { MomentumGauge } from "@/components/live/momentum-gauge";
import type { MlbMomentumPayload } from "@/server/data/mlb-momentum-data";

// Polled via useSafePoll (src/lib/use-safe-poll.ts) - the one sanctioned
// client polling loop in this app, see docs/live-polling-safeguards.md. This
// is the first real consumer of that infra: a self-scheduling, backed-off,
// visibility-gated loop hitting /api/live/momentum, which enforces its own
// server-side rate-limit ceilings on top of the shared per-game response
// cache in live-game-state.ts.
const MOMENTUM_POLL_INTERVAL_MS = 25_000;

type MomentumResponse = { momentum: MlbMomentumPayload | null };

function momentumUrl(gamePk: string, homeTeam: string, awayTeam: string, gameDateIso: string): string {
  const params = new URLSearchParams({
    sport: "baseball_mlb",
    gamePk,
    homeTeam,
    awayTeam,
    gameDate: gameDateIso,
  });
  return `/api/live/momentum?${params.toString()}`;
}

async function fetchMomentum(url: string, signal: AbortSignal): Promise<MomentumResponse> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    // A 429/503 body carries retryAfterSeconds - surfacing it as
    // retryAfterMs on the thrown error lets useSafePoll honour it as a
    // backoff floor instead of retrying at the base interval.
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

// Replaces GamePulsePanel for MLB on the game-detail page (see
// live/[gameId]/page.tsx) - Game Pulse itself does no live fetching (Phase 1
// investigation finding) and remains in place for every other sport.
export function GameMomentumPanel({
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
  // Preview games never poll (nothing to fetch yet - the winProbability
  // endpoint 404s pregame). Final games fetch exactly once (stopWhen fires
  // after the first success) to show the finished game's momentum record
  // without polling a game that will never produce another play. Live games
  // poll on the normal cadence and keep going for the life of this mount -
  // this page doesn't itself refresh isLive/isFinal after the initial
  // server render (a pre-existing property of this page, not something this
  // panel changes), so a game that goes final mid-visit keeps polling until
  // the user reloads, same as the rest of this page's live data today.
  const enabled = isLive || isFinal;
  const url = momentumUrl(gamePk, homeTeam, awayTeam, gameDate);

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
      <MomentumGauge
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
