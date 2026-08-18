"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CountUp } from "@/components/dashboard/count-up";
import { RINGS, BOLTS, SURGE_DURATION_MS } from "@/components/dashboard/energy-surge-constants";

// Same bolt silhouette as LightningIcon (drop-catalog-button.tsx) - reused
// here at a smaller size so the two "energy" motifs in the app read as the
// same visual language.
const BOLT_PATH = "M13 2 3 14h7l-1 8 10-12h-7l1-8Z";

const TONE_HEX: Record<"up" | "down" | "neutral", string> = {
  up: "#059669", // emerald-600 - matches HeroStat's old text-emerald-600, readable enough on dark backgrounds unmodified
  down: "#dc2626", // red-600 - matches HeroStat's old text-red-600, readable enough on dark backgrounds unmodified
  // References the --foreground token (not a fixed hex, unlike up/down above) so it
  // flips light/dark with the theme - a literal gray-900 would render near-invisible
  // on a dark card.
  neutral: "rgb(var(--foreground))",
};

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
//
// `pushes` is optional (omit it, e.g. by passing undefined when a caller's
// own count is 0, to render just "wins-losses") - mirrors the
// non-animated record display's own convention of hiding a zero push count
// rather than always showing a "-0".
export function EnergyRecordCountUp({
  wins,
  losses,
  pushes,
  tone = "neutral",
  className = "",
}: {
  wins: number;
  losses: number;
  pushes?: number;
  tone?: "up" | "down" | "neutral";
  className?: string;
}) {
  return (
    <EnergySurge tone={tone} className={className}>
      <CountUp value={wins} startDelayMs={SURGE_DURATION_MS} />-<CountUp value={losses} startDelayMs={SURGE_DURATION_MS} />
      {pushes !== undefined && (
        <>
          -<CountUp value={pushes} startDelayMs={SURGE_DURATION_MS} />
        </>
      )}
    </EnergySurge>
  );
}
