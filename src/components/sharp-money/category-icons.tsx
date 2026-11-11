import type { ReactElement } from "react";
import { SEGMENT_CATEGORY_KEYS, splitSegmentCategoryKey, type PickCategoryKey, type SegmentCategoryKey } from "@/server/data/stats";
import { PROP_CATEGORY_BY_FAMILY, PROP_CATEGORY_KEYS, type PropCategoryKey } from "@/lib/prop-category";
import type { PropSportFamily } from "@/lib/prop-market-key";
import { HotStreaksIcon } from "@/components/dashboard/hot-streaks-icon";

// Straight vertical arrow (shaft + open chevron head, not a filled triangle
// and not the diagonal zigzag TrendIcon uses elsewhere) - the shape the
// Sharp Money task explicitly called for, distinct from every other arrow
// family below. `direction` mirrors the y-coordinates rather than rotating,
// same reasoning TrendIcon's own up/down split uses (a plain shape that
// composes cleanly with its own independent surge animation). Reuses the
// EXISTING trend-surge-up/down + trend-glow keyframes (defined for TrendIcon)
// rather than inventing new ones - same technique, new shape.
function VerticalArrowIcon({ direction, colorClass }: { direction: "up" | "down"; colorClass: string }) {
  const shaft = "M12 19 L12 5";
  const head = direction === "up" ? "M6 11 L12 5 L18 11" : "M6 13 L12 19 L18 13";
  const surgeClass = direction === "up" ? "animate-trend-surge-up" : "animate-trend-surge-down";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-5 w-5 shrink-0 " + colorClass + " " + surgeClass}
      aria-hidden="true"
    >
      <path d={shaft} />
      <path d={head} className="animate-trend-glow" />
    </svg>
  );
}

// Diagonal "up-right"/"down-right" corner arrow (shaft + L-shaped bracket
// head, matches Tabler's ti-arrow-up-right/ti-arrow-down-right) - the Spread
// family's own arrow shape, kept visually distinct from VerticalArrowIcon's
// straight vertical shape and TrendIcon's zigzag. Same surge/glow reuse as
// VerticalArrowIcon above.
function DiagonalArrowIcon({ direction, colorClass }: { direction: "up" | "down"; colorClass: string }) {
  const shaft = direction === "up" ? "M7 17 L17 7" : "M7 7 L17 17";
  const head = direction === "up" ? "M8 7 L17 7 L17 16" : "M17 8 L17 17 L8 17";
  const surgeClass = direction === "up" ? "animate-trend-surge-up" : "animate-trend-surge-down";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-5 w-5 shrink-0 " + colorClass + " " + surgeClass}
      aria-hidden="true"
    >
      <path d={shaft} />
      <path d={head} className="animate-trend-glow" />
    </svg>
  );
}

// Ears + rounded head + snout + two dot eyes - simple enough to still read as
// "dog" at 20px. A slow head-tilt (reusing the exact rotate range/keyframe
// FallingIcon's parachute already uses in trending-cappers.tsx, same
// "gentle sway" technique) rather than a new animation.
function DogMlIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-500 animate-parachute-sway"
      aria-hidden="true"
    >
      <path d="M6.5 8 C4.5 4 2.5 4 3.5 9" />
      <path d="M17.5 8 C19.5 4 21.5 4 20.5 9" />
      <circle cx="12" cy="11" r="6.5" />
      <circle cx="9.5" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <path d="M10 14.2 a2 1.4 0 1 0 4 0 a2 1.4 0 1 0 -4 0" fill="currentColor" stroke="none" />
      <path d="M12 15.6 L12 16.8" />
    </svg>
  );
}

// Stopwatch face - the "first 5 innings" period is a time-boxed window, so a
// clock reads naturally as "early/first" without colliding with any other
// icon on the page. The minute hand blinks on its own (reusing
// thrust-flicker's exact opacity-pulse keyframe from the Dashboard rocket's
// exhaust) to suggest ticking, while the face itself stays still.
function F5MlIcon({ colorClass }: { colorClass: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-5 w-5 shrink-0 " + colorClass}
      aria-hidden="true"
    >
      <path d="M9 3 L15 3" />
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9 L12 13 L15 15" className="animate-thrust-flicker" />
    </svg>
  );
}

// Half-filled circle (a literal "half") for 1st Half categories - the filled
// wedge pulses (thrust-flicker reuse again) so it doesn't read as identical
// to NRFI/YRFI's static badge shapes below.
function HalfIcon({ colorClass }: { colorClass: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={"h-5 w-5 shrink-0 " + colorClass} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4 A8 8 0 0 1 12 20 Z" fill="currentColor" stroke="none" className="animate-thrust-flicker" />
    </svg>
  );
}

// Circle badge + slash ("no") / checkmark ("yes") - NRFI/YRFI are a paired
// yes/no question (did the first inning have a run), so a shared badge shape
// with an inverted glyph reads as a clear pair, same pairing idea
// VerticalArrowIcon/DiagonalArrowIcon use for their up/down variants. Reuses
// trend-glow's exact drop-shadow pulse (no new keyframe) for a slow, steady
// pulse rather than the busier staggered flicker.
function BadgeIcon({ glyph, colorClass }: { glyph: "no" | "yes"; colorClass: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-5 w-5 shrink-0 " + colorClass + " animate-trend-glow"}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      {glyph === "no" ? <path d="M6.5 6.5 L17.5 17.5" /> : <path d="M8.5 12.5 L11 15 L16 9" />}
    </svg>
  );
}

// Football silhouette - an <ellipse> rotated to a diagonal, not a hand-drawn
// bezier oval, so it reliably reads as a pointed football rather than a
// circle at 20px. Lace line + 3 cross-ticks share the same rotation (grouped
// so they stay aligned to the football's long axis). Gentle bob
// (rocket-drift's exact keyframe reused) suggests a toss/flight.
function TdPropIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-rose-500 animate-rocket-drift"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-42 12 12)" />
      <g transform="rotate(-42 12 12)">
        <path d="M6.5 12 L17.5 12" />
        <path d="M9.5 10.3 L9.5 13.7 M12 10 L12 14 M14.5 10.3 L14.5 13.7" />
      </g>
    </svg>
  );
}

// Basketball: ball outline + the vertical seam + two curved side seams. Same gentle bob as the
// football (rocket-drift reuse), so the prop families read as one set.
function BasketballPropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-orange-500 animate-rocket-drift" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5 L12 20.5" />
      <path d="M3.5 12 L20.5 12" />
      <path d="M6.2 5.8 C9 8.5 9 15.5 6.2 18.2" />
      <path d="M17.8 5.8 C15 8.5 15 15.5 17.8 18.2" />
    </svg>
  );
}

// Hockey puck: a short cylinder (top ellipse, sides, bottom arc), a disc rather than a ball so it
// never reads as the basketball / baseball circles at 20px.
function HockeyPropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-cyan-600 dark:text-cyan-400 animate-rocket-drift" aria-hidden="true">
      <ellipse cx="12" cy="9.5" rx="8" ry="3.5" />
      <path d="M4 9.5 L4 14 C4 16 7.6 17.5 12 17.5 C16.4 17.5 20 16 20 14 L20 9.5" />
    </svg>
  );
}

// Baseball: ball outline + the two facing stitch curves.
function BaseballPropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-red-500 animate-rocket-drift" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.5 4.8 C10 8.5 10 15.5 7.5 19.2" strokeDasharray="1.6 1.4" />
      <path d="M16.5 4.8 C14 8.5 14 15.5 16.5 19.2" strokeDasharray="1.6 1.4" />
    </svg>
  );
}

// Other props (a prop whose market has no key of its own, any sport): a plain player silhouette,
// neutral, with no sport's ball.
function OtherPropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-slate-600 dark:text-slate-400" aria-hidden="true">
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M5 20 C5 15.5 8 13 12 13 C16 13 19 15.5 19 20" />
    </svg>
  );
}

const PROP_FAMILY_ICONS: Record<PropSportFamily, () => ReactElement> = {
  FOOTBALL: () => <TdPropIcon />,
  BASKETBALL: () => <BasketballPropIcon />,
  HOCKEY: () => <HockeyPropIcon />,
  BASEBALL: () => <BaseballPropIcon />,
};

// Every prop key gets its family's icon (lib/prop-category.ts - keys never repeat across
// families), OTHER_PROP the neutral one. Built from PROP_CATEGORY_KEYS, so a new key is covered.
const PROP_CATEGORY_ICONS = Object.fromEntries(
  PROP_CATEGORY_KEYS.map((key) => {
    const family = (Object.keys(PROP_CATEGORY_BY_FAMILY) as PropSportFamily[]).find((f) =>
      (Object.values(PROP_CATEGORY_BY_FAMILY[f]) as string[]).includes(key)
    );
    return [key, family ? PROP_FAMILY_ICONS[family] : () => <OtherPropIcon />];
  })
) as Record<PropCategoryKey, () => ReactElement>;

// Two bars + baseline (a team's own scoring tally, distinct from the
// game-total Over/Under arrows). Each bar flickers on its own delay - the
// exact staggered-opacity technique HotStreaksIcon's embers and the
// Dashboard rocket's exhaust trail both already use.
function TeamTotalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400"
      aria-hidden="true"
    >
      <path d="M4 20 L20 20" />
      <path d="M8.5 20 L8.5 12" className="animate-thrust-flicker" style={{ animationDelay: "0s" }} />
      <path d="M15.5 20 L15.5 6" className="animate-thrust-flicker" style={{ animationDelay: "0.45s" }} />
    </svg>
  );
}

const SKY = "text-sky-600 dark:text-sky-400";
const INDIGO = "text-indigo-600 dark:text-indigo-400";
const VIOLET = "text-violet-600 dark:text-violet-400";
const FUCHSIA = "text-fuchsia-600 dark:text-fuchsia-400";
const AMBER_1H = "text-amber-600 dark:text-amber-400";
const RED = "text-red-600 dark:text-red-400";
const EMERALD = "text-emerald-600 dark:text-emerald-400";
const SLATE = "text-slate-600 dark:text-slate-400";

// Segment categories (Q1 Over, 2H ML, P1 Under, ...) - one shape family in a
// neutral color, derived so a new segment period doesn't need 3 more entries
// here. Not surfaced by CATEGORY_ORDER (sharp-money.ts) or any chip set today,
// so these only render if a future change adds a segment category to one.
const SEGMENT_CATEGORY_ICONS = Object.fromEntries(
  SEGMENT_CATEGORY_KEYS.map((key) => {
    const side = splitSegmentCategoryKey(key)!.side;
    return [
      key,
      () =>
        side === "OVER" ? (
          <VerticalArrowIcon direction="up" colorClass={SLATE} />
        ) : side === "UNDER" ? (
          <VerticalArrowIcon direction="down" colorClass={SLATE} />
        ) : side === "SPREAD" ? (
          <DiagonalArrowIcon direction="down" colorClass={SLATE} />
        ) : (
          <HalfIcon colorClass={SLATE} />
        ),
    ];
  })
) as Record<SegmentCategoryKey, () => ReactElement>;

// One entry per PickCategoryKey (same exhaustive-Record convention
// PICK_CATEGORY_LABELS/SPECIALIST_LABELS already use in stats.ts) so this
// can't silently go stale if CATEGORY_ORDER (sharp-money.ts) is ever extended
// to surface a category it doesn't today.
const CATEGORY_ICONS: Record<PickCategoryKey, () => ReactElement> = {
  ...SEGMENT_CATEGORY_ICONS,
  ...PROP_CATEGORY_ICONS,
  FAV_ML: () => <HotStreaksIcon />,
  DOG_ML: () => <DogMlIcon />,
  SPREAD_MINUS: () => <DiagonalArrowIcon direction="down" colorClass={VIOLET} />,
  SPREAD_PLUS: () => <DiagonalArrowIcon direction="up" colorClass={FUCHSIA} />,
  SPREAD: () => <DiagonalArrowIcon direction="down" colorClass={SLATE} />,
  OVER: () => <VerticalArrowIcon direction="up" colorClass={SKY} />,
  UNDER: () => <VerticalArrowIcon direction="down" colorClass={INDIGO} />,
  F5_ML: () => <F5MlIcon colorClass={VIOLET} />,
  FIRST_HALF_ML: () => <HalfIcon colorClass={AMBER_1H} />,
  FIRST_HALF_OVER: () => <VerticalArrowIcon direction="up" colorClass={AMBER_1H} />,
  FIRST_HALF_UNDER: () => <VerticalArrowIcon direction="down" colorClass={AMBER_1H} />,
  FIRST_HALF_SPREAD: () => <DiagonalArrowIcon direction="down" colorClass={AMBER_1H} />,
  // Legacy key (no chip set shows it): the neutral prop icon, like OTHER_PROP.
  TD_PROP: () => <OtherPropIcon />,
  NRFI: () => <BadgeIcon glyph="no" colorClass={RED} />,
  YRFI: () => <BadgeIcon glyph="yes" colorClass={EMERALD} />,
  F5_SPREAD_MINUS: () => <DiagonalArrowIcon direction="down" colorClass={VIOLET} />,
  F5_SPREAD_PLUS: () => <DiagonalArrowIcon direction="up" colorClass={VIOLET} />,
  F5_OVER: () => <VerticalArrowIcon direction="up" colorClass={VIOLET} />,
  F5_UNDER: () => <VerticalArrowIcon direction="down" colorClass={VIOLET} />,
  TEAM_TOTAL: () => <TeamTotalIcon />,
};

export function CategoryIcon({ categoryKey }: { categoryKey: PickCategoryKey }) {
  const Icon = CATEGORY_ICONS[categoryKey];
  return <Icon />;
}
