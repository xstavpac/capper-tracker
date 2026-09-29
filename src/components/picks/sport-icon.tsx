// Line icons for the /picks sport chips. The app has no icon package - icons
// are inline SVGs (see dashboard/cappers-icons.tsx) - so these follow suit.
// Display-only; unknown sports get a neutral generic icon.
import type { ReactNode } from "react";

const BASEBALL = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6c2.6 2.6 2.6 10.2 0 12.8M18.4 5.6c-2.6 2.6-2.6 10.2 0 12.8" />
  </>
);
const BASKETBALL = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3 12h18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8" />
  </>
);
const FOOTBALL = (
  <>
    <path d="M4 20C4 11 11 4 20 4c0 9-7 16-16 16Z" />
    <path d="M9 15l6-6M10.5 10.5l3 3" />
  </>
);
const HOCKEY = (
  <>
    <path d="M4 3l8 15h6" />
    <ellipse cx="18" cy="20" rx="3" ry="1.3" />
  </>
);
const TENNIS = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.3 10.5C8 10.5 13.5 16 13.5 20.7M20.7 13.5C16 13.5 10.5 8 10.5 3.3" />
  </>
);
const SOCCER = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8l3.5 2.5-1.3 4H9.8l-1.3-4ZM12 8V3M15.5 10.5L20 9M14.2 14.5l3 4M9.8 14.5l-3 4M8.5 10.5L4 9" />
  </>
);
const GLOVE = (
  <>
    <path d="M6 10a5 5 0 0 1 10 0v5a4 4 0 0 1-4 4H9a3 3 0 0 1-3-3v-6Z" />
    <path d="M8 19v2h6v-2" />
  </>
);
const GOLF = (
  <>
    <path d="M9 21V3l8 4-8 4M6 21h6" />
  </>
);
const GENERIC = (
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" />
  </>
);

const ICONS: Record<string, ReactNode> = {
  NBA: BASKETBALL,
  WNBA: BASKETBALL,
  NCAAB: BASKETBALL,
  NFL: FOOTBALL,
  NCAAF: FOOTBALL,
  MLB: BASEBALL,
  NHL: HOCKEY,
  MLS: SOCCER,
  EPL: SOCCER,
  SOCCER: SOCCER,
  TENNIS: TENNIS,
  UFC: GLOVE,
  MMA: GLOVE,
  BOXING: GLOVE,
  GOLF: GOLF,
};

export function SportIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden="true"
    >
      {ICONS[name.toUpperCase()] ?? GENERIC}
    </svg>
  );
}
