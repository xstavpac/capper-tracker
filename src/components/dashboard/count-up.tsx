"use client";

import { useEffect, useRef, useState } from "react";

// Slower and less front-loaded than the 0.8s/cubic pairing this replaced -
// cubic's steep initial deceleration made the climb read as "jump most of
// the way, then crawl" at 800ms. Quad decelerates more gradually, and the
// extra ~250ms gives that gentler curve room to read as a smooth glide
// instead of a snap.
export const DURATION_MS = 1050;

function easeOutQuad(t: number) {
  return 1 - Math.pow(1 - t, 2);
}

// Animates from 0 up to `value` on mount, optionally held at 0 for
// `startDelayMs` first - lets a caller (energy-surge.tsx) sequence this
// after its own lead-in animation instead of both running concurrently.
// Formatting is plain serializable props (not a function) because this
// renders inside a Server Component - React can't pass functions across
// that boundary to a Client Component.
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
  const [display, setDisplay] = useState(0);
  const frame = useRef<number>();

  useEffect(() => {
    // Captured on the first actual tick (after the delay), not at effect-run
    // time - so DURATION_MS measures the climb itself, not climb+delay.
    let rafStart: number | null = null;
    function tick(now: number) {
      if (rafStart === null) rafStart = now;
      const t = Math.min(1, (now - rafStart) / DURATION_MS);
      setDisplay(value * easeOutQuad(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    }
    const timer = window.setTimeout(() => {
      frame.current = requestAnimationFrame(tick);
    }, startDelayMs);
    return () => {
      window.clearTimeout(timer);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [value, startDelayMs]);

  const abs = Math.abs(display);
  const body = commas
    ? abs.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : abs.toFixed(decimals);
  const sign = display < 0 ? "-" : signed ? "+" : "";

  return (
    <>
      {sign}
      {body}
      {suffix}
    </>
  );
}
