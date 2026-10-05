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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-[#0F1420] px-4 py-3">
      <div className="flex shrink-0 items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white">
          <CrownIcon className="h-[18px] w-[18px]" />
        </span>
        <h1 className="text-[22px] font-semibold leading-none tracking-[-0.01em] text-white">Cappers</h1>
        <span aria-hidden className="h-4 w-px bg-white/15" />
        <p className="whitespace-nowrap text-[13px] font-normal text-white/50">Track. Compare. Win.</p>
      </div>
      {controls && <CappersTimeTabs params={params} />}
      {controls && <CappersSearch params={params} />}
      {children}
    </div>
  );
}
