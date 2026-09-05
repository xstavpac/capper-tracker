"use client";

import { useEffect, useRef } from "react";

// Slower and less front-loaded than the 0.8s/cubic pairing this replaced -
// cubic's steep initial deceleration made the climb read as "jump most of
// the way, then crawl" at 800ms. Quad decelerates more gradually, and the
// extra ~250ms gives that gentler curve room to read as a smooth glide
// instead of a snap.
export const DURATION_MS = 1050;

export function easeOutQuad(t: number) {
  return 1 - Math.pow(1 - t, 2);
}

// Pure formatting, factored out so it's independently testable (see
// count-up-acceptance-test.ts) and so the RAF loop below and the initial
// SSR/pre-animation render always produce output through the exact same
// path - no separate "final frame" formatting logic to drift out of sync
// with what every other frame shows.
export function formatCountUpValue(
  display: number,
  decimals: number,
  signed: boolean,
  suffix: string,
  commas: boolean
): string {
  const abs = Math.abs(display);
  const body = commas
    ? abs.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : abs.toFixed(decimals);
  const sign = display < 0 ? "-" : signed ? "+" : "";
  return `${sign}${body}${suffix}`;
}

// Animates from 0 up to `value` on mount, optionally held at 0 for
// `startDelayMs` first - lets a caller (energy-surge.tsx) sequence this
// after its own lead-in animation instead of both running concurrently.
// Formatting is plain serializable props (not a function) because this
// renders inside a Server Component - React can't pass functions across
// that boundary to a Client Component.
//
// Writes each frame's formatted string directly to the DOM node via a ref,
// bypassing React state/re-render for the animation itself - with several
// of these running at once (every dashboard hero stat, every category tile,
// every "Best/Worst last 20" row all mount and start climbing together),
// routing 60fps of updates through setState meant 60fps of component
// re-renders competing for main-thread time with the rest of the page's own
// mount/hydration work, which is what read as jittery/choppy rather than a
// flaw in the easing curve or the RAF-vs-setInterval choice (both were
// already correct). A ref write is a single, cheap DOM mutation - no
// reconciliation, no re-running this component's render body - so the
// visual update stays tied as directly as possible to the browser's own
// paint cycle regardless of how many of these are animating simultaneously.
export function CountUp({
  value,
  decimals = 0,
  signed = false,
  suffix = "",
  commas = false,
  startDelayMs = 0,
}: {
  value: number;
  decimals?: number;
  signed?: boolean;
  suffix?: string;
  commas?: boolean;
  startDelayMs?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Captured on the first actual tick (after the delay), not at effect-run
    // time - so DURATION_MS measures the climb itself, not climb+delay.
    let rafStart: number | null = null;
    let frame: number | undefined;
    function tick(now: number) {
      if (rafStart === null) rafStart = now;
      const t = Math.min(1, (now - rafStart) / DURATION_MS);
      if (ref.current) {
        ref.current.textContent = formatCountUpValue(value * easeOutQuad(t), decimals, signed, suffix, commas);
      }
      if (t < 1) frame = requestAnimationFrame(tick);
    }
    const timer = window.setTimeout(() => {
      frame = requestAnimationFrame(tick);
    }, startDelayMs);
    return () => {
      window.clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [value, decimals, signed, suffix, commas, startDelayMs]);

  // Initial (pre-animation) render - the exact same formatter, at display=0,
  // so hydration matches the server-rendered markup exactly before the
  // effect above ever runs.
  return <span ref={ref}>{formatCountUpValue(0, decimals, signed, suffix, commas)}</span>;
}
