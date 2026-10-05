import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { PageBanner } from "@/components/dashboard/page-banner";
import cappersBanner from "../../../public/banners/cappers.png";

// The /cappers banner: the art, then a strip with the time tabs. `controls={false}` leaves the
// strip out (the no-cappers-yet state has nothing to filter). The search and the Add capper
// control are in the leaderboard card.
export function CappersHeader({ params, controls = true }: { params: CappersParams; controls?: boolean }) {
  return (
    // cappers.png is 2132x217. 72px on a phone: at 76px the word ends 2px from the card's edge at
    // 390px wide, and its last letter is cut by the rounded corner.
    <PageBanner src={cappersBanner} title="Cappers" frameClassName="h-[72px] sm:h-auto sm:aspect-[2132/217]">
      {controls && (
        <div className="border-t border-[rgba(59,130,246,0.18)] pb-3.5 pl-3.5 pt-3 sm:px-5 sm:py-3.5">
          <CappersTimeTabs params={params} />
        </div>
      )}
    </PageBanner>
  );
}
