"use client";

import { useEffect, useRef, useState } from "react";

// Matches the 0.8s fill-bar animation duration used elsewhere on the
// Dashboard (Rising/Best Last-20 progress bars), so the page's load-in
// animations feel like one consistent effect rather than several different
// speeds.
const DURATION_MS = 800;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Animates from 0 up to `value` on mount. Formatting is plain serializable
// props (not a function) because this renders inside a Server Component -
// React can't pass functions across that boundary to a Client Component.
export function CountUp({
  value,
  decimals = 0,
  signed = false,
  suffix = "",
  commas = false,
}: {
  value: number;
  decimals?: number;
  signed?: boolean;
  suffix?: string;
  commas?: boolean;
}) {
  const [display, setDisplay] = useState(0);
  const frame = useRef<number>();

  useEffect(() => {
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / DURATION_MS);
      setDisplay(value * easeOutCubic(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    }
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [value]);

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
