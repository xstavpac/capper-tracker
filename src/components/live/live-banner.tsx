import { LIVE_SPORTS } from "@/server/data/odds";
import { SHELL_CONTAINER } from "@/components/layout/shell";
import { LiveBannerRow } from "@/components/live/live-banner-row";
import { PageBanner } from "@/components/dashboard/page-banner";
import { SITE_FONT } from "@/components/dashboard/themed-page";
import { ParlaySlipButton, ParlaySlipActionBar } from "@/components/parlay/parlay-slip-button";

// The /live banner: the shared page banner (with its motto), and under it the league pills with the Parlay slip and the Feed/Grid toggle at their right end. The league and the view are links (query params the page
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
      <PageBanner variant="live" title="Live" motto="EVERY GAME · EVERY PICK · LIVE" />
      {/* The league pills: under the banner, in the same container (the banner's strip cancels main's padding the same way), so the first pill lines up with the banner's left edge. No background of their own. */}
      {/* Outside ThemedPage, so it takes the site's typeface here. */}
      <div className={SITE_FONT + " live-bg -mx-4 md:-mx-8"}>
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
