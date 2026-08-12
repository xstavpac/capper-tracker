import type { CSSProperties } from "react";

// Deliberately its own plain module, not exported from energy-surge.tsx -
// that file has "use client" at the top, and Next's RSC compiler treats
// EVERY export from a "use client" module as an opaque client reference when
// imported into a Server Component, even a plain number like SURGE_DURATION_MS
// (same gotcha already found and fixed for EXPANDABLE_ROWS_MAX - see
// expandable-rows-constants.ts). trending-cappers.tsx/capper-panels.tsx are
// both Server Components that need the real number to pass down as
// BarRow's startDelayMs, so these live here instead.

// One ring per entry, staggered via delayMs. Border only, no fill - a plain
// absolutely-positioned circle outline that scales up and fades out.
export const RINGS = [0, 100, 200];

// Mirrors tailwind.config.ts's "energy-ring"/"energy-flash" animation
// durations - kept as plain numbers here (rather than parsed out of the
// Tailwind config) since that's the only place duration math for sequencing
// the count-up actually needs to happen. Update both together.
export const RING_DURATION_MS = 700;
export const FLASH_DURATION_MS = 650;

// 4 bolts at the corners of the number's own box, each with a different
// rotation/delay/duration so they don't read as four copies of one thing.
export const BOLTS: { style: CSSProperties; delayMs: number; durationMs: number }[] = [
  { style: { top: -9, left: -11, transform: "rotate(-18deg)" }, delayMs: 0, durationMs: 520 },
  { style: { top: -9, right: -11, transform: "rotate(16deg)" }, delayMs: 70, durationMs: 460 },
  { style: { bottom: -9, left: -11, transform: "rotate(-9deg)" }, delayMs: 140, durationMs: 560 },
  { style: { bottom: -9, right: -11, transform: "rotate(24deg)" }, delayMs: 40, durationMs: 490 },
];

// When the last surge visual (whichever of the rings/bolts/flash finishes
// latest) actually completes - used both as the hero stat count-up's
// startDelayMs (energy-surge.tsx) and, now, as the Best/Worst Last-20 bars'
// startDelayMs (trending-cappers.tsx), so every load-in animation on the
// Dashboard waits out the same signal and starts in the same beat instead of
// each picking its own timing. Computed rather than hardcoded so it stays
// correct if the ring/bolt/flash timings above ever change.
export const SURGE_DURATION_MS = Math.max(
  Math.max(...RINGS) + RING_DURATION_MS,
  Math.max(...BOLTS.map((b) => b.delayMs + b.durationMs)),
  FLASH_DURATION_MS
);
