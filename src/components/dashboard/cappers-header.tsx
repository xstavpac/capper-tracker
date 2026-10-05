import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { PageBanner } from "@/components/dashboard/page-banner";
import cappersBanner from "../../../public/banners/cappers.png";

// The /cappers banner: the art, then a strip with the time tabs. `controls={false}` leaves the
// strip out (the no-cappers-yet state has nothing to filter). The search and the Add capper
// control are in the leaderboard card.
export function CappersHeader({ params, controls = true }: { params: CappersParams; controls?: boolean }) {
  return (
    // cappers.png is 2132x217. In its own pixels the icon's circle spans 119-297 (centre 110 down),
    // the art's divider is at 344-347, the word spans 401-1018 (48-190 down) and the illustration
    // starts at 1094. A phone's row is 56px. From `sm` up the crop ends 10px before the illustration's start in the
    // 104px row (524px) and the 112px row (565px).
    <PageBanner
      src={cappersBanner}
      title="Cappers"
      className="bg-[#011948]"
      phone={{ height: 56, circle: { left: 119, right: 297, centerY: 110 }, word: { start: 401, end: 1018, top: 48, bottom: 190 } }}
      cropClassName="sm:w-[514px] lg:w-[555px]"
      glow="art"
    >
      {controls && (
        <div className="border-t border-[rgba(59,130,246,0.18)] pb-3 pl-3 pt-2.5 sm:px-5 sm:py-3">
          <CappersTimeTabs params={params} />
        </div>
      )}
    </PageBanner>
  );
}
