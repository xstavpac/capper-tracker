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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[18px] bg-[#0F1420] px-4 py-4 sm:px-5 min-[1700px]:gap-x-5">
      <div className="flex shrink-0 items-center gap-3.5">
        <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-brand-600 bg-[#1A2236] text-white">
          <CrownIcon className="h-[26px] w-[26px]" />
        </span>
        <h1 className="text-[30px] font-extrabold leading-none tracking-tight text-white">Cappers</h1>
        {/* The tagline shows where there is a row to spare for it: stacked (narrow) or a very wide banner. */}
        <span aria-hidden className="hidden h-[22px] w-px bg-[#2A3348] min-[420px]:block xl:hidden min-[1700px]:block" />
        <p className="hidden text-[13px] font-semibold text-[#A3ACC2] min-[420px]:block xl:hidden min-[1700px]:block">Track. Compare. Win.</p>
      </div>
      {controls && <CappersTimeTabs params={params} />}
      {controls && <CappersSearch params={params} />}
      {children}
    </div>
  );
}
