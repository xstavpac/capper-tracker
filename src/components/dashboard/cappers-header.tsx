import type { ReactNode } from "react";
import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { CappersSearch } from "@/components/dashboard/cappers-search";
import { CrownIcon } from "@/components/dashboard/cappers-icons";
import { PageHeaderBar } from "@/components/dashboard/page-header-bar";

// The /cappers banner: logo + title, the time tabs, the search box (the `q` param) and - as
// `children` - the Add capper control. `controls={false}` leaves out the tabs and the search (the
// no-cappers-yet state has nothing to filter). The banner is dark in both themes. On a phone it
// ends under the time tabs: the search hides itself, and the page hides the Add capper control
// (both are in the leaderboard card there).
export function CappersHeader({ params, controls = true, children }: { params: CappersParams; controls?: boolean; children?: ReactNode }) {
  return (
    <PageHeaderBar icon={<CrownIcon className="h-[19px] w-[19px] max-sm:h-4 max-sm:w-4" />} title="Cappers" tagline="Track. Compare. Win." compactMobile>
      {controls && <CappersTimeTabs params={params} />}
      {controls && <CappersSearch params={params} />}
      {children}
    </PageHeaderBar>
  );
}
