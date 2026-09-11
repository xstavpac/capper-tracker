"use client";

import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import {
  MOMENTUM_STRONG_THRESHOLD,
  MOMENTUM_MIN_DELTAS_FOR_READ,
  type MomentumClassification,
  type MomentumFactor,
} from "@/server/data/mlb-momentum";

// Same semicircle-dial construction as BoardPulsePanel's Gauge
// (board-pulse-panel.tsx) - viewBox/radius/stroke chosen to match that
// panel's proportions since both live on the same /live surface. That gauge
// is a PROGRESS arc (0..1 fill); this one is a two-sided NEEDLE dial
// (away..home), which is why it draws a pointer instead of a dashed fill.
const GAUGE_VIEWBOX_W = 200;
const GAUGE_VIEWBOX_H = 112;
const GAUGE_CX = 100;
const GAUGE_CY = 100;
const GAUGE_R = 78;
const GAUGE_STROKE = 14;
const ARC_PATH = `M ${GAUGE_CX - GAUGE_R} ${GAUGE_CY} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${GAUGE_CX + GAUGE_R} ${GAUGE_CY}`;

// Away sits on the LEFT of the dial, home on the RIGHT - matches the rest of
// this page's away-then-home ordering (the score card lists away above home;
// Game Pulse's rows read away · home in that order too).
const CLASSIFICATION_LABEL: Record<MomentumClassification, (home: string, away: string) => string> = {
  STRONG_HOME: (home) => `Strong ${home} Momentum`,
  LEAN_HOME: (home) => `${home} Momentum Lean`,
  EVEN: () => "Even Momentum",
  LEAN_AWAY: (_home, away) => `${away} Momentum Lean`,
  STRONG_AWAY: (_home, away) => `Strong ${away} Momentum`,
};

function needleColorFor(classification: MomentumClassification): string {
  if (classification === "STRONG_HOME" || classification === "LEAN_HOME") return "#2563eb"; // blue-600 - home lean
  if (classification === "STRONG_AWAY" || classification === "LEAN_AWAY") return "#d97706"; // amber-600 - away lean
  return "#9ca3af"; // gray-400 - even
}

// netShift is a signed, effectively-unbounded WP-point sum (see
// computeMomentumTrend); the needle itself only needs a direction and a
// clamped magnitude, so it's normalized against the STRONG threshold - a
// shift at or beyond "strong" always points the needle all the way to that
// side, rather than needing its own separate scale.
function Dial({ netShift, classification }: { netShift: number; classification: MomentumClassification }) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const trackColor = isDark ? "#374151" : "#e5e7eb";
  const needleColor = needleColorFor(classification);

  const t = MOMENTUM_STRONG_THRESHOLD > 0 ? Math.max(-1, Math.min(1, netShift / MOMENTUM_STRONG_THRESHOLD)) : 0;
  // t=-1 (full away) -> 180deg (pointing left), t=0 -> 90deg (straight up),
  // t=1 (full home) -> 0deg (pointing right).
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

function FactorRow({ factor }: { factor: MomentumFactor }) {
  const leanClass =
    factor.lean === "home"
      ? "font-medium text-blue-600 dark:text-blue-400"
      : factor.lean === "away"
        ? "font-medium text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm font-medium text-foreground">{factor.label}</span>
      <span className={"text-right text-xs " + leanClass}>{factor.detail}</span>
    </div>
  );
}

// Pure presentational gauge - no fetching, no polling. GameMomentumPanel owns
// the live poll loop and passes this whatever it last got back.
export function MomentumGauge({
  homeTeam,
  awayTeam,
  classification,
  netShift,
  deltasConsidered,
  factors,
}: {
  homeTeam: string;
  awayTeam: string;
  classification: MomentumClassification;
  netShift: number;
  deltasConsidered: number;
  factors: MomentumFactor[];
}) {
  const warmingUp = deltasConsidered < MOMENTUM_MIN_DELTAS_FOR_READ;

  return (
    <div>
      <div className="flex flex-col items-center pt-4">
        <Dial netShift={netShift} classification={classification} />
        <div className="mt-1 flex w-full max-w-[240px] items-center justify-between px-2 text-xs text-muted-foreground">
          <span>{awayTeam}</span>
          <span>{homeTeam}</span>
        </div>
        <div className="mt-2 text-base font-semibold text-foreground">
          {warmingUp ? "Warming up" : CLASSIFICATION_LABEL[classification](homeTeam, awayTeam)}
        </div>
        {warmingUp && (
          <p className="mt-0.5 px-4 text-center text-xs text-muted-foreground">
            Not enough game action yet for a reliable read - checks back every play.
          </p>
        )}
      </div>

      <div className="mt-4 divide-y divide-border-subtle border-t border-border-subtle">
        {factors.map((factor) => (
          <FactorRow key={factor.key} factor={factor} />
        ))}
      </div>
    </div>
  );
}
