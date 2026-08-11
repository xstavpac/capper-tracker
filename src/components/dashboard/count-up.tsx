"use client";

import { useEffect, useRef, useState } from "react";

// Matches the 0.8s fill-bar animation duration used elsewhere on the
// Dashboard (Rising/Best Last-20 progress bars), so the page's load-in
// animations feel like one consistent effect rather than several different
// speeds.
export const DURATION_MS = 800;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
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
      setDisplay(value * easeOutCubic(t));
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
