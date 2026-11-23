import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { PageBanner } from "@/components/dashboard/page-banner";

// The /cappers banner, with the time tabs under the title. `controls={false}` leaves the tabs out
// (the no-cappers-yet state has nothing to filter). The search and the Add capper control are in
// the leaderboard card.
export function CappersHeader({ params, controls = true }: { params: CappersParams; controls?: boolean }) {
  return (
    <PageBanner variant="cappers" title="Cappers">
      {controls && <CappersTimeTabs params={params} />}
    </PageBanner>
  );
}
