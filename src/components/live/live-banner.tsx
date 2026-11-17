import { LIVE_SPORTS } from "@/server/data/odds";
import { LiveBannerRow } from "@/components/live/live-banner-row";
import { PageBanner, PAGE_BANNER_ICONS } from "@/components/dashboard/page-banner";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";

// The /live banner: the shared page banner, with the title only, then the league pills, the Feed/Grid
// toggle and the Parlay slip control under it. The league and the view are links (query params the page
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
      <PageBanner variant="live" title="Live" icon={PAGE_BANNER_ICONS.live} />
      {/* The controls sit under the banner, not in it: the banner is a fixed 128px tall from 900px with its art on the right, which leaves no room for the pills. */}
      <div className="mb-4 mt-3.5">
        <LiveBannerRow leagues={leagues} league={activeSport} views={views} view={view}>
          <ParlaySlipButton />
        </LiveBannerRow>
      </div>
    </>
  );
}
