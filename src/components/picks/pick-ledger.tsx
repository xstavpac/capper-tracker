"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LocalGameTime } from "@/components/local-game-time";
import { ChevronDownIcon } from "@/components/dashboard/cappers-icons";
import { GREEN, RED, TINTS } from "@/components/dashboard/panel-shell";
import { updatePickStatusAction, deletePickAction, loadOlderPicksAction, reloadOlderPickRowAction } from "@/server/actions/picks";
import type { LedgerSection, PickPhase } from "@/lib/pick-display";
import { groupByDay, type OlderPicksCursor, type OlderPicksQuery } from "@/lib/older-picks";

// Serializable row model built on the server (page.tsx) - all display strings
// are precomputed there via lib/pick-display so this file is layout only.
export type LedgerRow = {
  id: string;
  sportName: string;
  gameTimeIso: string;
  label: string;
  tag: string;
  capperId: string;
  capperName: string;
  capperInitials: string;
  capperRecord: string | null;
  matchup: string; // "Away @ Home" or the final score for settled picks
  oddsText: string;
  unitsText: string;
  phase: PickPhase;
  currentStatus: string; // stored PickStatus, for the menu's (current) marker
  liveScore: string | null; // "away-home" from the live feed, when matched
  resultUnitsText: string | null; // "+0.91u" / "-1u" for WIN/LOSS
  consensus: string | null;
  consensusHref: string | null; // the game's /live page, when today's slate has it
};

// A section's own record and net units, shown in its header (Settled only).
export type LedgerSectionSummary = { wins: number; losses: number; pushes: number; netUnits: number };

// Rows a section shows before its "Show N more" link.
const PAGE_SIZE = 25;

const SECTION_LABEL: Record<LedgerSection, string> = {
  live: "Live",
  upcoming: "Upcoming",
  settled: "Settled",
};

// The header bar's tint: Live light red, Upcoming light blue, Settled neutral.
const SECTION_TINT: Record<LedgerSection, string> = {
  live: "border-[#F6D9D9] bg-[#FFF1F1] text-[#B91C1C] dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400",
  upcoming: "border-[#DCE5FB] bg-[#EEF3FF] text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300",
  settled: "border-[#E4E7EE] bg-[#F1F3F7] text-[#3A4152] dark:border-border dark:bg-white/[0.04] dark:text-foreground/80",
};

const MUTED = "text-[#5B6275] dark:text-muted-foreground";

// League badge colors. Every pair is at least 4.5:1 (white on the solid ones, dark orange on WNBA's
// light orange); a league not listed gets the neutral badge.
const LEAGUE_BADGE: Record<string, string> = {
  NFL: "bg-[#15803D] text-white",
  NCAAF: "bg-[#0F766E] text-white",
  MLB: "bg-[#1E3A8A] text-white",
  NHL: "bg-[#0369A1] text-white",
  NBA: "bg-[#C2410C] text-white",
  WNBA: "bg-[#FFEDD5] text-[#9A3412]",
  NCAAB: "bg-[#4338CA] text-white",
  CFL: "bg-[#B91C1C] text-white",
};
const LEAGUE_BADGE_NEUTRAL = "bg-[#E6E8EF] text-[#3A4152] dark:bg-white/10 dark:text-foreground";

function LeagueBadge({ name }: { name: string }) {
  return (
    <span className={"inline-flex max-w-full rounded-full px-2 py-[3px] text-[10px] font-bold uppercase leading-none tracking-[0.06em] " + (LEAGUE_BADGE[name] ?? LEAGUE_BADGE_NEUTRAL)}>
      <span className="truncate">{name}</span>
    </span>
  );
}

function StatusPill({ row }: { row: LedgerRow }) {
  const base = "inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold";
  const neutral = base + " bg-[#EEF0F4] text-[#5B6275] dark:bg-muted dark:text-muted-foreground";
  switch (row.phase) {
    case "won":
      return (
        <span className={base + " bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"}>
          Won {row.resultUnitsText}
        </span>
      );
    case "lost":
      return (
        <span className={base + " bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400"}>
          Lost {row.resultUnitsText}
        </span>
      );
    case "push":
      return <span className={neutral}>Push</span>;
    case "cancelled":
      return <span className={neutral}>Cancelled</span>;
    case "grading":
      return <span className={neutral}>Grading</span>;
    case "awaiting":
      return <span className={neutral}>Awaiting result</span>;
    case "live":
      return (
        <span className={base + " bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"}>
          Live{row.liveScore ? " " + row.liveScore : ""}
        </span>
      );
    default:
      return <span className={neutral}>Pending</span>;
  }
}

// The "..." menu: manual Win/Loss/Push override plus Delete (with an inline
// confirm, same shape as RowDeleteButton).
// `onChanged`: an older row (not part of the server-rendered page) is patched by its owner too.
function RowMenu({ row, onChanged }: { row: LedgerRow; onChanged?: (change: "status" | "deleted") => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setConfirming(false);
    setError(null);
  }

  function run(action: () => Promise<{ success: true } | { success: false; error: string }>, change: "status" | "deleted") {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        close();
        onChanged?.(change);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  const itemClass = "block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={"flex h-8 w-8 items-center justify-center rounded-[10px] transition hover:bg-[#EEF0F4] hover:text-foreground dark:hover:bg-muted " + MUTED}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-44 rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {!confirming ? (
            <>
              <div className="px-3 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Mark result
              </div>
              {(["WIN", "LOSS", "PUSH"] as const).map((s) => (
                <button
                  key={s}
                  role="menuitem"
                  disabled={busy || row.currentStatus === s}
                  onClick={() => run(() => updatePickStatusAction(row.id, s), "status")}
                  className={itemClass}
                >
                  {s === "WIN" ? "Win" : s === "LOSS" ? "Loss" : "Push"}
                  {row.currentStatus === s ? " (current)" : ""}
                </button>
              ))}
              <div className="my-1 border-t border-border-subtle" />
              <button
                role="menuitem"
                onClick={() => setConfirming(true)}
                className={itemClass + " text-red-600 dark:text-red-400"}
              >
                Delete pick
              </button>
            </>
          ) : (
            <div className="p-2 text-sm">
              <div className={error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
                {error ?? "Delete this pick?"}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => run(() => deletePickAction(row.id), "deleted")}
                  className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? "Deleting..." : "Delete"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className="rounded-full px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CONSENSUS_PILL = "mt-1.5 inline-flex rounded-full bg-[#E6ECFF] px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300";

// One grid: league + time | pick | odds + status | menu. On a phone the league badge and time become
// a line of their own above the pick, and the odds / status column stays on the right.
function Row({ row, showDate, onChanged }: { row: LedgerRow; showDate: boolean; onChanged?: (change: "status" | "deleted") => void }) {
  const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_32px] items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[76px_minmax(0,1fr)_auto_32px] sm:items-center sm:gap-x-4 sm:px-5">
      <div className="col-span-3 flex min-w-0 items-center gap-2 sm:col-span-1 sm:block">
        <LeagueBadge name={row.sportName} />
        <div className={"whitespace-nowrap text-[11.5px] font-medium leading-tight tabular-nums sm:mt-1 " + MUTED}>
          {showDate && (
            <>
              <LocalGameTime date={row.gameTimeIso} options={{ month: "short", day: "numeric" }} />
              <span className="sm:hidden"> · </span>
              <br className="max-sm:hidden" />
            </>
          )}
          <LocalGameTime date={row.gameTimeIso} options={timeOptions} />
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[15px] font-bold leading-snug tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">{row.label}</span>
          <span className="rounded-full bg-[#EEF0F4] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-[0.05em] text-[#5B6275] dark:bg-muted dark:text-muted-foreground">
            {row.tag}
          </span>
        </div>
        <div className={"mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-medium " + MUTED}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#E6ECFF] text-[9px] font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
            {row.capperInitials}
          </span>
          <Link href={"/cappers/" + row.capperId} className="font-semibold text-foreground hover:underline">
            {row.capperName}
          </Link>
          {row.capperRecord && <span className="tabular-nums">({row.capperRecord})</span>}
          <span aria-hidden="true">·</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.matchup}</span>
        </div>
        {row.consensus &&
          (row.consensusHref ? (
            <Link href={row.consensusHref} className={CONSENSUS_PILL + " transition hover:bg-[#D6E0FF] dark:hover:bg-brand-500/25"}>
              {row.consensus}
            </Link>
          ) : (
            <span className={CONSENSUS_PILL}>{row.consensus}</span>
          ))}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span className={"whitespace-nowrap text-xs font-medium tabular-nums " + MUTED}>
          {row.oddsText} · {row.unitsText}
        </span>
        <StatusPill row={row} />
      </div>

      <RowMenu row={row} onChanged={onChanged} />
    </div>
  );
}

const record = (s: LedgerSectionSummary) => s.wins + "–" + s.losses + "–" + s.pushes;
const signedUnits = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + "u";

// A status group as its own white card under a tinted header bar. Only a collapsible section (Settled)
// has the chevron, and its whole header is the toggle.
function Section({
  kind,
  rows,
  summary,
  showDate,
  collapsible,
  defaultCollapsed,
  footer,
}: {
  kind: LedgerSection;
  rows: LedgerRow[];
  summary?: LedgerSectionSummary;
  showDate: boolean;
  collapsible: boolean;
  defaultCollapsed: boolean;
  // Shown under the rows once all of them are revealed (Settled: the older picks).
  footer?: ReactNode;
}) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const remaining = rows.length - shown;
  const label = SECTION_LABEL[kind];
  const bodyId = "ledger-" + kind;
  const bar = "flex w-full items-center gap-2 border-b px-4 py-2.5 text-left sm:px-5 " + (collapsed ? "rounded-[17px] border-b-transparent " : "rounded-t-[17px] ") + SECTION_TINT[kind];
  const header: ReactNode = (
    <>
      {kind === "live" && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />}
      <span className="text-[11px] font-bold uppercase tracking-[0.08em]">{label}</span>
      <span className="text-xs font-bold tabular-nums">{rows.length}</span>
      {summary && (
        <span className={"min-w-0 truncate text-xs font-semibold tabular-nums " + MUTED}>
          {record(summary)} · <span className={summary.netUnits > 0 ? GREEN : summary.netUnits < 0 ? RED : ""}>{signedUnits(summary.netUnits)}</span>
        </span>
      )}
      <span className={"ml-auto shrink-0 whitespace-nowrap text-[11.5px] font-medium max-[419px]:hidden " + MUTED}>Sorted by start time</span>
      {collapsible && <ChevronDownIcon className={"h-4 w-4 shrink-0 stroke-[2.4] transition-transform max-[419px]:ml-auto " + (collapsed ? "" : "rotate-180")} />}
    </>
  );
  return (
    <section aria-label={label + " picks"} className={"rounded-[18px] border " + TINTS.neutral.card}>
      {collapsible ? (
        <h2>
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(!collapsed)} className={bar}>
            {header}
          </button>
        </h2>
      ) : (
        <h2 className={bar}>{header}</h2>
      )}
      {!collapsed && (
        <div id={bodyId} className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
          {rows.slice(0, shown).map((row) => (
            <Row key={row.id} row={row} showDate={showDate} />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown(rows.length)}
              className="block w-full rounded-b-[17px] px-5 py-3 text-center text-[13px] font-semibold text-brand-600 hover:bg-[#F5F6FA] dark:text-brand-400 dark:hover:bg-muted"
            >
              Show {remaining} more {label.toLowerCase()} pick{remaining === 1 ? "" : "s"}
            </button>
          )}
          {remaining <= 0 && footer}
        </div>
      )}
    </section>
  );
}

// ---- Older picks ("Load older picks") ----
// Rows strictly before the page's window, read a click at a time by
// loadOlderPicksAction. They live only here, in client state: the Settled
// header, the summary strip and the glance cards are the server's numbers for
// the window and never change when older rows load.

type OlderState = {
  // olderQueryKey these rows were loaded under; a filter change starts over.
  key: string;
  rows: LedgerRow[];
  cursor: OlderPicksCursor | null;
  hasMore: boolean;
  // Rows the last click returned (null before the first click).
  lastCount: number | null;
  loading: boolean;
  error: string | null;
  // capperId -> "W-L" for cappers not on the first page.
  records: Record<string, string>;
};

const freshOlder = (key: string): OlderState => ({ key, rows: [], cursor: null, hasMore: true, lastCount: null, loading: false, error: null, records: {} });

// The viewer's own calendar day, like the times on every row.
function localDayKey(iso: string): string {
  const d = new Date(iso);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function dayHeading(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

const OLDER_BUTTON = "block w-full px-5 py-3 text-center text-[13px] font-semibold text-brand-600 hover:bg-[#F5F6FA] disabled:opacity-60 dark:text-brand-400 dark:hover:bg-muted";
const OLDER_LINK = "text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-400";

function OlderPicks({
  state,
  recordFor,
  onLoad,
  onRowChanged,
  bare,
}: {
  state: OlderState;
  recordFor: (row: LedgerRow) => string | null;
  onLoad: () => void;
  onRowChanged: (row: LedgerRow, change: "status" | "deleted") => void;
  // No Settled card to sit in: a plain link under the ledger until something loads.
  bare: boolean;
}) {
  // Grouped over the whole merged list on every render: a day split across two clicks has one header.
  const days = groupByDay(state.rows, (r) => localDayKey(r.gameTimeIso));
  const link = bare && state.rows.length === 0;
  const emptyStretch = state.lastCount === 0 && state.hasMore;
  const control = state.loading ? (
    <button type="button" disabled className={link ? OLDER_LINK + " opacity-60" : OLDER_BUTTON}>
      Loading older picks...
    </button>
  ) : state.error ? (
    <div className={link ? "text-center" : "px-5 py-3 text-center"}>
      <span className="text-[13px] font-medium text-red-600 dark:text-red-400">{state.error} </span>
      <button type="button" onClick={onLoad} className={OLDER_LINK}>
        Try again
      </button>
    </div>
  ) : state.hasMore ? (
    <button type="button" onClick={onLoad} className={link ? OLDER_LINK : OLDER_BUTTON}>
      {emptyStretch ? "No matching picks in this stretch, load older" : "Load older picks"}
    </button>
  ) : state.rows.length === 0 ? (
    <p className={"text-center text-[13px] font-medium " + MUTED + (link ? "" : " px-5 py-3")}>No older picks.</p>
  ) : null;

  if (link) return <div className="flex justify-center py-1">{control}</div>;
  const body = (
    <>
      {days.map((day) => (
        <div key={day.dayKey}>
          <div className={"border-y border-[#0F1420]/[0.06] bg-[#F7F8FB] px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] dark:border-white/10 dark:bg-white/[0.03] sm:px-5 " + MUTED}>
            {dayHeading(day.rows[0].gameTimeIso)}
          </div>
          <div className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
            {day.rows.map((row) => (
              <Row key={row.id} row={{ ...row, capperRecord: recordFor(row) }} showDate={false} onChanged={(change) => onRowChanged(row, change)} />
            ))}
          </div>
        </div>
      ))}
      {control}
    </>
  );
  if (!bare) return <div className="overflow-hidden rounded-b-[17px]">{body}</div>;
  return (
    <section aria-label="Older picks" className={"rounded-[18px] border " + TINTS.neutral.card}>
      <h2 className={"flex w-full items-center gap-2 rounded-t-[17px] border-b px-4 py-2.5 sm:px-5 " + SECTION_TINT.settled}>
        <span className="text-[11px] font-bold uppercase tracking-[0.08em]">Earlier</span>
      </h2>
      <div className="overflow-hidden rounded-b-[17px]">{body}</div>
    </section>
  );
}

// `collapseSettled`: Settled starts closed (today, while there is still something live or upcoming
// above it); everywhere else it starts open. Older picks hang under Settled, or under the ledger
// when the window has no Settled section.
export function PickLedger({
  sections,
  showDate,
  collapseSettled,
  olderQuery,
  olderQueryKey,
}: {
  sections: { key: LedgerSection; rows: LedgerRow[]; summary?: LedgerSectionSummary }[];
  showDate: boolean;
  collapseSettled: boolean;
  olderQuery: OlderPicksQuery;
  olderQueryKey: string;
}) {
  const [stored, setOlder] = useState<OlderState>(() => freshOlder(olderQueryKey));
  // A filter change resets to nothing loaded (and drops a click still in flight - see patch).
  const older = stored.key === olderQueryKey ? stored : freshOlder(olderQueryKey);
  if (stored.key !== olderQueryKey) setOlder(older);

  // First-page records win: the page re-renders them after every change.
  const pageRecords = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of sections) for (const r of s.rows) m.set(r.capperId, r.capperRecord);
    return m;
  }, [sections]);
  const recordFor = (row: LedgerRow) =>
    pageRecords.has(row.capperId) ? (pageRecords.get(row.capperId) ?? null) : (older.records[row.capperId] ?? row.capperRecord);

  // Only the state for `key` is ever updated: a response that lands after a filter change is dropped.
  const patch = (key: string, f: (s: OlderState) => OlderState) => setOlder((s) => (s.key === key ? f(s) : s));

  async function loadOlder() {
    const key = olderQueryKey;
    const known = Array.from(new Set([...Array.from(pageRecords.keys()), ...Object.keys(older.records)]));
    patch(key, (s) => ({ ...s, loading: true, error: null }));
    const res = await loadOlderPicksAction(olderQuery, older.cursor, known).catch(() => ({ success: false as const, error: "Couldn't load older picks." }));
    patch(key, (s) =>
      res.success
        ? { ...s, rows: [...s.rows, ...res.rows], cursor: res.cursor, hasMore: res.hasMore, lastCount: res.rows.length, loading: false, records: { ...s.records, ...res.capperRecords } }
        : { ...s, loading: false, error: res.error }
    );
  }

  async function onRowChanged(row: LedgerRow, change: "status" | "deleted") {
    const key = olderQueryKey;
    if (change === "deleted") {
      patch(key, (s) => ({ ...s, rows: s.rows.filter((r) => r.id !== row.id) }));
      return;
    }
    const res = await reloadOlderPickRowAction(row.id).catch(() => null);
    if (!res?.success) return;
    const fresh = res.row;
    patch(key, (s) => ({
      ...s,
      rows: fresh ? s.rows.map((r) => (r.id === row.id ? fresh : r)) : s.rows.filter((r) => r.id !== row.id),
      records: res.capperRecord ? { ...s.records, [row.capperId]: res.capperRecord } : s.records,
    }));
  }

  const olderBlock = (bare: boolean) => <OlderPicks state={older} recordFor={recordFor} onLoad={loadOlder} onRowChanged={onRowChanged} bare={bare} />;
  const hasSettled = sections.some((s) => s.key === "settled");

  return (
    <>
      {sections.map((s) => (
        <Section
          key={s.key}
          kind={s.key}
          rows={s.rows}
          summary={s.summary}
          showDate={showDate}
          collapsible={s.key === "settled"}
          defaultCollapsed={collapseSettled}
          footer={s.key === "settled" ? olderBlock(false) : undefined}
        />
      ))}
      {!hasSettled && olderBlock(true)}
    </>
  );
}
