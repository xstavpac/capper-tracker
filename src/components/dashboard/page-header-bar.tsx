import type { ReactNode } from "react";

// The dark page banner shared by /cappers, /dashboard and /live: icon tile + title + tagline, then
// whatever controls the page hands in as `children`. Dark in both themes.

// The banner's pill group and one pill in it; the caller adds the pill's own padding.
export const PILL_GROUP = "flex flex-wrap gap-1 rounded-xl border border-[#263048] bg-[#1A2236] p-1";
export const pill = (active: boolean) => "rounded-[9px] py-2 text-[12.5px] font-medium transition " + (active ? "bg-brand-600 text-white" : "text-[#C9D0E0] hover:text-white");

// `iconClass` replaces the tile's default look (the blue-ringed circle).
export function PageHeaderBar({ icon, title, tagline, iconClass, children }: { icon: ReactNode; title: string; tagline: string; iconClass?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3 rounded-[18px] bg-[#0F1420] px-4 py-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-3">
        <span className={"flex h-[38px] w-[38px] items-center justify-center text-white " + (iconClass ?? "rounded-full border-2 border-brand-600 bg-[#1A2236]")}>{icon}</span>
        <h1 className="text-xl font-semibold leading-none tracking-[-0.02em] text-white">{title}</h1>
        <span aria-hidden className="h-[22px] w-px bg-[#2A3348]" />
        <p className="whitespace-nowrap text-[13px] font-medium text-[#A3ACC2]">{tagline}</p>
      </div>
      {children}
    </div>
  );
}
