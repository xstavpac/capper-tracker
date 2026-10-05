import type { ReactNode } from "react";

// The dark page banner shared by /cappers and /dashboard: icon tile + title + tagline, then whatever
// controls the page hands in as `children`. Dark in both themes.
export function PageHeaderBar({ icon, title, tagline, children }: { icon: ReactNode; title: string; tagline: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3 rounded-[18px] bg-[#0F1420] px-4 py-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-3">
        <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-2 border-brand-600 bg-[#1A2236] text-white">{icon}</span>
        <h1 className="text-xl font-semibold leading-none tracking-[-0.02em] text-white">{title}</h1>
        <span aria-hidden className="h-[22px] w-px bg-[#2A3348]" />
        <p className="whitespace-nowrap text-[13px] font-medium text-[#A3ACC2]">{tagline}</p>
      </div>
      {children}
    </div>
  );
}
