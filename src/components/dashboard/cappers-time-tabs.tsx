import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";
import { BANNER_GROUP, BANNER_SEG, BANNER_SEG_OFF, BANNER_SEG_ON } from "@/components/dashboard/page-banner";

// The time range tabs in the /cappers banner: a dark pill group (wraps on a narrow card), the
// selected range lit blue. Links, so the range is a URL param the page reads on the server.
// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  return (
    <nav role="group" aria-label="Time range" className={BANNER_GROUP}>
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={BANNER_SEG + (active ? BANNER_SEG_ON : BANNER_SEG_OFF)}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
