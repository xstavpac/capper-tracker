import type { ReactNode } from "react";
import { getRecordColor } from "@/server/data/stats";
import { TrendIcon } from "@/components/dashboard/trend-icon";

export function Avatar({
  name,
  colorTag,
  size = 24,
}: {
  name: string;
  colorTag: string | null;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ backgroundColor: colorTag ?? "#3B82F6", width: size, height: size, fontSize: size * 0.4167 }}
    >
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function PanelRow({
  capperId,
  name,
  colorTag,
  right,
  icon,
}: {
  capperId: string;
  name: string;
  colorTag: string | null;
  right: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <a
      href={"/cappers/" + capperId}
      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Avatar name={name} colorTag={colorTag} />
        {icon}
        <span className="truncate">{name}</span>
      </div>
      <span className="shrink-0 text-xs font-medium">{right}</span>
    </a>
  );
}

// Name + right-aligned record + a thin progress bar underneath whose fill
// length is the win%, animating in from empty on load. Used by Rising and
// Best Last-20 specifically - the two "catch something happening right now"
// panels - kept deliberately plainer everywhere else in this file.
//
// trending marks the one thing that distinguishes Rising from Best Last-20:
// a small lightning-bolt badge next to the name. Rising is about momentum
// ("catching fire" right now), Best Last-20 is about current standing - the
// icon is the only visual difference, so it only ever applies to Rising rows.
export function BarRow({
  capperId,
  name,
  colorTag,
  record,
  winPct,
  trending = false,
  showWinPct = false,
  startDelayMs = 0,
}: {
  capperId: string;
  name: string;
  colorTag: string | null;
  record: string;
  winPct: number;
  trending?: boolean;
  showWinPct?: boolean;
  // Holds the bar at empty until this many ms have passed, same prop name/
  // meaning as CountUp's own startDelayMs - lets a caller (trending-cappers.tsx,
  // passing SURGE_DURATION_MS) key the bar's growth off the exact same "hero
  // stat surge just finished" signal the count-ups already wait for, instead
  // of the bar animating independently the moment it mounts. animationFillMode
  // "both" is what makes the delay actually hold the bar at its 0% starting
  // keyframe throughout - without it, the browser shows the bar's underlying
  // (non-animated) inline scaleX - its FINAL fill value - for the whole delay,
  // then snaps back to 0 right as the animation starts, which looks broken.
  startDelayMs?: number;
}) {
  const positive = getRecordColor(winPct) === "green";
  const fill = Math.min(100, Math.max(0, winPct)) / 100;

  return (
    <a href={"/cappers/" + capperId} className="block rounded-lg px-2 py-1.5 hover:bg-gray-50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Avatar name={name} colorTag={colorTag} />
          <span className="truncate text-sm">{name}</span>
          {trending && <TrendIcon direction="up" />}
        </div>
        <span className={"shrink-0 text-sm font-semibold " + (positive ? "text-emerald-600" : "text-red-600")}>
          {record}
          {showWinPct && (
            <span className="ml-1 font-normal text-gray-400">{Math.round(winPct)}%</span>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={"h-full origin-left animate-fill-bar rounded-full " + (positive ? "bg-emerald-500" : "bg-red-500")}
          style={{
            transform: "scaleX(" + fill + ")",
            ["--fill" as string]: fill,
            animationDelay: startDelayMs + "ms",
            animationFillMode: "both",
          }}
        />
      </div>
    </a>
  );
}

export function record(wins: number, losses: number, pushes: number) {
  return wins + "-" + losses + (pushes > 0 ? "-" + pushes : "");
}

function FlameIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z" />
    </svg>
  );
}

function SnowflakeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M12 2v20M4 7l16 10M20 7 4 17M2 12h20" />
    </svg>
  );
}

// A capper's current streak as a small flame (win)/snowflake (loss) pill -
// shared by the Cappers-page ranked list, the new leaderboard table, and a
// capper's own detail page, so "what does a streak look like" stays one
// answer across the app. Renders nothing below 2 - a lone win/loss isn't a
// streak worth calling out. `compact` (list rows, tight on space) shows just
// the count; the default verbose form ("5W streak") reads better as a
// standalone badge, e.g. on the detail page's context strip.
export function StreakBadge({
  streak,
  compact = false,
}: {
  streak: { type: "WIN" | "LOSS" | "NONE"; count: number };
  compact?: boolean;
}) {
  if (streak.count < 2) return null;
  const isWin = streak.type === "WIN";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
        (isWin ? "bg-orange-50 text-orange-600" : "bg-sky-50 text-sky-600")
      }
    >
      {isWin ? <FlameIcon /> : <SnowflakeIcon />}
      {compact ? streak.count : `${streak.count}${isWin ? "W" : "L"} streak`}
    </span>
  );
}

// Excludes pushes from the denominator, matching computeStats' winPct
// convention (a push is neither a win nor a loss).
export function winPctExcludingPushes(wins: number, losses: number) {
  const decided = wins + losses;
  return decided > 0 ? (wins / decided) * 100 : 0;
}

export function Panel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div
        className={
          "flex items-center gap-1.5 " +
          (subtitle ? "text-sm font-semibold text-gray-900" : "mb-2 text-sm font-semibold text-gray-900")
        }
      >
        {icon}
        {title}
      </div>
      {subtitle && <p className="mb-2 text-xs text-gray-500">{subtitle}</p>}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

