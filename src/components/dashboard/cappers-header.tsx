import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { PageBanner } from "@/components/dashboard/page-banner";

// The /cappers banner, with the time tabs under the title. `controls={false}` leaves the tabs out
// (the no-cappers-yet state has nothing to filter). The search and the Add capper control are in
// the leaderboard card. The motto is the Cappers banner's original tagline ("Track. Compare. Win.", #175-#185),
// in the shared motto style.
export function CappersHeader({ params, controls = true }: { params: CappersParams; controls?: boolean }) {
  return (
    <PageBanner variant="cappers" title="Cappers" motto="EVERY CAPPER · EVERY RECORD">
      {controls && <CappersTimeTabs params={params} />}
    </PageBanner>
  );
}
