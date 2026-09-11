"use client";

import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import type { PaceClassification } from "@/server/data/pace";

// One gauge shared by BOTH sports - unlike Momentum's two independent gauge
// components, Pace's classification shape (pace.ts's PaceClassification/
// PaceTrend) is genuinely sport-agnostic: mlb-pace.ts and nfl-pace.ts each
// derive their own ratio from their own game state, but by the time it
// reaches this component it's just "a ratio and a 5-bucket label", so one
// component renders either sport's output with no sport-specific import at
// all. Same semicircle-dial construction as momentum-gauge.tsx.
const GAUGE_VIEWBOX_W = 200;
const GAUGE_VIEWBOX_H = 112;
const GAUGE_CX = 100;
const GAUGE_CY = 100;
const GAUGE_R = 78;
const GAUGE_STROKE = 14;
const ARC_PATH = `M ${GAUGE_CX - GAUGE_R} ${GAUGE_CY} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${GAUGE_CX + GAUGE_R} ${GAUGE_CY}`;

// Slower sits on the LEFT, faster on the RIGHT - "slower" reads as a
// deceleration (left, like a rewind) and "faster" as forward motion
// (right), independent of any team/side ordering (Pace has no home/away
// lean - it's strictly about scoring speed, never a betting direction).
const CLASSIFICATION_LABEL: Record<PaceClassification, string> = {
  MUCH_SLOWER: "Much Slower",
  SLOWER: "Slower",
  NEAR_EXPECTED: "Near Expected",
  FASTER: "Faster",
  MUCH_FASTER: "Much Faster",
};

function needleColorFor(classification: PaceClassification): string {
  if (classification === "MUCH_FASTER" || classification === "FASTER") return "#dc2626"; // red-600 - faster than expected
  if (classification === "MUCH_SLOWER" || classification === "SLOWER") return "#2563eb"; // blue-600 - slower than expected
  return "#9ca3af"; // gray-400 - near expected
}

// ratio is actual/expected scoring so far (1.0 = exactly on the expected
// trajectory). Clamped to a fixed +/-1 point-of-ratio band around 1.0 for
// the needle's visual position only - classification (computed server-side
// against each sport's own tuned thresholds) is what the label actually
// reads, this just needs SOME stable visual scale that doesn't need to know
// which sport's thresholds produced the ratio.
function needleT(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.max(-1, Math.min(1, ratio - 1));
}

function Dial({ ratio, classification }: { ratio: number; classification: PaceClassification }) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const trackColor = isDark ? "#374151" : "#e5e7eb";
  const needleColor = needleColorFor(classification);

  const t = needleT(ratio);
  // t=-1 (much slower) -> 180deg (left), t=0 (on pace) -> 90deg (straight
  // up), t=1 (much faster) -> 0deg (right).
  const angleRad = ((90 - t * 90) * Math.PI) / 180;
  const needleLen = GAUGE_R - 12;
  const tipX = GAUGE_CX + needleLen * Math.cos(angleRad);
  const tipY = GAUGE_CY - needleLen * Math.sin(angleRad);

  return (
    <svg viewBox={`0 0 ${GAUGE_VIEWBOX_W} ${GAUGE_VIEWBOX_H}`} className="h-[112px] w-[200px]">
      <path d={ARC_PATH} pathLength={100} fill="none" stroke={trackColor} strokeWidth={GAUGE_STROKE} strokeLinecap="round" />
      <line x1={GAUGE_CX} y1={GAUGE_CY} x2={tipX} y2={tipY} stroke={needleColor} strokeWidth={4} strokeLinecap="round" />
      <circle cx={GAUGE_CX} cy={GAUGE_CY} r={6} fill={needleColor} />
    </svg>
  );
}

// Pure presentational gauge - no fetching, no polling. GamePacePanel /
// NflGamePacePanel own the live poll loop and pass this whatever they last
// got back. Strictly descriptive, per the whitepaper's own framing for
// Momentum: "Pace: Faster" is a description of scoring speed, never a
// betting recommendation.
export function PaceGauge({
  classification,
  ratio,
  readyForRead,
}: {
  classification: PaceClassification;
  ratio: number;
  readyForRead: boolean;
}) {
  return (
    <div>
      <div className="flex flex-col items-center pt-4">
        <Dial ratio={ratio} classification={classification} />
        <div className="mt-1 flex w-full max-w-[240px] items-center justify-between px-2 text-xs text-muted-foreground">
          <span>Slower</span>
          <span>Faster</span>
        </div>
        <div className="mt-2 text-base font-semibold text-foreground">
          {readyForRead ? `Pace: ${CLASSIFICATION_LABEL[classification]}` : "Warming up"}
        </div>
        {!readyForRead && (
          <p className="mt-0.5 px-4 text-center text-xs text-muted-foreground">
            Not enough game action yet for a reliable read - checks back every play.
          </p>
        )}
      </div>
    </div>
  );
}
