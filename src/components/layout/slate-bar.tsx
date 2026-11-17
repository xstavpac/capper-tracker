"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  SLATE_DAYS,
  SLATE_DAY_LABEL,
  SLATE_LEAGUES,
  orderSlateLeagues,
  slateTotals,
  type LeagueSlate,
  type SlateCounts,
  type SlateDay,
} from "@/lib/slate-counts";

// The Slate Bar under the top header: a date + league chip row and a three-cell stats strip.
// Counts come from the layout (the cached score feed /live reads), so nothing here fetches.
// Sizes and colors are the spec's: chips 50px tall, strip 58px, nothing above weight 700.

const CHIP =
  "flex h-[50px] shrink-0 items-center gap-2 rounded-xl border border-[#2a3c66] bg-[rgba(18,32,70,.85)] px-[9px] text-left transition-colors";
const CHIP_ACTIVE = "!border-[1.5px] !border-[#3b82f6] !bg-[#12306b] shadow-[0_0_0_3px_rgba(59,130,246,.22),0_0_14px_rgba(59,130,246,.35)]";

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0 text-[#a9b8d6]" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={"h-3.5 w-3.5 shrink-0 text-[#a9b8d6] transition-transform " + (open ? "rotate-180" : "")} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function DatePicker({ day, onChange }: { day: SlateDay; onChange: (d: SlateDay) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    // Outside the scrolling league row, so its menu is not clipped by the row's overflow.
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label={"Date: " + SLATE_DAY_LABEL[day] + ", change"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={CHIP + " gap-1.5 hover:bg-[#162a5a] " + (open ? "!border-[#3b82f6]" : "")}
      >
        <CalendarIcon />
        <span className="text-[12px] font-semibold text-white">{SLATE_DAY_LABEL[day]}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="Slate date"
          className="absolute left-0 top-full z-50 mt-1.5 w-40 overflow-hidden rounded-xl border border-[#2a3c66] bg-[#0f1d40] p-1 shadow-xl"
        >
          {SLATE_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              role="option"
              aria-selected={d === day}
              onClick={() => {
                onChange(d);
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className={
                "flex h-11 w-full items-center rounded-lg px-3 text-left text-[13px] font-semibold transition-colors hover:bg-white/10 " +
                (d === day ? "bg-[#12306b] text-white" : "text-[#c7d2e6]")
              }
            >
              {SLATE_DAY_LABEL[d]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LeagueChip({ league, day, active }: { league: LeagueSlate; day: SlateDay; active: boolean }) {
  const meta = SLATE_LEAGUES.find((l) => l.key === league.sportKey);
  if (!meta) return null;
  const n = league.days[day].games;
  const subline = league.failed ? null : n > 0 ? n + (n === 1 ? " game" : " games") : league.offseason ? "Offseason" : "No games";
  const inner = (
    <>
      <Image src={meta.logo} alt="" width={20} height={20} className="h-5 w-5 shrink-0 object-contain" />
      <span className="flex flex-col leading-tight">
        <span className="text-[12px] font-semibold text-white">{meta.label}</span>
        {subline && <span className="text-[10px] font-medium text-[#a9b8d6]">{subline}</span>}
      </span>
    </>
  );
  // A failed feed keeps the chip clickable (counts are just hidden); a league with no games or out
  // of season is not.
  if (n > 0 || league.failed) {
    return (
      <Link
        href={"/live?sport=" + league.sportKey}
        aria-label={meta.label + (league.failed ? "" : ", " + n + (n === 1 ? " game" : " games")) + ", open Live"}
        aria-current={active ? "page" : undefined}
        className={CHIP + " hover:bg-[#162a5a] " + (active ? CHIP_ACTIVE : "")}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div role="group" aria-label={meta.label + ", " + (league.offseason ? "offseason" : "no games")} className={CHIP + " opacity-80"}>
      {inner}
    </div>
  );
}

const CELL = "flex h-full flex-col items-center justify-center text-center";

function StatsStrip({ counts, day }: { counts: SlateCounts; day: SlateDay }) {
  const allFailed = counts.leagues.length > 0 && counts.leagues.every((l) => l.failed);
  const t = slateTotals(counts, day);
  const liveHref = "/live?" + (t.liveTop ? "sport=" + t.liveTop + "&" : "") + "status=live";
  const pendingHref = "/live?" + (t.pendingTop ? "sport=" + t.pendingTop + "&" : "") + "status=pending";
  return (
    <div className="grid h-[58px] grid-cols-3 divide-x divide-[#2a3c66] border-t border-[#22345e] bg-[rgba(7,16,40,.55)]">
      <Link href={liveHref} aria-label={(allFailed ? "Live games" : t.live + " live games") + ", open Live"} className={CELL + " transition-colors hover:bg-white/5"}>
        <span className="text-[21px] font-bold leading-none text-[#22c55e]">{allFailed ? "–" : t.live}</span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Live games</span>
      </Link>
      <Link href={pendingHref} aria-label={(allFailed ? "Pending games" : t.pending + " pending games") + ", open Live"} className={CELL + " transition-colors hover:bg-white/5"}>
        <span className="text-[21px] font-bold leading-none text-white">{allFailed ? "–" : t.pending}</span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Pending</span>
      </Link>
      <div className={CELL}>
        <span className="text-[21px] font-bold leading-none text-[#60a5fa]">{SLATE_DAY_LABEL[day]}</span>
        <span className="mt-1 text-[11px] font-medium text-[#c7d2e6]">Game slate</span>
      </div>
    </div>
  );
}

export function SlateBar({ counts }: { counts: SlateCounts }) {
  const [day, setDay] = useState<SlateDay>("today");
  const pathname = usePathname();
  const activeSport = useSearchParams().get("sport");
  const onLive = pathname === "/live" || pathname.startsWith("/live/");
  const leagues = orderSlateLeagues(counts, day);

  return (
    <div role="region" aria-label="Slate">
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <DatePicker day={day} onChange={setDay} />
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {leagues.map((l) => (
            <LeagueChip key={l.sportKey} league={l} day={day} active={onLive && activeSport === l.sportKey} />
          ))}
        </div>
      </div>
      <StatsStrip counts={counts} day={day} />
    </div>
  );
}

// Same footprint as the bar (50px chips, 58px strip) so nothing shifts when the counts arrive.
export function SlateBarSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex items-center gap-1.5 overflow-hidden px-2.5 py-2">
        <div className="flex h-[50px] w-[104px] shrink-0 animate-pulse rounded-xl border border-[#2a3c66] bg-[rgba(18,32,70,.85)] motion-reduce:animate-none" />
        {SLATE_LEAGUES.map((l) => (
          <div key={l.key} className="my-1 h-[50px] w-[92px] shrink-0 animate-pulse rounded-xl border border-[#2a3c66] bg-[rgba(18,32,70,.85)] motion-reduce:animate-none" />
        ))}
      </div>
      <div className="grid h-[58px] grid-cols-3 divide-x divide-[#2a3c66] border-t border-[#22345e] bg-[rgba(7,16,40,.55)]">
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
