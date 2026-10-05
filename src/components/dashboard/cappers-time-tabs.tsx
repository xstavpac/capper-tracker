import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";

// The pill group in the /cappers banner (dark in both themes).
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-0.5 rounded-lg border border-white/10 bg-white/[0.04] p-[3px] xl:mx-auto">
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-md px-2.5 py-1.5 text-[13px] font-medium transition " + (active ? "bg-white/[0.14] text-white" : "text-white/60 hover:text-white")
            }
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
