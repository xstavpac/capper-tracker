import { BoltIcon } from "@/components/dashboard/cappers-icons";
import { ParlaySlipPill } from "@/components/parlay/parlay-slip-pill";
import { BANNER_CONTROLS, BANNER_ICON, BANNER_ROW, BannerBrand, NavyBanner } from "@/components/ui/navy-banner";

// The /parlay banner: the navy card /live has (NavyBanner), with the page's title and motto on the
// left and the Parlay slip pill ("3 picks · 2 games") on the right. The title is smaller than /live's one
// short word, so it fits a phone's card.
export function ParlayBanner() {
  return (
    <NavyBanner>
      <div className={BANNER_ROW + " [@container_(min-width:640px)]:flex-wrap"}>
        <BannerBrand
          icon={<BoltIcon className={BANNER_ICON} />}
          title="Parlay Generator"
          tagline={["Build", "Hedge", "Fade"]}
          titleClassName="text-[22px] tracking-[-0.5px] [@container_(min-width:640px)]:text-[30px] [@container_(min-width:640px)]:tracking-[-0.8px]"
        />
        <div className={BANNER_CONTROLS + " [@container_(min-width:640px)]:py-3"}>
          <ParlaySlipPill />
        </div>
      </div>
    </NavyBanner>
  );
}
