import { LIVE_SPORTS } from "@/server/data/odds";
import { LiveBannerRow } from "@/components/live/live-banner-row";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";
import { NavyBanner } from "@/components/ui/navy-banner";

// The /live banner: the same navy card as the /cappers and /dashboard banners, drawn here rather
// than from an image (NavyBanner, shared with /parlay). Dark in both themes. The league and the
// view are links (query params the page reads on the server); a league link keeps the view and
// drops any selected game.
// The layout follows the card's width (a size container), not the screen's: beside the sidebar the
// card is far narrower than the screen. See live-banner-row.tsx.
export function LiveBanner({ activeSport, isGrid }: { activeSport: string; isGrid: boolean }) {
  const view = isGrid ? "advanced" : "feed";
  const leagues = LIVE_SPORTS.map((s) => ({ key: s.key, label: s.label, href: "/live?sport=" + s.key + "&view=" + view }));
  const views = [
    { key: "feed", label: "Feed", href: "/live?sport=" + activeSport + "&view=feed" },
    { key: "advanced", label: "Grid", href: "/live?sport=" + activeSport + "&view=advanced" },
  ];

  return (
    <NavyBanner>
      <LiveBannerRow leagues={leagues} league={activeSport} views={views} view={view}>
        <ParlaySlipButton dark />
      </LiveBannerRow>
    </NavyBanner>
  );
}
