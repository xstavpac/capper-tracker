import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";

// The pill group in the /cappers banner (dark in both themes).
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-1 rounded-xl border border-[#263048] bg-[#1A2236] p-1 xl:mx-auto">
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-[9px] px-[7px] py-2 text-[12.5px] font-medium capitalize transition min-[1700px]:px-3.5 " + (active ? "bg-brand-600 text-white" : "text-[#C9D0E0] hover:text-white")
            }
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
