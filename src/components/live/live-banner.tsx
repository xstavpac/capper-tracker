import { LIVE_SPORTS } from "@/server/data/odds";
import { LiveBannerRow } from "@/components/live/live-banner-row";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";

// The blue light on the card's edges, as on the /cappers and /dashboard banners (page-banner.tsx):
// a soft glow, and a 3px bar over it. On the right only; a stacked card (under 640px) has it on
// both sides, the glow over the title's rows only (live-banner-row.tsx).
const GLOW =
  "pointer-events-none absolute inset-y-0 right-0 hidden w-[140px] bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)] [@container_(min-width:640px)]:block";
const BAR = "pointer-events-none absolute inset-y-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)] ";

// The /live banner: the same navy card as the /cappers and /dashboard banners, drawn here rather
// than from an image. Dark in both themes. The league and the view are plain links (query params
// the page reads on the server); a league link keeps the view and drops any selected game.
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
    <div className="relative overflow-hidden rounded-2xl bg-banner shadow-[0_10px_28px_rgba(3,11,41,0.28)] [container-type:inline-size] sm:rounded-[20px]">
      <LiveBannerRow leagues={leagues} league={activeSport} views={views} view={view}>
        <ParlaySlipButton dark />
      </LiveBannerRow>
      <span aria-hidden className={GLOW} />
      <span aria-hidden className={BAR + "left-0 [@container_(min-width:640px)]:hidden"} />
      <span aria-hidden className={BAR + "right-0"} />
    </div>
  );
}
