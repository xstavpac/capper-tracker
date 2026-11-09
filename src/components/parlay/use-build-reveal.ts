"use client";

// The client-side sequencer for the pick-by-pick parlay build (build-reveal.ts has
// the timing). Presentation only: the engine has already answered with every leg;
// this only says how many of them to show yet and what the status line reads.
//
//   start()        - Generate / Regenerate clicked: the analyzing step begins. null
//                    under prefers-reduced-motion (the result shows at once).
//   land(id, n)    - the answer is in with n legs: building starts once the analyzing
//                    step has run ANALYZE_MIN_MS, then one leg per gap, then complete.
//   cancel()       - Clear result, an error, zero legs, a rebuild: every timer stops.
//
// One sequence at a time: start() and cancel() drop every pending timer, and a
// land() for a sequence that is no longer current does nothing. Timers stop on unmount.
import { useCallback, useEffect, useRef, useState } from "react";
import { ANALYZE_MIN_MS, ANALYZING_STATUS, addedStatus, findingStatus, revealSchedule, type RevealPhase } from "@/lib/parlay/build-reveal";

export type Reveal = {
  // Per sequence: the result card is keyed on it, so it never remounts while legs reveal.
  id: number;
  phase: RevealPhase;
  revealed: number;
  // The engine's leg count, once the answer is in.
  total: number | null;
  status: string;
};

export function prefersReducedMotion(): boolean {
  // No matchMedia (an old browser, a test DOM): no animation, the result as today.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useBuildReveal() {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const current = useRef(0);
  const startedAt = useRef(0);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const cancel = useCallback(() => {
    current.current++;
    clearTimers();
    setReveal(null);
  }, [clearTimers]);

  const start = useCallback((): number | null => {
    clearTimers();
    const id = ++current.current;
    if (prefersReducedMotion()) {
      setReveal(null);
      return null;
    }
    startedAt.current = Date.now();
    setReveal({ id, phase: "analyzing", revealed: 0, total: null, status: ANALYZING_STATUS });
    return id;
  }, [clearTimers]);

  const land = useCallback(
    (id: number, total: number) => {
      if (id !== current.current) return;
      const at = (ms: number, fn: () => void) =>
        timers.current.push(
          setTimeout(() => {
            if (id === current.current) fn();
          }, ms)
        );
      const update = (patch: Partial<Reveal>) => setReveal((r) => (r && r.id === id ? { ...r, ...patch } : r));
      update({ total });
      const wait = Math.max(0, ANALYZE_MIN_MS - (Date.now() - startedAt.current));
      at(wait, () => update({ phase: "building" }));
      for (const step of revealSchedule(total)) {
        if (step.kind === "status") at(wait + step.at, () => update({ status: findingStatus(step.index, total) }));
        else if (step.kind === "land") at(wait + step.at, () => update({ revealed: step.index + 1, status: addedStatus(step.index + 1) }));
        else at(wait + step.at, () => update({ phase: "complete", revealed: total }));
      }
    },
    []
  );

  return { reveal, start, land, cancel };
}
