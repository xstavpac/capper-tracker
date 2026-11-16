import { useId, type ReactNode } from "react";
import { SHELL_CONTAINER } from "@/components/layout/shell";
import { BannerArt, type BannerVariant } from "@/components/dashboard/page-banner-art";

export type { BannerVariant };

// The page banner, drawn in code: a navy card (the same in both themes) on a #0A1530 strip that
// continues the site header. Look, sizes, gradients and art are from design/page-banners-reference.html.
// The title is the page's one <h1>; `children` is the controls row under it (client components are
// fine there). From 900px the card is 172px tall with the variant's SVG art on its right; below
// that the art goes and the card grows to fit the controls, which wrap.
// charts and import show the dashboard's art until they get their own.
// Motion is CSS only (keyframes in globals.css): parlay and live loop, dashboard, cappers and picks
// play once, and reduced motion leaves it still.

const CARD_BG =
  "radial-gradient(ellipse at 12% 50%, rgba(37, 99, 235, 0.45) 0%, rgba(37, 99, 235, 0) 45%), radial-gradient(ellipse at 80% 60%, rgba(29, 78, 216, 0.55) 0%, rgba(29, 78, 216, 0) 50%), radial-gradient(ellipse at 50% 120%, rgba(56, 189, 248, 0.35) 0%, rgba(56, 189, 248, 0) 40%), #040B26";

const ABS = { position: "absolute", inset: 0 } as const;

// The icons the pages pass as `icon` (from the reference; charts and import are new, same style).
const SVG = { width: 36, height: 36, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
export const PAGE_BANNER_ICONS: Record<BannerVariant, ReactNode> = {
  dashboard: (
    <svg {...SVG}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  cappers: (
    <svg {...SVG} width="38" height="38">
      <path d="M4 8l4 3 4-6 4 6 4-3-2 10H6z" />
      <path d="M6 21h12" />
    </svg>
  ),
  picks: (
    <svg {...SVG}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 8l1.5 1.5L12 7M8 13l1.5 1.5L12 12M14 8h2M14 13h2M8 17h8" />
    </svg>
  ),
  parlay: (
    <svg {...SVG}>
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  live: (
    <svg {...SVG} width="38" height="38">
      <circle cx="12" cy="12" r="3" fill="#FF5A5A" stroke="#FF5A5A" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
    </svg>
  ),
  charts: (
    <svg {...SVG}>
      <path d="M4 20V11M10 20V5M16 20v-7M22 20H2" />
    </svg>
  ),
  import: (
    <svg {...SVG}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
    </svg>
  ),
};

export function PageBanner({
  variant,
  title,
  icon,
  motto,
  children,
}: {
  variant: BannerVariant;
  title: string;
  icon: ReactNode;
  motto?: string;
  children?: ReactNode;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const grid = "pbgrid-" + uid;
  return (
    // The strip is full width: it cancels <main>'s padding (p-4, md:p-8) so it meets the header. The card sits in
    // the shared shell container, so its edges are the header's and the page content's.
    <div className="-mx-4 -mt-4 bg-[#0A1530] py-3 [font-family:Inter,system-ui,sans-serif] md:-mx-8 md:-mt-8">
     <div className={SHELL_CONTAINER}>
      <section
        className="relative overflow-hidden rounded-[20px] min-[900px]:h-[128px]"
        style={{
          border: "1.5px solid rgba(96, 165, 250, 0.85)",
          boxShadow: "0 0 18px rgba(59, 130, 246, 0.55), inset 0 0 28px rgba(59, 130, 246, 0.22)",
          background: CARD_BG,
        }}
      >
        {/* grid + faint edge bars */}
        <svg style={ABS} width="100%" height="180" aria-hidden="true">
          <defs>
            <pattern id={grid} width="36" height="36" patternUnits="userSpaceOnUse">
              <path d="M36 0H0V36" fill="none" stroke="#1E3A8A" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="180" fill={`url(#${grid})`} opacity="0.35" />
        </svg>
        <svg style={{ position: "absolute", left: 0, bottom: 0, opacity: 0.35 }} width="220" height="180" viewBox="0 0 220 180" aria-hidden="true">
          <g fill="#3B82F6">
            <rect x="8" y="120" width="10" height="60" rx="2" />
            <rect x="26" y="96" width="10" height="84" rx="2" />
            <rect x="44" y="134" width="10" height="46" rx="2" />
            <rect x="62" y="108" width="10" height="72" rx="2" />
            <rect x="80" y="146" width="10" height="34" rx="2" />
            <rect x="98" y="124" width="10" height="56" rx="2" />
            <rect x="116" y="156" width="10" height="24" rx="2" />
          </g>
          <polyline points="0,150 40,90 90,110 140,70 220,40" fill="none" stroke="#60A5FA" strokeWidth="1.5" />
        </svg>
        {/* the curved light streak */}
        <svg style={ABS} width="100%" height="100%" viewBox="0 0 1400 172" preserveAspectRatio="none" aria-hidden="true">
          <path d="M520 172C720 160 860 92 1400 24" fill="none" stroke="#38BDF8" strokeWidth="6" opacity="0.12" vectorEffect="non-scaling-stroke" />
          <path d="M520 172C720 160 860 92 1400 24" fill="none" stroke="#7DD3FC" strokeWidth="1.5" opacity="0.7" vectorEffect="non-scaling-stroke" />
          <path d="M300 172C520 150 640 120 820 110" fill="none" stroke="#3B82F6" strokeWidth="1" opacity="0.45" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* the variant's art, right side */}
        {/* The art is drawn on a 560x180 viewBox; fitted to the card's 128px height (about 398px wide). */}
        <div className="absolute bottom-0 right-0 hidden h-[128px] min-[900px]:block [&>svg]:h-full [&>svg]:w-auto" aria-hidden="true">
          <BannerArt variant={variant} uid={uid} />
        </div>

        {/* badge, divider, title, motto and controls */}
        <div className="relative mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-[22px] gap-y-3 px-6 py-5 min-[900px]:h-full min-[900px]:flex-nowrap min-[900px]:py-0">
          <span
            className="flex h-14 w-14 flex-none items-center justify-center rounded-full text-[#BFDBFE] [&>svg]:h-[26px] [&>svg]:w-[26px]"
            style={{
              background: "radial-gradient(circle at 50% 40%, #16307A 0%, #0A1A4A 70%)",
              border: "2px solid #3B82F6",
              boxShadow: "0 0 22px rgba(59, 130, 246, 0.7), inset 0 0 14px rgba(96, 165, 250, 0.35)",
            }}
            aria-hidden="true"
          >
            {icon}
          </span>
          <span className="hidden h-12 w-px flex-none bg-[#3B82F6] opacity-70 min-[500px]:block" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
              <h1 className="m-0 text-[34px] font-extrabold leading-none tracking-[-0.02em] text-white [text-shadow:0_0_20px_rgba(56,189,248,0.6)]">{title}</h1>
              {motto && (
                <span className="flex items-center gap-4">
                  <span className="h-[30px] w-0.5 rounded-sm bg-[#3B82F6] shadow-[0_0_8px_rgba(59,130,246,0.8)]" aria-hidden="true" />
                  <span className="text-xs font-bold tracking-[0.24em] text-[#7DD3FC]">{motto}</span>
                </span>
              )}
            </div>
            {children}
          </div>
        </div>
      </section>
     </div>
    </div>
  );
}

// Shared look of the controls the pages put in the banner (from the reference).
export const BANNER_GROUP = "flex flex-wrap gap-1 self-start rounded-full border border-[#2A4A8A] bg-[rgba(4,11,38,0.7)] p-0.5";
export const BANNER_SEG = "flex h-6 flex-none items-center whitespace-nowrap rounded-full border-0 px-[14px] text-[13px] font-bold transition ";
export const BANNER_SEG_ON = "bg-[#2563EB] text-white";
export const BANNER_SEG_OFF = "bg-transparent text-[#C9D3E6] hover:text-white";
export const BANNER_PILL = "flex h-[30px] flex-none items-center gap-2 self-start whitespace-nowrap rounded-full border border-[#2A4A8A] bg-[rgba(4,11,38,0.7)] px-4 text-[13px] font-semibold text-[#E6EAF2] transition";
