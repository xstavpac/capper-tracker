// The app's navigation, shared by the header's tabs (site-header.tsx) and the
// nav list at the top of the hamburger menu below 1024px (header-menu.tsx).
// Inline stroke icons: the repo has no icon library. All are decorative
// (aria-hidden) and take their color from currentColor.

type IconProps = { className?: string };

function iconProps(className?: string) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: className ?? "h-[18px] w-[18px]",
    "aria-hidden": true,
  };
}

export function DashboardIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <rect x="4" y="4" width="7" height="9" rx="1.5" />
      <rect x="13" y="4" width="7" height="5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="15" width="7" height="5" rx="1.5" />
    </svg>
  );
}

// Crown (lucide "Crown" geometry, inlined).
export function CappersIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function PicksIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M3.5 5.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 12.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 19.5l1.3 1.3l2.2 -2.3" />
      <path d="M11 6h9.5" />
      <path d="M11 13h9.5" />
      <path d="M11 20h9.5" />
    </svg>
  );
}

export function ChartsIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 4v16h16" />
      <path d="M7 15l3.5 -4.5l3 3l4.5 -6" />
    </svg>
  );
}

export function ParlayIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 6.5l6 5.5l-6 5.5" />
      <path d="M11 6.5h9" />
      <path d="M11 17.5h9" />
    </svg>
  );
}

export function LiveIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9.2 9.2a4 4 0 0 0 0 5.6" />
      <path d="M14.8 9.2a4 4 0 0 1 0 5.6" />
      <path d="M6.5 6.5a8 8 0 0 0 0 11" />
      <path d="M17.5 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

// A gauge for the /admin ops console - its own glyph instead of sharing Settings' gear.
export function AdminIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4.5 17a8 8 0 1 1 15 0" />
      <path d="M12 13l3.5 -4" />
      <circle cx="12" cy="13" r="1.2" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function PricingIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M12 3v18" />
      <path d="M17 7c0-1.7-2.2-3-5-3s-5 1.3-5 3 2.2 3 5 3 5 1.3 5 3-2.2 3-5 3-5-1.3-5-3" />
    </svg>
  );
}

export function SignOutIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M15 16l4-4-4-4" />
      <path d="M19 12H9" />
    </svg>
  );
}

export function SunIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg {...iconProps(className)}>
      <path d="M6 9l6 6l6 -6" />
    </svg>
  );
}

export type NavItem = {
  href: string;
  label: string;
  icon: (props: IconProps) => JSX.Element;
  // Live's red dot.
  liveDot?: boolean;
  // Parlay Generator's item carries the slip-size badge (client state from
  // ParlayPoolProvider, filled in at render time).
  slipBadge?: boolean;
};

// The one ordered list for the header tabs and the menu's nav list.
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/cappers", label: "Cappers", icon: CappersIcon },
  { href: "/picks", label: "Picks", icon: PicksIcon },
  { href: "/charts", label: "Charts", icon: ChartsIcon },
  { href: "/parlay", label: "Parlay Generator", icon: ParlayIcon, slipBadge: true },
  { href: "/live", label: "Live", icon: LiveIcon, liveDot: true },
];

export function isActiveHref(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

// Live's red dot: the existing ring pulse (motion-reduce turns it off) plus a
// soft red glow. `ringClassName` is the border that separates the dot from
// whatever is behind the icon.
export function LiveDot({ ringClassName }: { ringClassName: string }) {
  return (
    <span
      aria-hidden="true"
      className={
        "absolute -right-[3px] -top-[3px] h-[9px] w-[9px] rounded-full border-2 bg-[#DC2626] animate-live-dot-ring motion-reduce:animate-none " +
        ringClassName
      }
      style={{ filter: "drop-shadow(0 0 2px #FF5A5A) drop-shadow(0 0 5px rgba(255,90,90,.75))" }}
    />
  );
}

// "bar": on the navy header (a white pill, readable on the blue active tab too).
// "card": on the menu's light/dark card (the brand pill the sidebar had).
export function SlipBadge({ count, tone }: { count: number; tone: "bar" | "card" }) {
  if (count <= 0) return null;
  const colors = tone === "bar" ? "bg-white text-[#1747C9]" : "bg-brand-500 text-white";
  return (
    <span
      aria-label={count + " in parlay slip"}
      className={"flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold " + colors}
    >
      {count}
    </span>
  );
}
