"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { slateTotals, type SlateCounts } from "@/lib/slate-counts";

// The Slate Bar under the top header (phone only): today's date and a three-cell stats strip
// (Live / Upcoming / Final across every league). Counts come from the layout (the cached score
// feed /live reads), so nothing here fetches. Strip is 58px, nothing above weight 700.

const CELL = "flex h-full flex-col items-center justify-center text-center";
const STRIP = "grid h-[58px] grid-cols-3 divide-x divide-[#2a3c66] border-t border-[#22345e] bg-[rgba(7,16,40,.55)]";
const DATE_ROW = "flex h-6 items-center justify-center px-2.5 text-[12px] font-medium leading-none text-[#a9b8d6]";

// "Thursday, Nov 19" in the viewer's own timezone. Set after mount: the server's timezone is not
// the user's, and rendering it there would mismatch on hydration.
function formatLocalDate(now: Date): string {
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return weekday + ", " + monthDay;
}

function LocalDate() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(formatLocalDate(new Date()));
  }, []);
  return <div className={DATE_ROW}>{label ?? <span aria-hidden="true">&nbsp;</span>}</div>;
}

function StatsStrip({ counts }: { counts: SlateCounts }) {
  const allFailed = counts.leagues.length > 0 && counts.leagues.every((l) => l.failed);
  const t = slateTotals(counts, "today");
  const liveHref = "/live?" + (t.liveTop ? "sport=" + t.liveTop + "&" : "") + "status=live";
  const upcomingHref = "/live?" + (t.pendingTop ? "sport=" + t.pendingTop + "&" : "") + "status=pending";
  const num = (n: number) => (allFailed ? "–" : n);
  return (
    <div className={STRIP}>
      <Link href={liveHref} aria-label={(allFailed ? "Live games" : t.live + " live games") + ", open Live"} className={CELL + " transition-colors hover:bg-white/5"}>
        <span className="flex items-center gap-1.5">
          {!allFailed && t.live > 0 && (
            <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#DC2626] animate-live-dot-ring motion-reduce:animate-none" />
          )}
          <span className="text-[21px] font-bold leading-none text-[#22c55e]">{num(t.live)}</span>
        </span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Live</span>
      </Link>
      <Link href={upcomingHref} aria-label={(allFailed ? "Upcoming games" : t.pending + " upcoming games") + ", open Live"} className={CELL + " transition-colors hover:bg-white/5"}>
        <span className="text-[21px] font-bold leading-none text-white">{num(t.pending)}</span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Upcoming</span>
      </Link>
      <div className={CELL}>
        <span className="text-[21px] font-bold leading-none text-[#60a5fa]">{num(t.final)}</span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Final</span>
      </div>
    </div>
  );
}

export function SlateBar({ counts }: { counts: SlateCounts }) {
  return (
    <div role="region" aria-label="Slate">
      <LocalDate />
      <StatsStrip counts={counts} />
    </div>
  );
}

// Same footprint as the bar (24px date row, 58px strip) so nothing shifts when the counts arrive.
export function SlateBarSkeleton() {
  return (
    <div aria-hidden="true">
      <div className={DATE_ROW}>&nbsp;</div>
      <div className={STRIP}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={CELL}>
            <span className="h-[21px] w-10 animate-pulse rounded bg-[#2a3c66] motion-reduce:animate-none" />
            <span className="mt-1 h-[11px] w-16 animate-pulse rounded bg-[#22345e] motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
