"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CountUp, DURATION_MS } from "@/components/dashboard/count-up";

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
const RINGS = [0, 150, 300];

// 4 bolts at the corners of the number's own box, each with a different
// rotation/delay/duration so they don't read as four copies of one thing.
const BOLTS: { style: CSSProperties; delayMs: number; durationMs: number }[] = [
  { style: { top: -9, left: -11, transform: "rotate(-18deg)" }, delayMs: 0, durationMs: 520 },
  { style: { top: -9, right: -11, transform: "rotate(16deg)" }, delayMs: 70, durationMs: 460 },
  { style: { bottom: -9, left: -11, transform: "rotate(-9deg)" }, delayMs: 140, durationMs: 560 },
  { style: { bottom: -9, right: -11, transform: "rotate(24deg)" }, delayMs: 40, durationMs: 490 },
];

// Wraps a stat's rendered value with a one-shot "energy surge" completion
// effect - 3 expanding ring pulses, 4 crackling lightning bolts at the
// corners, and the number itself jittering/flashing electric blue before
// settling into its final tone color. Timed off CountUp's own DURATION_MS so
// it fires right as the count-up finishes, not a fixed guess at how long
// that takes. Works for any children (a live CountUp, or plain text like the
// Record stat's "W-L-P" string) so every hero stat can share one effect even
// though not all of them animate their own digits.
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

  // Runs once per mount, matching CountUp's own per-mount count-up - this
  // page is server-rendered fresh on each load/navigation, so "once per
  // mount" and "once per count-up completion" are the same event here.
  useEffect(() => {
    const timer = setTimeout(() => setSurge(true), DURATION_MS);
    return () => clearTimeout(timer);
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
      <CountUp value={value} decimals={decimals} signed={signed} suffix={suffix} commas={commas} />
    </EnergySurge>
  );
}
