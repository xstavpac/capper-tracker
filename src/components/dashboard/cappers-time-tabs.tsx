import Link from "next/link";
import { RANGE_OPTIONS, cappersHref, type CappersParams } from "@/lib/cappers-page-params";

// scroll={false}: a soft navigation that swaps the data in place instead of jumping to the top.
export function CappersTimeTabs({ params }: { params: CappersParams }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-1">
      {RANGE_OPTIONS.map((r) => {
        const active = r.key === params.range;
        return (
          <Link
            key={r.key}
            href={cappersHref(params, { range: r.key })}
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition " +
              (active ? "bg-brand-600 text-white" : "text-muted-foreground hover:text-foreground")
            }
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
