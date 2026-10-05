import { LIVE_SPORTS } from "@/server/data/odds";
import { LiveIcon } from "@/components/dashboard/cappers-icons";
import { LiveBannerRow } from "@/components/live/live-banner-row";
import { ParlaySlipButton } from "@/components/parlay/parlay-slip-button";

// The blue light on the card's edges, as on the /cappers and /dashboard banners (page-banner.tsx):
// a soft glow, and a 3px bar over it. On the right only; stacked (see below) it is on both
// sides, the glow over the title's rows only.
const GLOW = "pointer-events-none absolute inset-y-0 ";
const GLOW_LEFT = "left-0 bg-[linear-gradient(270deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]";
const GLOW_RIGHT = "right-0 bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]";
const BAR = "pointer-events-none absolute inset-y-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)] ";

const SEGMENT = "flex h-7 items-center rounded-full px-3.5 text-[12.5px] transition [@container_(min-width:640px)]:h-9 [@container_(min-width:640px)]:px-[18px] [@container_(min-width:640px)]:text-sm ";
const segment = (active: boolean) => SEGMENT + (active ? "bg-[#2563EB] font-semibold text-white shadow-[0_0_14px_rgba(37,99,235,0.6)]" : "font-medium text-[#D3DEFA] hover:text-white");

// The /live banner: the same navy card as the /cappers and /dashboard banners, drawn here rather
// than from an image. Dark in both themes. The league and the view are plain links (query params
// the page reads on the server); a league link keeps the view and drops any selected game.
// The layout follows the card's width (a size container), not the screen's: beside the sidebar the
// card is far narrower than the screen. Under 640px it is stacked, as on a phone: the title row
// (icon left, word centred, the line halfway between), the credit, the league chips, then the view
// toggle and the Parlay slip. From 640px the title and the controls share an 84px row, and the
// leagues join it when the card has room; until then they have a second row (live-banner-row.tsx).
export function LiveBanner({ activeSport, isGrid }: { activeSport: string; isGrid: boolean }) {
  const view = isGrid ? "&view=advanced" : "&view=feed";
  const leagues = LIVE_SPORTS.map((s) => ({ key: s.key, label: s.label, href: "/live?sport=" + s.key + view }));

  return (
    <div className="relative overflow-hidden rounded-2xl bg-[#011948] shadow-[0_10px_28px_rgba(3,11,41,0.28)] [container-type:inline-size] sm:rounded-[20px]">
      {/* The brand, stacked: the line sits in what is left of the first column, between the ring and the word. */}
      <LiveBannerRow
        leagues={leagues}
        active={activeSport}
        brand={
          <div className="relative grid grid-cols-[1fr_auto_1fr] [@container_(min-width:640px)]:h-[84px] [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:grid-cols-[auto_auto] [@container_(min-width:640px)]:content-center [@container_(min-width:640px)]:gap-y-1.5">
            <div className="flex h-[52px] items-center [@container_(min-width:640px)]:row-span-2 [@container_(min-width:640px)]:h-auto [@container_(min-width:640px)]:pr-4">
              <span className="relative ml-4 flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border-2 border-[#3B82F6] bg-[rgba(3,11,41,0.6)] text-[#9AD8FF] shadow-[0_0_14px_rgba(59,130,246,0.75),inset_0_0_10px_rgba(59,130,246,0.45)] [@container_(min-width:640px)]:ml-0 [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:w-11">
                <LiveIcon className="h-[18px] w-[18px] [@container_(min-width:640px)]:h-[22px] [@container_(min-width:640px)]:w-[22px]" />
                <span aria-hidden className="absolute -right-0.5 -top-0.5 h-[9px] w-[9px] rounded-full border-2 border-[#011948] bg-[#EF4444] shadow-[0_0_7px_rgba(239,68,68,0.9)] [@container_(min-width:640px)]:h-[11px] [@container_(min-width:640px)]:w-[11px]" />
              </span>
              <span aria-hidden className="flex flex-1 justify-center [@container_(min-width:640px)]:ml-4 [@container_(min-width:640px)]:flex-none">
                <span className="h-[26px] w-0.5 rounded-full bg-[#22D3EE] shadow-[0_0_6px_rgba(34,211,238,0.8)] [@container_(min-width:640px)]:h-8" />
              </span>
            </div>
            <h1 className="self-center text-[34px] font-extrabold leading-none tracking-[-0.8px] text-white [text-shadow:0_0_14px_rgba(96,165,250,0.55)]">Live</h1>
            <p className="col-span-3 whitespace-nowrap pb-2.5 text-center text-[9.5px] font-bold uppercase tracking-[2px] text-[#BFD3FF] [@container_(min-width:640px)]:col-span-1 [@container_(min-width:640px)]:col-start-2 [@container_(min-width:640px)]:pb-0 [@container_(min-width:640px)]:text-left [@container_(min-width:640px)]:text-[10px] [@container_(min-width:640px)]:tracking-[2.4px]">
              Powered by The Odds API
            </p>
            <span aria-hidden className={GLOW + "w-[70px] [@container_(min-width:640px)]:hidden " + GLOW_LEFT} />
            <span aria-hidden className={GLOW + "w-[70px] [@container_(min-width:640px)]:hidden " + GLOW_RIGHT} />
          </div>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 pb-3 pt-1 [@container_(min-width:640px)]:ml-auto [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:gap-3 [@container_(min-width:640px)]:p-0">
          <nav aria-label="View" className="flex flex-none rounded-full border border-[rgba(96,140,255,0.2)] bg-[rgba(30,58,138,0.25)] p-[3px] [@container_(min-width:640px)]:gap-1 [@container_(min-width:640px)]:p-1">
            <a href={"/live?sport=" + activeSport + "&view=feed"} aria-current={!isGrid ? "page" : undefined} className={segment(!isGrid)}>
              Feed
            </a>
            <a href={"/live?sport=" + activeSport + "&view=advanced"} aria-current={isGrid ? "page" : undefined} className={segment(isGrid)}>
              Grid
            </a>
          </nav>
          <ParlaySlipButton dark />
        </div>
      </LiveBannerRow>
      <span aria-hidden className={GLOW + "hidden w-[140px] [@container_(min-width:640px)]:block " + GLOW_RIGHT} />
      <span aria-hidden className={BAR + "left-0 [@container_(min-width:640px)]:hidden"} />
      <span aria-hidden className={BAR + "right-0"} />
    </div>
  );
}
