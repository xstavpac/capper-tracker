import { LIVE_SPORTS } from "@/server/data/odds";
import { DesktopOnly } from "@/components/layout/mobile-only";
import { SHELL_CONTAINER } from "@/components/layout/shell";
import { LiveBannerRow, LiveViewToggle } from "@/components/live/live-banner-row";
import { PageBanner, PAGE_BANNER_ICONS } from "@/components/dashboard/page-banner";
import { ParlaySlipButton, ParlaySlipActionBar } from "@/components/parlay/parlay-slip-button";

// The /live banner: the shared page banner, with the Feed/Grid toggle and Parlay slip on the title line from 1024px,
// and the league pills under it. The league and the view are links (query params the page
// reads on the server); a league link keeps the view and drops any selected game.
export function LiveBanner({ activeSport, isGrid }: { activeSport: string; isGrid: boolean }) {
  const view = isGrid ? "advanced" : "feed";
  const leagues = LIVE_SPORTS.map((s) => ({ key: s.key, label: s.label, href: "/live?sport=" + s.key + "&view=" + view }));
  const views = [
    { key: "feed", label: "Feed", href: "/live?sport=" + activeSport + "&view=feed" },
    { key: "advanced", label: "Grid", href: "/live?sport=" + activeSport + "&view=advanced" },
  ];

  return (
    <>
      {/* From 1024px the Feed / Grid toggle and the Parlay slip sit in the banner, on the title line, 28px after the title (20px gap + 8px); the art is behind them. */}
      <PageBanner
        variant="live"
        title="Live"
        icon={PAGE_BANNER_ICONS.live}
        titleAside={
          <DesktopOnly className="ml-2">
            <div className="flex items-center gap-3">
              <LiveViewToggle views={views} view={view} inBanner />
              <ParlaySlipButton />
            </div>
          </DesktopOnly>
        }
      />
      {/* The league pills: under the banner, in the same container (the banner's strip cancels main's padding the same way), so the first pill lines up with the banner's left edge. No background of their own. */}
      <div className="-mx-4 md:-mx-8">
        <div className={SHELL_CONTAINER + " mb-4 mt-3.5 lg:mb-[18px] lg:mt-1.5"}>
          <LiveBannerRow leagues={leagues} league={activeSport} views={views} view={view}>
            <ParlaySlipButton />
          </LiveBannerRow>
        </div>
      </div>
      <ParlaySlipActionBar />
    </>
  );
}
