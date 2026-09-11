"use client";

import { useId } from "react";
import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";
import { getTeamColor } from "@/lib/team-colors";
import {
  MOMENTUM_STRONG_THRESHOLD,
  MOMENTUM_MIN_DELTAS_FOR_READ,
  type MomentumClassification,
  type MomentumFactor,
} from "@/server/data/mlb-momentum";

const SPORT_KEY = "baseball_mlb";
// Fallback for a team getTeamColor can't map yet (none today - both MLB
// tables are fully covered - but never re-introduce the old bug by falling
// back to a fixed blue/amber that would still read as position-based bias).
const NEUTRAL_COLOR = "#9ca3af"; // gray-400

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

// Bug fix: this used to be a fixed blue-for-home/amber-for-away mapping,
// which meant whichever team happened to be listed first (home or away)
// always read the same color regardless of which team it actually was -
// two different matchups showed the identical "blue vs amber" look with no
// connection to either team's real identity. Now colored by each team's OWN
// verified brand color (getTeamColor) instead, so the gauge is never biased
// by list position - only by which team the signal actually favors. EVEN
// still reads neutral gray - momentum hasn't favored either team's color.
function needleColorFor(classification: MomentumClassification, awayColor: string, homeColor: string): string {
  if (classification === "STRONG_HOME" || classification === "LEAN_HOME") return homeColor;
  if (classification === "STRONG_AWAY" || classification === "LEAN_AWAY") return awayColor;
  return NEUTRAL_COLOR;
}

// netShift is a signed, effectively-unbounded WP-point sum (see
// computeMomentumTrend); the needle itself only needs a direction and a
// clamped magnitude, so it's normalized against the STRONG threshold - a
// shift at or beyond "strong" always points the needle all the way to that
// side, rather than needing its own separate scale.
function Dial({
  netShift,
  classification,
  awayColor,
  homeColor,
}: {
  netShift: number;
  classification: MomentumClassification;
  awayColor: string;
  homeColor: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === Theme.DARK;
  const needleColor = needleColorFor(classification, awayColor, homeColor);
  // Unique per mounted gauge (useId) so two Dials on one page (there aren't
  // today, but nothing should assume that) never collide on the same <defs>
  // gradient id.
  const gradientId = "momentum-gradient-" + useId();

  const t = MOMENTUM_STRONG_THRESHOLD > 0 ? Math.max(-1, Math.min(1, netShift / MOMENTUM_STRONG_THRESHOLD)) : 0;
  // t=-1 (full away) -> 180deg (pointing left), t=0 -> 90deg (straight up),
  // t=1 (full home) -> 0deg (pointing right).
  const angleRad = ((90 - t * 90) * Math.PI) / 180;
  const needleLen = GAUGE_R - 12;
  const tipX = GAUGE_CX + needleLen * Math.cos(angleRad);
  const tipY = GAUGE_CY - needleLen * Math.sin(angleRad);
  const dotStroke = isDark ? "#111827" : "#ffffff";

  return (
    <svg viewBox={`0 0 ${GAUGE_VIEWBOX_W} ${GAUGE_VIEWBOX_H}`} className="h-[112px] w-[200px]">
      <defs>
        {/* Horizontal sweep across the arc's own bounding box (left edge to
            right edge, at the arc's vertical midpoint) - away's color on the
            left where away sits, home's on the right where home sits, same
            away-left/home-right convention as the rest of this dial. */}
        <linearGradient id={gradientId} x1={GAUGE_CX - GAUGE_R} y1={GAUGE_CY} x2={GAUGE_CX + GAUGE_R} y2={GAUGE_CY} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={awayColor} />
          <stop offset="100%" stopColor={homeColor} />
        </linearGradient>
      </defs>
      <path d={ARC_PATH} pathLength={100} fill="none" stroke={`url(#${gradientId})`} strokeWidth={GAUGE_STROKE} strokeLinecap="round" />
      {/* Team-colored marker dots at each end of the arc, matching the
          gradient's own endpoints - away on the left, home on the right. */}
      <circle cx={GAUGE_CX - GAUGE_R} cy={GAUGE_CY} r={7} fill={awayColor} stroke={dotStroke} strokeWidth={2} />
      <circle cx={GAUGE_CX + GAUGE_R} cy={GAUGE_CY} r={7} fill={homeColor} stroke={dotStroke} strokeWidth={2} />
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
  const awayColor = getTeamColor(SPORT_KEY, awayTeam) ?? NEUTRAL_COLOR;
  const homeColor = getTeamColor(SPORT_KEY, homeTeam) ?? NEUTRAL_COLOR;

  return (
    <div>
      <div className="flex flex-col items-center pt-4">
        <Dial netShift={netShift} classification={classification} awayColor={awayColor} homeColor={homeColor} />
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
