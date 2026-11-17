"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ClipboardIcon, GridIcon } from "@/components/dashboard/cappers-icons";
import { LIVE_PILL, LIVE_PILL_OFF, LIVE_PILL_ON, LIVE_PILL_ROW } from "@/components/live/live-pill-styles";
import { MobileOnly, PhoneOnly, TabletUp } from "@/components/layout/mobile-only";
import { SLATE_LEAGUES, leagueLogoForLight } from "@/lib/slate-counts";

type Tab = { key: string; label: string; href: string };

// A click the router takes, not one the browser does (a new tab or window).
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// The Feed / Grid toggle: one joined glass pill. In the banner (desktop) it is bare; under the banner
// (below 1024px) it is a row that scrolls sideways. Lights the clicked option at once, before the
// server answers.
export function LiveViewToggle({ views, view, inBanner = false }: { views: Tab[]; view: string; inBanner?: boolean }) {
  const [pendingView, setPendingView] = useState<string | null>(null);
  useEffect(() => setPendingView(null), [view]);
  const shownView = pendingView ?? view;
  return (
    <nav aria-label="View" className={inBanner ? "flex" : LIVE_PILL_ROW + " md:!m-0 md:!overflow-visible md:!p-0"}>
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
  );
}

// The /live pills under the banner, inside the banner's own container. The league pills are links
// (a query param the page reads on the server); from 1024px they are one row (scrolling sideways when
// it does not fit) and the Feed / Grid toggle and the Parlay slip (`children`) are in the banner, on
// the title line. Below 1024px: from 768px one wrapping row (leagues, the toggle, then the Parlay slip);
// under 768px three rows (NFL..WNBA / NCAAF NCAAB Parlay slip / Feed Grid), each scrolling sideways.
// The Parlay slip is drawn in each place it can appear, and only the one for this width stays in the DOM.
// The links navigate client-side (next/link), so the layout above the page, and the Parlay slip it
// holds (ParlayPoolProvider), stays mounted from one league to the next. Not prefetched: each is a
// full per-user board. The logos are the Slate Bar's (SLATE_LEAGUES), in the light-surface variant.
const FIRST_ROW = 5;
export function LiveBannerRow({ leagues, league, views, view, children }: { leagues: Tab[]; league: string; views: Tab[]; view: string; children: ReactNode }) {
  // The chip just clicked, lit at once: a client-side navigation shows nothing until the server
  // answers. Cleared when the page it asked for arrives.
  const [pendingLeague, setPendingLeague] = useState<string | null>(null);
  useEffect(() => setPendingLeague(null), [league]);
  const shownLeague = pendingLeague ?? league;

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
            {/* A plain <img>, not next/image: the pills work without the next.config images allowlist (jsdom tests). alt is empty because the league name is beside it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt="" width={24} height={24} loading={on ? undefined : "lazy"} className={"object-contain " + (on ? "h-5 w-5" : "h-6 w-6")} />
          </span>
        )}
        <span>{l.label}</span>
        {on && <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-white" />}
      </Link>
    );
  };

  return (
    <div className="flex max-w-full flex-col gap-[14px] md:flex-row md:flex-wrap md:items-center md:gap-x-3 md:gap-y-[10px] lg:flex-nowrap">
      <nav
        aria-label="League"
        className="flex flex-col gap-[14px] md:flex-row md:flex-wrap md:gap-2 lg:-mx-4 lg:-my-5 lg:min-w-0 lg:flex-nowrap lg:overflow-x-auto lg:px-4 lg:py-5 lg:[-ms-overflow-style:none] lg:[scrollbar-width:none] lg:[&::-webkit-scrollbar]:hidden"
      >
        <div className={LIVE_PILL_ROW + " md:contents"}>{leagues.slice(0, FIRST_ROW).map(leaguePill)}</div>
        <div className={LIVE_PILL_ROW + " md:contents"}>
          {leagues.slice(FIRST_ROW).map(leaguePill)}
          <PhoneOnly className="flex-none">{children}</PhoneOnly>
        </div>
      </nav>
      <MobileOnly>
        <div className="flex flex-col gap-[14px] md:flex-none md:flex-row md:items-center md:gap-3">
          <LiveViewToggle views={views} view={view} />
          <TabletUp className="flex-none">{children}</TabletUp>
        </div>
      </MobileOnly>
    </div>
  );
}
