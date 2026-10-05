import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { PILL_GROUP, pill } from "@/components/dashboard/page-header-bar";

// The pill group in the /cappers banner (dark in both themes).
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  return (
    <nav aria-label="Time range" className={PILL_GROUP + " xl:mx-auto"}>
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={pill(active) + " px-[7px] capitalize min-[1700px]:px-3.5"}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
