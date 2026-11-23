import { useId, type ReactNode } from "react";
import { SHELL_CONTAINER } from "@/components/layout/shell";
import { SharedDefs, vars, type BannerDef, type BannerVariant } from "@/components/banners/banner-parts";
import { LIVE_BANNER } from "@/components/banners/live";
import { DASHBOARD_BANNER } from "@/components/banners/dashboard";
import { CAPPERS_BANNER } from "@/components/banners/cappers";
import { PICKS_BANNER } from "@/components/banners/picks";
import { PARLAY_BANNER } from "@/components/banners/parlay";
import { IMPORT_BANNER } from "@/components/banners/import";
import { CHARTS_BANNER } from "@/components/banners/charts";

export type { BannerVariant };

// The page banner (banners/bettingview-*-banner.html). The art, the icon and the animation are SVG + CSS
// copied from the reference files (components/banners/*: shared pieces in banner-shared.css, each banner's
// own art next to it). The title (the page's one <h1>), the motto and `children` (the controls row under the
// title: Cappers time tabs, Parlay slip pill) are real HTML laid over the art where the reference draws them,
// so they stay live and clickable.
// From 900px the card has the reference's proportions (1000 x 103; Live 1000 x 115) and everything scales with
// its width. Below that the art goes, the background stretches, and the card grows to fit its content.
// CSS-only motion; reduced motion shows the static version.

const BANNERS: Record<BannerVariant, BannerDef> = {
  live: LIVE_BANNER,
  dashboard: DASHBOARD_BANNER,
  cappers: CAPPERS_BANNER,
  picks: PICKS_BANNER,
  parlay: PARLAY_BANNER,
  import: IMPORT_BANNER,
  charts: CHARTS_BANNER,
};

// The line-height:1 box of the title starts this far (in ems) above its baseline (Inter's ascent less half
// of its negative leading).
const BASELINE_EM = 0.864;

export function PageBanner({
  variant,
  title,
  motto,
  titleAside,
  children,
}: {
  variant: BannerVariant;
  title: string;
  motto?: string;
  // Controls on the title line, after the title (the caller adds its own margin).
  titleAside?: ReactNode;
  children?: ReactNode;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const def = BANNERS[variant];
  const s = def.spec;
  const titleTop = s.baseline - BASELINE_EM * s.ts;
  const { cx, cy, r } = s.icon;
  const pad = r + 1.5;
  const style = vars({
    "--bnr-ar": `1000 / ${s.h}`,
    "--bnr-rx": s.rx,
    "--bnr-edge": s.edge,
    "--bnr-shadow": s.shadow,
    "--bnr-ink": s.ink,
    "--bnr-motto": s.motto,
    "--bnr-div": s.div,
    "--bnr-tx": s.tx,
    "--bnr-ty": titleTop,
    "--bnr-ts": s.ts,
    "--bnr-tls": s.tls,
    "--bnr-dh": s.dh,
    "--bnr-ms": s.ms,
    "--bnr-mls": s.mls,
    "--bnr-cg": s.controlsTop != null ? s.controlsTop - (titleTop + s.ts) : 0,
  });
  return (
    // The strip is full width: it cancels <main>'s padding (p-4, md:p-8) so it meets the header. The card sits in
    // the shared shell container, so its edges are the header's and the page content's.
    <div className="pbanner -mx-4 -mt-4 bg-[var(--bv-strip)] py-3 [font-family:Inter,system-ui,sans-serif] md:-mx-8 md:-mt-8">
      <div className={SHELL_CONTAINER}>
        <div className="bnr-wrap">
          <section className="bnr-card" style={style} data-banner={variant}>
            <svg className="bnr-bg" viewBox={`0 0 1000 ${s.h}`} preserveAspectRatio="none" aria-hidden="true">
              {def.bg(uid + "b")}
            </svg>
            <svg className="bnr-fg" viewBox={`0 0 1000 ${s.h}`} aria-hidden="true">
              <SharedDefs k={uid + "f"} />
              {def.art(uid + "f")}
              {def.icon(uid + "f")}
            </svg>
            <div className="bnr-body">
              {/* Below 900px: the icon alone, in the flow */}
              <svg className="bnr-micon" viewBox={`${cx - pad} ${cy - pad} ${pad * 2} ${pad * 2}`} overflow="hidden" aria-hidden="true">
                <SharedDefs k={uid + "m"} />
                {def.icon(uid + "m")}
              </svg>
              <div className="bnr-text">
                <div className="bnr-line">
                  <h1 className="bnr-title">{title}</h1>
                  {titleAside}
                  {motto && (
                    <>
                      <span className="bnr-div2" aria-hidden="true" />
                      <span className="bnr-motto">{motto}</span>
                    </>
                  )}
                </div>
                {children}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// Shared look of the controls the pages put in the banner (the reference's filter tabs and slip pill).
export const BANNER_GROUP = "flex flex-wrap gap-1 self-start rounded-full border border-[color:var(--bv-pill-border)] bg-[var(--bv-pill-bg)] p-0.5";
export const BANNER_SEG = "flex h-6 flex-none items-center whitespace-nowrap rounded-full border-0 px-[14px] text-[13px] font-bold transition ";
export const BANNER_SEG_ON = "bg-[var(--bv-active)] text-white";
export const BANNER_SEG_OFF = "bg-transparent text-[color:var(--bv-pill-off)] hover:text-[color:var(--bv-h1)]";
export const BANNER_PILL = "flex h-[30px] flex-none items-center gap-2 self-start whitespace-nowrap rounded-full border border-[color:var(--bv-pill-border)] bg-[var(--bv-pill-bg)] px-4 text-[13px] font-semibold text-[color:var(--bv-btn-text)] transition";
