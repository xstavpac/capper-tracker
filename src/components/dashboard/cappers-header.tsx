import type { ReactNode } from "react";
import type { CappersParams } from "@/lib/cappers-page-params";
import { CappersTimeTabs } from "@/components/dashboard/cappers-time-tabs";
import { CappersSearch } from "@/components/dashboard/cappers-search";
import { CrownIcon } from "@/components/dashboard/cappers-icons";

// The /cappers banner: logo + title, the time tabs, the search box (the `q` param) and - as
// `children` - the Add capper control. `controls={false}` leaves out the tabs and the search (the
// no-cappers-yet state has nothing to filter). The banner is dark in both themes.
export function CappersHeader({ params, controls = true, children }: { params: CappersParams; controls?: boolean; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3 rounded-[18px] bg-[#0F1420] px-4 py-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-3">
        <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-2 border-brand-600 bg-[#1A2236] text-white">
          <CrownIcon className="h-[19px] w-[19px]" />
        </span>
        <h1 className="text-xl font-semibold leading-none tracking-[-0.02em] text-white">Cappers</h1>
        <span aria-hidden className="h-[22px] w-px bg-[#2A3348]" />
        <p className="whitespace-nowrap text-[13px] font-medium text-[#A3ACC2]">Track. Compare. Win.</p>
      </div>
      {controls && <CappersTimeTabs params={params} />}
      {controls && <CappersSearch params={params} />}
      {children}
    </div>
  );
}
