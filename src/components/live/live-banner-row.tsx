"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { BANNER_GROUP, BANNER_SEG, BANNER_SEG_OFF, BANNER_SEG_ON } from "@/components/dashboard/page-banner";

type Tab = { key: string; label: string; href: string };

// A click the router takes, not one the browser does (a new tab or window).
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// The /live banner's controls, under the title: the league chips, the Feed/Grid toggle, then the
// Parlay slip (`children`). One wrapping row: what does not fit beside the rest drops to the next
// line, so no width measuring is needed (the old title-beside-controls row it measured is gone).
// The leagues and the views are links: both are query params the page reads on the server. They
// navigate client-side (next/link), so the layout above the page, and the Parlay slip it holds
// (ParlayPoolProvider), stays mounted from one league to the next. Not prefetched: each is a full
// per-user board.
export function LiveBannerRow({ leagues, league, views, view, children }: { leagues: Tab[]; league: string; views: Tab[]; view: string; children: ReactNode }) {
  // The chip just clicked, lit at once: a client-side navigation shows nothing until the server
  // answers. Cleared when the page it asked for arrives.
  const [pendingLeague, setPendingLeague] = useState<string | null>(null);
  const [pendingView, setPendingView] = useState<string | null>(null);
  useEffect(() => {
    setPendingLeague(null);
    setPendingView(null);
  }, [league, view]);
  const shownLeague = pendingLeague ?? league;
  const shownView = pendingView ?? view;

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <nav aria-label="League" className={BANNER_GROUP}>
        {leagues.map((l) => (
          <Link
            key={l.key}
            href={l.href}
            prefetch={false}
            onClick={(e) => {
              if (plainClick(e)) setPendingLeague(l.key);
            }}
            aria-current={l.key === league ? "page" : undefined}
            className={BANNER_SEG + "px-[13px] " + (l.key === shownLeague ? BANNER_SEG_ON : BANNER_SEG_OFF)}
          >
            <span>{l.label}</span>
          </Link>
        ))}
      </nav>
      <nav aria-label="View" className={BANNER_GROUP}>
        {views.map((v) => (
          <Link
            key={v.key}
            href={v.href}
            prefetch={false}
            onClick={(e) => {
              if (plainClick(e)) setPendingView(v.key);
            }}
            aria-current={v.key === view ? "page" : undefined}
            className={BANNER_SEG + "px-[13px] " + (v.key === shownView ? BANNER_SEG_ON : BANNER_SEG_OFF)}
          >
            <span>{v.label}</span>
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
