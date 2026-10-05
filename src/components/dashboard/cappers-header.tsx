import type { ReactNode } from "react";
import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { CappersSearch } from "@/components/dashboard/cappers-search";
import { CrownIcon } from "@/components/dashboard/cappers-icons";
import { PageHeaderBar } from "@/components/dashboard/page-header-bar";

// The /cappers banner: logo + title, the time tabs, the search box (the `q` param) and - as
// `children` - the Add capper control. `controls={false}` leaves out the tabs and the search (the
// no-cappers-yet state has nothing to filter). The banner is dark in both themes.
export function CappersHeader({ params, controls = true, children }: { params: CappersParams; controls?: boolean; children?: ReactNode }) {
  return (
    <PageHeaderBar icon={<CrownIcon className="h-[19px] w-[19px]" />} title="Cappers" tagline="Track. Compare. Win.">
      {controls && <CappersTimeTabs params={params} />}
      {controls && <CappersSearch params={params} />}
      {children}
    </PageHeaderBar>
  );
}
