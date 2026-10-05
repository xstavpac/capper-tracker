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

// Same star glyph as the Cappers leaderboard's favorite toggle
// (favorite-star.tsx's filled StarIcon state) - display-only
// here (no click/toggle affordance), so it doesn't need that component's
// optimistic-update state machine, just the matching visual.
export function FavoriteStarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0 text-amber-400"
      fill="currentColor"
      role="img"
      aria-label="Favorited"
    >
      <path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.7 1.6 6.8L12 17.6l-6.2 3.4 1.6-6.8-5.2-4.7 6.9-.7z" />
    </svg>
  );
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
        (isWin
          ? "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400"
          : "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400")
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
