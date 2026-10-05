import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { PageBanner } from "@/components/dashboard/page-banner";
import cappersBanner from "../../../public/banners/cappers.png";

// The /cappers banner: the art, then a strip with the time tabs. `controls={false}` leaves the
// strip out (the no-cappers-yet state has nothing to filter). The search and the Add capper
// control are in the leaderboard card.
export function CappersHeader({ params, controls = true }: { params: CappersParams; controls?: boolean }) {
  return (
    // cappers.png is 2132x217. Across it, the icon's circle starts at 5.6%, the crown at 7.1%, the
    // word ends at 47.7% and the illustration starts at 51.3%. A phone's row is 56px tall, so the
    // art is 550px wide: shifted 15px left, the circle is 16px from the card's edge (as on
    // /dashboard), the word ends at 248px and the illustration would start at 267px. The crop ends
    // 10px before that. From `sm` up nothing is shifted, and the crop ends 10px before the
    // illustration's start in the 104px row (524px) and the 112px row (565px).
    <PageBanner src={cappersBanner} title="Cappers" className="bg-[#011948]" rowClassName="max-sm:h-14" cropClassName="w-[257px] sm:w-[514px] lg:w-[555px]" imageClassName="max-sm:-ml-[15px]" glow="art">
      {controls && (
        <div className="border-t border-[rgba(59,130,246,0.18)] pb-3 pl-3 pt-2.5 sm:px-5 sm:py-3">
          <CappersTimeTabs params={params} />
        </div>
      )}
    </PageBanner>
  );
}
