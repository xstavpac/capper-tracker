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

export const SnowflakeIcon = ({ className }: P) => (
  <svg {...svgProps(className)}>
    <path d="M12 2v20" />
    <path d="M4.9 7l14.2 10" />
    <path d="M4.9 17L19.1 7" />
    <path d="M9.5 3.5L12 6l2.5 -2.5" />
    <path d="M9.5 20.5L12 18l2.5 2.5" />
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
