"use client";

import { useEffect, useRef } from "react";

// History: 800ms/cubic read as "jump most of the way, then crawl" (cubic's
// initial deceleration is even steeper than quad's). Switched to quad and
// slowed to 1050ms, then - once the setState->ref-write fix below actually
// made the motion smooth enough to watch - doubled again to 2100ms, since at
// 1050ms the climb was over before the deceleration had room to read as
// deliberate.
//
// 2100ms still read as too fast. Confirmed genuinely running at 2100ms in
// the deployed build (grepped the compiled chunk directly:
// `Math.min(1,(d-s)/2100)`) and confirmed DURATION_MS is the only knob
// controlling this climb - the real problem was the curve shape, not the
// duration or a stale value. easeOutQuad(t) = 1-(1-t)^2 is front-loaded by
// construction: it reaches 75% of the distance at just 50% of the elapsed
// time, and 91% by 70% elapsed - so most of the visible motion happens in
// the first half, and the back half of every duration we tried was mostly a
// long, barely-moving crawl into the final number, which reads as "it
// finished early" regardless of how long DURATION_MS actually is.
//
// Replaced with easeInOutQuad, which eases IN at the start as well as out
// at the end - 8% done at 20% elapsed, 50% done at 50% elapsed, 92% done at
// 80% elapsed - so the motion is spread evenly across the whole duration
// instead of front-loaded into the first half, while still keeping a
// (shorter, gentler) deceleration into the final number rather than
// snapping to a stop the way pure linear would. Quadrupled from the
// original 1050ms to 4000ms on top of that, per explicit request for an
// obvious difference rather than another small bump.
export const DURATION_MS = 4000;

export function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
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
        ref.current.textContent = formatCountUpValue(value * easeInOutQuad(t), decimals, signed, suffix, commas);
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
