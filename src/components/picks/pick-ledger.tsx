"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LocalGameTime } from "@/components/local-game-time";
import { updatePickStatusAction, deletePickAction } from "@/server/actions/picks";
import type { LedgerSection } from "@/lib/pick-display";

// Serializable row model built on the server (page.tsx) - all display strings
// are precomputed there via lib/pick-display so this file is layout only.
export type LedgerRow = {
  id: string;
  sportName: string;
  gameTimeIso: string;
  label: string;
  tag: string;
  capperName: string;
  capperInitials: string;
  capperRecord: string | null;
  matchup: string; // "Away @ Home" or the final score for settled picks
  oddsText: string;
  unitsText: string;
  status: "PENDING" | "WIN" | "LOSS" | "PUSH" | "CANCELLED";
  isLive: boolean;
  resultUnitsText: string | null; // "+0.91u" / "-1u" for WIN/LOSS
  consensus: string | null;
};

const PAGE_SIZE = 10;

const SECTION_LABEL: Record<LedgerSection, string> = {
  live: "Live",
  upcoming: "Upcoming",
  settled: "Settled",
};

function StatusPill({ row }: { row: LedgerRow }) {
  const base = "inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium";
  if (row.status === "WIN")
    return (
      <span className={base + " bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"}>
        Won {row.resultUnitsText}
      </span>
    );
  if (row.status === "LOSS")
    return (
      <span className={base + " bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400"}>
        Lost {row.resultUnitsText}
      </span>
    );
  if (row.status === "PUSH") return <span className={base + " bg-muted text-muted-foreground"}>Push</span>;
  if (row.status === "CANCELLED") return <span className={base + " bg-muted text-muted-foreground"}>Cancelled</span>;
  if (row.isLive)
    return (
      <span className={base + " bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"}>Live</span>
    );
  return <span className={base + " bg-muted text-muted-foreground"}>Pending</span>;
}

// The "..." menu: manual Win/Loss/Push override plus Delete (with an inline
// confirm, same shape as RowDeleteButton).
function RowMenu({ row }: { row: LedgerRow }) {
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

  function run(action: () => Promise<{ success: true } | { success: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        close();
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
        aria-label="Pick actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
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
                  disabled={busy || row.status === s}
                  onClick={() => run(() => updatePickStatusAction(row.id, s))}
                  className={itemClass}
                >
                  {s === "WIN" ? "Win" : s === "LOSS" ? "Loss" : "Push"}
                  {row.status === s ? " (current)" : ""}
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
                  onClick={() => run(() => deletePickAction(row.id))}
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

function Row({ row, showDate }: { row: LedgerRow; showDate: boolean }) {
  const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return (
    <div className="flex items-start gap-3 px-4 py-3 sm:items-center sm:gap-4 sm:px-5">
      <div className="hidden w-16 shrink-0 text-xs leading-tight text-muted-foreground sm:block">
        <div className="font-medium">{row.sportName}</div>
        <div className="mt-0.5">
          {showDate && (
            <>
              <LocalGameTime date={row.gameTimeIso} options={{ month: "short", day: "numeric" }} />
              <br />
            </>
          )}
          <LocalGameTime date={row.gameTimeIso} options={timeOptions} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{row.label}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {row.tag}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[9px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
              {row.capperInitials}
            </span>
            <span className="text-foreground/80">{row.capperName}</span>
            {row.capperRecord && <span>({row.capperRecord})</span>}
          </span>
          <span className="hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <div className="mt-0.5 sm:mt-0">{row.matchup}</div>
          <div className="mt-0.5 sm:hidden">
            {row.sportName} · <LocalGameTime date={row.gameTimeIso} options={timeOptions} />
          </div>
        </div>
        {row.consensus && (
          <div className="mt-1 text-xs font-medium text-brand-600 dark:text-brand-400">{row.consensus}</div>
        )}
        {/* Phone: odds/units and status sit under the label. */}
        <div className="mt-2 flex items-center gap-2 sm:hidden">
          <span className="text-xs tabular-nums text-muted-foreground">
            {row.oddsText} · {row.unitsText}
          </span>
          <StatusPill row={row} />
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.oddsText} · {row.unitsText}
        </span>
        <StatusPill row={row} />
      </div>

      <RowMenu row={row} />
    </div>
  );
}

function Section({ kind, rows, showDate }: { kind: LedgerSection; rows: LedgerRow[]; showDate: boolean }) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const remaining = rows.length - shown;
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {kind === "live" && <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />}
        {SECTION_LABEL[kind]}
        <span className="font-normal">{rows.length}</span>
      </h2>
      <div className="rounded-card bg-card shadow-soft">
        <div className="divide-y divide-border-subtle">
          {rows.slice(0, shown).map((row) => (
            <Row key={row.id} row={row} showDate={showDate} />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown(rows.length)}
              className="block w-full px-5 py-3 text-center text-sm font-medium text-brand-600 hover:bg-muted dark:text-brand-400"
            >
              Show {remaining} more
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function PickLedger({
  sections,
  showDate,
}: {
  sections: { key: LedgerSection; rows: LedgerRow[] }[];
  showDate: boolean;
}) {
  return (
    <>
      {sections.map((s) => (
        <Section key={s.key} kind={s.key} rows={s.rows} showDate={showDate} />
      ))}
    </>
  );
}
