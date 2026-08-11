"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CountUp } from "@/components/dashboard/count-up";

// Same bolt silhouette as LightningIcon (drop-catalog-button.tsx) - reused
// here at a smaller size so the two "energy" motifs in the app read as the
// same visual language.
const BOLT_PATH = "M13 2 3 14h7l-1 8 10-12h-7l1-8Z";

const TONE_HEX: Record<"up" | "down" | "neutral", string> = {
  up: "#059669", // emerald-600 - matches HeroStat's old text-emerald-600
  down: "#dc2626", // red-600 - matches HeroStat's old text-red-600
  neutral: "#111827", // gray-900 - matches HeroStat's/the big stats' old default
};

// One ring per entry, staggered via delayMs. Border only, no fill - a plain
// absolutely-positioned circle outline that scales up and fades out.
const RINGS = [0, 100, 200];

// Mirrors tailwind.config.ts's "energy-ring"/"energy-flash" animation
// durations - kept as plain numbers here (rather than parsed out of the
// Tailwind config) since that's the only place duration math for sequencing
// the count-up actually needs to happen. Update both together.
const RING_DURATION_MS = 700;
const FLASH_DURATION_MS = 650;

// 4 bolts at the corners of the number's own box, each with a different
// rotation/delay/duration so they don't read as four copies of one thing.
const BOLTS: { style: CSSProperties; delayMs: number; durationMs: number }[] = [
  { style: { top: -9, left: -11, transform: "rotate(-18deg)" }, delayMs: 0, durationMs: 520 },
  { style: { top: -9, right: -11, transform: "rotate(16deg)" }, delayMs: 70, durationMs: 460 },
  { style: { bottom: -9, left: -11, transform: "rotate(-9deg)" }, delayMs: 140, durationMs: 560 },
  { style: { bottom: -9, right: -11, transform: "rotate(24deg)" }, delayMs: 40, durationMs: 490 },
];

// When the last surge visual (whichever of the rings/bolts/flash finishes
// latest) actually completes - the count-up's startDelayMs, so the number
// only starts climbing once the flash/bolts/rings have fully played out
// instead of racing them. Rings are the long pole today (last ring's own
// delay + its duration), but this is computed rather than hardcoded so it
// stays correct if that ever changes.
export const SURGE_DURATION_MS = Math.max(
  Math.max(...RINGS) + RING_DURATION_MS,
  Math.max(...BOLTS.map((b) => b.delayMs + b.durationMs)),
  FLASH_DURATION_MS
);

// Wraps a stat's rendered value with a one-shot "energy surge" kickoff
// effect - 3 expanding ring pulses, 4 crackling lightning bolts at the
// corners, and the number itself jittering/flashing electric blue before
// settling into its final tone color. Fires immediately on mount; the
// count-up inside (EnergyCountUp/EnergyRecordCountUp below) waits out
// SURGE_DURATION_MS before it starts climbing, so the two read as one
// sequenced beat - surge first, then the number - rather than both firing
// at once. Works for any children, so every hero stat can share one effect.
export function EnergySurge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: "up" | "down" | "neutral";
  className?: string;
  children: ReactNode;
}) {
  const [surge, setSurge] = useState(false);

  // Starts false so the server-rendered markup and the pre-hydration client
  // render match (no surge overlay in either), then flips true as soon as
  // this effect runs post-mount - the earliest point a Client Component can
  // change its own state, which lands in the same commit as CountUp's own
  // mount effect kicking off its count-up.
  useEffect(() => {
    setSurge(true);
  }, []);

  return (
    <span className="relative inline-block">
      {surge && (
        <span className="pointer-events-none absolute inset-0" aria-hidden="true">
          {RINGS.map((delayMs) => (
            <span
              key={delayMs}
              className="absolute inset-0 rounded-full border-2 border-brand-400 animate-energy-ring"
              style={{ animationDelay: delayMs + "ms" }}
            />
          ))}
          {BOLTS.map((bolt, i) => (
            <span
              key={i}
              className="absolute text-[#22d3ee] animate-energy-bolt-crackle"
              style={{
                ...bolt.style,
                animationDelay: bolt.delayMs + "ms",
                animationDuration: bolt.durationMs + "ms",
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
                <path d={BOLT_PATH} />
              </svg>
            </span>
          ))}
        </span>
      )}
      <span
        className={"relative z-10 " + className + (surge ? " animate-energy-flash" : "")}
        style={{ ["--surge-color" as string]: TONE_HEX[tone], color: TONE_HEX[tone] }}
      >
        {children}
      </span>
    </span>
  );
}

export function EnergyCountUp({
  value,
  decimals = 0,
  signed = false,
  suffix = "",
  commas = false,
  tone = "neutral",
  className = "",
}: {
  value: number;
  decimals?: number;
  signed?: boolean;
  suffix?: string;
  commas?: boolean;
  tone?: "up" | "down" | "neutral";
  className?: string;
}) {
  return (
    <EnergySurge tone={tone} className={className}>
      <CountUp value={value} decimals={decimals} signed={signed} suffix={suffix} commas={commas} startDelayMs={SURGE_DURATION_MS} />
    </EnergySurge>
  );
}

// Record ("90-57-2") has no single number to count up - it's three. Each
// CountUp below mounts at the same time with the same DURATION_MS/easing/
// startDelayMs, so wins/losses/pushes count up in lockstep ("0-0-0" ->
// "90-57-2") once the shared surge finishes, rather than sitting there
// static while every other hero stat animates in.
export function EnergyRecordCountUp({
  wins,
  losses,
  pushes,
  tone = "neutral",
  className = "",
}: {
  wins: number;
  losses: number;
  pushes: number;
  tone?: "up" | "down" | "neutral";
  className?: string;
}) {
  return (
    <EnergySurge tone={tone} className={className}>
      <CountUp value={wins} startDelayMs={SURGE_DURATION_MS} />-<CountUp value={losses} startDelayMs={SURGE_DURATION_MS} />-<CountUp value={pushes} startDelayMs={SURGE_DURATION_MS} />
    </EnergySurge>
  );
}
