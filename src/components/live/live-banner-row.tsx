"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ClipboardIcon, GridIcon } from "@/components/dashboard/cappers-icons";
import { LIVE_PILL, LIVE_PILL_OFF, LIVE_PILL_ON, LIVE_PILL_ROW } from "@/components/live/live-pill-styles";
import { SLATE_LEAGUES, leagueLogoForLight } from "@/lib/slate-counts";

type Tab = { key: string; label: string; href: string };

// A click the router takes, not one the browser does (a new tab or window).
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// The /live pills under the banner: row 1 NFL NBA MLB NHL WNBA, row 2 NCAAF NCAAB and the Parlay slip
// (`children`), row 3 the Feed / Grid toggle. A row that does not fit scrolls sideways. The leagues
// and the views are links: both are query params the page reads on the server. They navigate
// client-side (next/link), so the layout above the page, and the Parlay slip it holds
// (ParlayPoolProvider), stays mounted from one league to the next. Not prefetched: each is a full
// per-user board. The logos are the Slate Bar's (SLATE_LEAGUES), in the light-surface variant.
const FIRST_ROW = 5;
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

  const logoOf = (key: string) => {
    const meta = SLATE_LEAGUES.find((m) => m.key === key);
    return meta ? leagueLogoForLight(meta.logo) : null;
  };
  const leaguePill = (l: Tab) => {
    const on = l.key === shownLeague;
    const logo = logoOf(l.key);
    return (
      <Link
        key={l.key}
        href={l.href}
        prefetch={false}
        onClick={(e) => {
          if (plainClick(e)) setPendingLeague(l.key);
        }}
        aria-current={l.key === league ? "page" : undefined}
        className={LIVE_PILL + (on ? LIVE_PILL_ON : LIVE_PILL_OFF)}
      >
        {logo && (
          <span className={"flex flex-none items-center justify-center rounded-full " + (on ? "h-7 w-7 bg-white" : "h-6 w-6")}>
            <Image src={logo} alt="" width={24} height={24} className={"object-contain " + (on ? "h-5 w-5" : "h-6 w-6")} />
          </span>
        )}
        <span>{l.label}</span>
        {on && <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-white" />}
      </Link>
    );
  };

  // From 768px: one wrapping row (leagues, the toggle, then the Parlay slip), so the Parlay slip
  // is drawn twice: in the leagues' second row below 768px, and last in the row from 768px. The
  // hidden copy is display:none, so it is neither seen nor read.
  return (
    <div className="flex max-w-full flex-col gap-[14px] md:flex-row md:flex-wrap md:items-center md:gap-3">
      <nav aria-label="League" className="flex flex-col gap-[14px] md:flex-row md:flex-wrap md:gap-2">
        <div className={LIVE_PILL_ROW + " md:contents"}>{leagues.slice(0, FIRST_ROW).map(leaguePill)}</div>
        <div className={LIVE_PILL_ROW + " md:contents"}>
          {leagues.slice(FIRST_ROW).map(leaguePill)}
          <div className="flex-none md:hidden">{children}</div>
        </div>
      </nav>
      <nav aria-label="View" className={LIVE_PILL_ROW + " md:!my-0 md:!py-0"}>
        <div className="flex h-[46px] flex-none items-center gap-[3px] rounded-full border border-[#dbe5f6] bg-[rgba(255,255,255,.8)] p-[3px] shadow-[0_2px_10px_rgba(30,64,175,.08)]">
          {views.map((v) => {
            const on = v.key === shownView;
            return (
              <Link
                key={v.key}
                href={v.href}
                prefetch={false}
                onClick={(e) => {
                  if (plainClick(e)) setPendingView(v.key);
                }}
                aria-current={v.key === view ? "page" : undefined}
                className={"inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[14px] font-semibold leading-none transition " + (on ? "bg-[linear-gradient(180deg,#3b82f6,#1d4ed8)] text-white shadow-[0_6px_18px_rgba(37,99,235,.45),inset_0_1px_0_rgba(255,255,255,.35)]" : "text-[#0b1838] hover:bg-white")}
              >
                {v.key === "feed" ? <ClipboardIcon className="h-[18px] w-[18px] flex-none" /> : <GridIcon className="h-[18px] w-[18px] flex-none" />}
                <span>{v.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="hidden flex-none md:block">{children}</div>
    </div>
  );
}
