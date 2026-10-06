// Inline stroke icons for the /cappers page (the repo has no icon library; same convention as
// layout/app-sidebar.tsx). All are decorative (aria-hidden) and take their color from currentColor.
function svgProps(className?: string) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ?? "h-4 w-4",
    "aria-hidden": true,
  };
}
type P = { className?: string };

// Same glyph as the sidebar's Cappers item.
export const UsersIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <circle cx="9" cy="7" r="3" />
    <path d="M3 20v-1a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v1" />
    <path d="M16 4.2a3 3 0 0 1 0 5.6" />
    <path d="M21 20v-1a4 4 0 0 0 -3 -3.85" />
  </svg>
);

export const ActivityIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M3 12h4l3 8l4 -16l3 8h4" />
  </svg>
);

export const ListChecksIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M3.5 5.5l1.3 1.3l2.2 -2.3" />
    <path d="M3.5 12.5l1.3 1.3l2.2 -2.3" />
    <path d="M3.5 19.5l1.3 1.3l2.2 -2.3" />
    <path d="M11 6h9.5" />
    <path d="M11 13h9.5" />
    <path d="M11 20h9.5" />
  </svg>
);

export const PercentIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M19 5L5 19" />
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="17" cy="17" r="2.5" />
  </svg>
);

export const FlameIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 2c1 3-2 4-2 7a3 3 0 1 0 6 0c1 1 2 2.5 2 4.5A6.5 6.5 0 0 1 5 13.5C5 8 12 6 12 2Z" />
  </svg>
);

export const TrendingUpIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </svg>
);

// Six-armed flake with branch tips.
export const SnowflakeIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5" />
    <path d="M9.2 3.8L12 5.6l2.8-1.8M9.2 20.2L12 18.4l2.8 1.8M19.6 9.6l-2.9 1.4.2 3.3M4.4 9.6l2.9 1.4-.2 3.3" />
  </svg>
);

export const TrophyIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M8 4h8v5a4 4 0 0 1 -8 0V4Z" />
    <path d="M8 6H4v1a4 4 0 0 0 4 4" />
    <path d="M16 6h4v1a4 4 0 0 1 -4 4" />
    <path d="M12 13v4" />
    <path d="M8 20h8" />
    <path d="M9.5 17h5" />
  </svg>
);

export const ArrowUpIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 19V5" />
    <path d="M6 11l6 -6 6 6" />
  </svg>
);

export const ArrowDownIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 5v14" />
    <path d="M6 13l6 6 6 -6" />
  </svg>
);

export const ChevronRightIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M9 6l6 6 -6 6" />
  </svg>
);

export const ChevronDownIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const CalendarIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5z" />
    <path d="M4 9.5h16M8.5 2.5v4M15.5 2.5v4" />
  </svg>
);

export const SearchIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);

export const PlusIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const ClipboardIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v1a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1zM9 12h6M9 16h4" />
  </svg>
);

export const ListIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M8 12h8M8 8h8M8 16h5" />
  </svg>
);

export const TargetIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
  </svg>
);

export const ShieldCheckIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 2.5l8 3.5v6c0 5-3.5 8.6-8 9.5-4.5-.9-8-4.5-8-9.5V6l8-3.5z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </svg>
);

export const AlertTriangleIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M10.3 3.9L1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4.5M12 17.2h.01" />
  </svg>
);

// Filled glyphs (not stroke icons): the crown takes currentColor; the flame is two-tone.
export const CrownIcon = ({ className }: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? "h-4 w-4"} aria-hidden>
    <path d="M3.5 18.5h17l1.4-10.2-5.6 4L12 5l-4.3 7.3-5.6-4 1.4 10.2z" />
    <rect x="3.5" y="19.6" width="17" height="1.8" rx="0.9" />
  </svg>
);

export const FlameFilledIcon = ({ className }: P) => (
  <svg viewBox="0 0 24 24" fill="none" className={className ?? "h-4 w-4"} aria-hidden>
    <path d="M12 2.5c.8 3.4 5.5 5.6 5.5 11a5.5 5.5 0 01-11 0c0-2.4 1.2-4 2.3-5.4.3 1.6 1.2 2.6 2 2.9-.6-3.2.1-6.1 1.2-8.5z" fill="#F97316" />
    <path d="M12 13c1.3 1.4 2.4 2.4 2.4 4.1a2.4 2.4 0 01-4.8 0c0-1.5 1.1-2.6 2.4-4.1z" fill="#FFD27A" />
  </svg>
);

export const TrophyFilledIcon = ({ className }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" className={className ?? "h-4 w-4"} aria-hidden>
    <path d="M7 3.5h10v5.5a5 5 0 01-10 0V3.5z" fill="currentColor" stroke="none" />
    <path d="M7 5H4v1.5A3.5 3.5 0 007.3 10M17 5h3v1.5a3.5 3.5 0 01-3.3 3.5" />
    <path d="M12 14v3.5M8 20.5h8M9.5 17.5h5v3h-5z" />
  </svg>
);

export const TrendingDownIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M3 7l6 6 4-4 8 8" />
    <path d="M15 17h6v-6" />
  </svg>
);

export const ClockIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

// Same glyph as the sidebar's Dashboard item.
export const DashboardIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <rect x="4" y="4" width="7" height="9" rx="1.5" />
    <rect x="13" y="4" width="7" height="5" rx="1.5" />
    <rect x="13" y="11" width="7" height="9" rx="1.5" />
    <rect x="4" y="15" width="7" height="5" rx="1.5" />
  </svg>
);

// A broadcast dot with two waves: the /live banner's tile.
export const LiveIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <path d="M7.8 16.2a6 6 0 0 1 0 -8.4" />
    <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
    <path d="M4.9 19.1a10 10 0 0 1 0 -14.2" />
    <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
  </svg>
);
