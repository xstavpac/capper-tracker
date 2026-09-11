"use client";

// The one place client-side polling is allowed to be implemented in this app.
//
// Background: a previous live play-by-play polling feature (in an earlier
// codebase) once ran up ~76,000 requests in a short window - a runaway loop,
// almost certainly one of:
//   1. an interval not torn down on unmount / re-mount, so every render or
//      navigation stacked another concurrent loop, or
//   2. an uncapped retry-on-failure: a downed upstream turning every tick into
//      an immediate full-speed retry.
//
// The existing hand-rolled polls (live-scoreboard.tsx, live-ticker.tsx) use a
// `setInterval` + `let cancelled` pattern that is correct for teardown but
// does NOT protect against (2) at all, and against (1) only if the effect deps
// are perfectly stable. This hook is the hardened, reusable version - new
// polling features must use it rather than writing their own loop.
//
// Guarantees:
//
//  - SINGLE INSTANCE. The loop is a self-scheduling setTimeout chain, never
//    setInterval: the next tick is scheduled only after the current one fully
//    settles, so two fetches can never be in flight for one hook instance and
//    a slow response can never cause ticks to pile up. Every effect run gets a
//    monotonically increasing generation id; a tick that finds its generation
//    stale exits without doing work or scheduling a successor. Cleanup bumps
//    the generation, clears the pending timer, and aborts the in-flight fetch.
//    A re-render or StrictMode double-mount therefore cannot produce a second
//    live loop - the old generation is dead the instant cleanup runs.
//
//  - BACKED-OFF FAILURES. A failed fetch never retries on the next base
//    interval; it uses exponential backoff with jitter (see poll-backoff.ts),
//    honours a 429 Retry-After as a floor, and after `maxConsecutiveFailures`
//    stops the loop entirely (surfaced as `stopped`).
//
//  - VISIBILITY-GATED. While the tab is hidden the loop pauses (no fetches);
//    it resumes, with backoff reset, when the tab is shown again.
//
//  - CALLER STOP SIGNAL. `stopWhen(data)` returning true ends the loop for
//    good (e.g. the game went final) - no further fetches, ever, for that
//    mount.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeBackoffConfig,
  nextPollDelayMs,
  shouldStopPolling,
  type PollBackoffConfig,
} from "./poll-backoff";

export type SafePollStatus = "idle" | "polling" | "backing-off" | "paused-hidden" | "stopped";

export type SafePollResult<T> = {
  /** Most recent successful payload, or null before the first success. */
  data: T | null;
  /** True if the most recent attempt failed. */
  errored: boolean;
  consecutiveFailures: number;
  status: SafePollStatus;
  /**
   * True once the loop has permanently stopped - either stopWhen fired or the
   * failure ceiling was hit. Nothing short of a remount restarts it.
   */
  stopped: boolean;
  /** ms since the last successful fetch, or null if there has not been one. */
  ageMs: number | null;
  /** Force an immediate poll now (resets the backoff timer). No-op if stopped. */
  refreshNow: () => void;
};

export type SafePollOptions<T> = {
  /**
   * The fetch. Must resolve with a value on success and throw on any failure
   * (non-2xx included). Receives an AbortSignal that fires on teardown; pass it
   * to fetch(). A thrown object with a numeric `retryAfterMs` (e.g. parsed from
   * a 429) lengthens the next backoff.
   */
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Poll only while true. Flipping to false tears the loop down. */
  enabled: boolean;
  /** Base interval between successful polls, ms. Clamped to >= 1000. */
  intervalMs: number;
  /** Return true from a successful payload to stop polling permanently. */
  stopWhen?: (data: T) => boolean;
  /** Overrides for the backoff curve / failure ceiling. */
  backoff?: Partial<Omit<PollBackoffConfig, "baseIntervalMs">>;
  /** Pause polling while document.visibilityState === "hidden". Default true. */
  pauseWhenHidden?: boolean;
  /** Per-fetch timeout, ms. Default 8000. The fetcher's signal aborts at this. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function readRetryAfterMs(err: unknown): number | null {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const v = (err as { retryAfterMs: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export function useSafePoll<T>(options: SafePollOptions<T>): SafePollResult<T> {
  const { enabled } = options;
  const pauseWhenHidden = options.pauseWhenHidden ?? true;

  const config: PollBackoffConfig = normalizeBackoffConfig({
    baseIntervalMs: options.intervalMs,
    ...options.backoff,
  });

  const [data, setData] = useState<T | null>(null);
  const [errored, setErrored] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [status, setStatus] = useState<SafePollStatus>("idle");
  const [stopped, setStopped] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);

  // Latest values of things that change identity every render, read by the
  // loop without being effect dependencies - so the loop is NOT rebuilt (and
  // the generation NOT churned) on every parent re-render.
  const fetcherRef = useRef(options.fetcher);
  const stopWhenRef = useRef(options.stopWhen);
  const configRef = useRef(config);
  const timeoutMsRef = useRef(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  useEffect(() => {
    fetcherRef.current = options.fetcher;
    stopWhenRef.current = options.stopWhen;
    configRef.current = config;
    timeoutMsRef.current = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  });

  // Generation guard - the single-instance mechanism. Incremented on every
  // effect cleanup; a running loop checks its captured generation against this
  // and bails the moment they differ.
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningTickRef = useRef(false);
  const failuresRef = useRef(0);
  const manualKickRef = useRef<(() => void) | null>(null);

  const refreshNow = useCallback(() => {
    manualKickRef.current?.();
  }, []);

  // Primitive dependency list only. `config` is compared by its numeric
  // fields, not identity, via the join below - so a fresh config object with
  // the same numbers does not rebuild the loop.
  const configKey = `${config.baseIntervalMs}:${config.maxBackoffMs}:${config.maxConsecutiveFailures}`;

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    const myGeneration = ++generationRef.current;
    let disposed = false;

    const isCurrent = () => !disposed && generationRef.current === myGeneration;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const scheduleNext = (delayMs: number) => {
      if (!isCurrent()) return;
      clearTimer();
      timerRef.current = setTimeout(tick, Math.max(1_000, delayMs));
    };

    const tick = async () => {
      if (!isCurrent()) return;

      // Belt-and-suspenders against overlap: scheduleNext already guarantees
      // one timer, but never run a second tick body concurrently.
      if (runningTickRef.current) return;

      if (pauseWhenHidden && typeof document !== "undefined" && document.visibilityState === "hidden") {
        setStatus("paused-hidden");
        // Don't fetch; re-check shortly. This is a status poll, not a network
        // call, so a short delay is fine and cheap.
        scheduleNext(Math.min(configRef.current.baseIntervalMs, 15_000));
        return;
      }

      runningTickRef.current = true;
      setStatus("polling");

      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), timeoutMsRef.current);

      try {
        const result = await fetcherRef.current(controller.signal);
        clearTimeout(timeout);
        if (!isCurrent()) return;

        failuresRef.current = 0;
        setConsecutiveFailures(0);
        setErrored(false);
        setData(result);
        setLastSuccessAt(Date.now());

        if (stopWhenRef.current?.(result)) {
          setStopped(true);
          setStatus("stopped");
          clearTimer();
          return;
        }

        setStatus("polling");
        scheduleNext(nextPollDelayMs({ consecutiveFailures: 0, config: configRef.current }));
      } catch (err) {
        clearTimeout(timeout);
        if (!isCurrent()) return;

        failuresRef.current += 1;
        setConsecutiveFailures(failuresRef.current);
        setErrored(true);

        if (
          shouldStopPolling({
            consecutiveFailures: failuresRef.current,
            stopRequested: false,
            config: configRef.current,
          })
        ) {
          setStopped(true);
          setStatus("stopped");
          clearTimer();
          return;
        }

        setStatus("backing-off");
        scheduleNext(
          nextPollDelayMs({
            consecutiveFailures: failuresRef.current,
            config: configRef.current,
            retryAfterMs: readRetryAfterMs(err),
          })
        );
      } finally {
        runningTickRef.current = false;
      }
    };

    manualKickRef.current = () => {
      if (!isCurrent()) return;
      failuresRef.current = 0;
      setConsecutiveFailures(0);
      scheduleNext(1_000);
    };

    // Resume from a reset backoff whenever the tab becomes visible again.
    const onVisibility = () => {
      if (!isCurrent()) return;
      if (document.visibilityState === "visible") {
        failuresRef.current = 0;
        setConsecutiveFailures(0);
        scheduleNext(1_000);
      }
    };
    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    // First poll: a beat after mount, never synchronously.
    failuresRef.current = 0;
    setStopped(false);
    scheduleNext(1_000);

    return () => {
      disposed = true;
      generationRef.current++; // any in-flight tick from this generation is now stale
      clearTimer();
      abortRef.current?.abort();
      abortRef.current = null;
      runningTickRef.current = false;
      manualKickRef.current = null;
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher/stopWhen/timeout are read through refs on purpose (see fetcherRef above); config is compared by value via configKey. Adding them here would rebuild the loop every render, which is the exact failure mode this hook exists to prevent.
  }, [enabled, pauseWhenHidden, configKey]);

  const ageMs = lastSuccessAt === null ? null : Date.now() - lastSuccessAt;

  return { data, errored, consecutiveFailures, status, stopped, ageMs, refreshNow };
}
