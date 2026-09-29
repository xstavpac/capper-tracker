"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DateRangeFilter } from "@/components/picks/date-range-filter";
import type { BetTypeFilterKey } from "@/lib/bet-type-filter";

type Option = { value: string; label: string };

const RESULT_OPTIONS: Option[] = [
  { value: "PENDING", label: "Pending" },
  { value: "WIN", label: "Won" },
  { value: "LOSS", label: "Lost" },
  { value: "PUSH", label: "Push" },
  { value: "CANCELLED", label: "Cancelled" },
];

const chipBase =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60";
const chipIdle = "border-border bg-card text-foreground hover:bg-muted";
const chipActive = "border-brand-500/40 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300";

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A chip that opens a small popover; closes on outside click / Escape.
function ChipMenu({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={chipBase + " " + (active ? chipActive : chipIdle)}
      >
        {label}
        <Caret />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 min-w-[12rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function OptionList({
  options,
  value,
  allLabel,
  onPick,
  searchable,
}: {
  options: Option[];
  value: string;
  allLabel: string;
  onPick: (v: string) => void;
  searchable?: boolean;
}) {
  const [q, setQ] = useState("");
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const item = (v: string, text: string) => (
    <button
      key={v || "__all"}
      type="button"
      role="option"
      aria-selected={value === v}
      onClick={() => onPick(v)}
      className={
        "block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-muted " +
        (value === v ? "font-medium text-brand-700 dark:text-brand-300" : "text-foreground")
      }
    >
      {text}
    </button>
  );
  return (
    <div>
      {searchable && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="mb-1 w-full rounded-lg border border-border bg-card px-2 py-1 text-sm"
        />
      )}
      <div role="listbox" className="max-h-64 overflow-y-auto">
        {!q && item("", allLabel)}
        {shown.map((o) => item(o.value, o.label))}
      </div>
    </div>
  );
}

export function PicksFilterBar({
  cappers,
  sports,
  betTypeOptionsBySportId,
  todayKey,
  dateLabel,
  dateIsDefault,
  dateStart,
  dateEnd,
  isRange,
}: {
  cappers: Option[];
  sports: Option[];
  betTypeOptionsBySportId: Record<string, { value: BetTypeFilterKey; label: string }[]>;
  todayKey: string;
  dateLabel: string;
  dateIsDefault: boolean;
  dateStart: string;
  dateEnd: string;
  isRange: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const capperId = params.get("capperId") ?? "";
  const sportId = params.get("sportId") ?? "";
  const betType = params.get("betType") ?? "";
  const status = params.get("status") ?? "";

  function navigate(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    startTransition(() => router.push(qs ? pathname + "?" + qs : pathname));
  }

  function setSport(id: string) {
    const nextSport = id === sportId ? "" : id;
    const valid = (betTypeOptionsBySportId[nextSport] ?? []).some((o) => o.value === betType);
    navigate({ sportId: nextSport || null, betType: valid ? betType : null });
  }

  const betTypeOptions = betTypeOptionsBySportId[sportId] ?? betTypeOptionsBySportId[""] ?? [];
  const capperName = cappers.find((c) => c.value === capperId)?.label;
  const betTypeName = betTypeOptions.find((o) => o.value === betType)?.label;
  const resultName = RESULT_OPTIONS.find((o) => o.value === status)?.label;
  const anyActive = Boolean(capperId || sportId || betType || status || !dateIsDefault);

  return (
    <div className={"mb-5 flex flex-wrap items-center gap-2 " + (pending ? "opacity-70" : "")}>
      <ChipMenu label={dateLabel} active={!dateIsDefault}>
        {(close) => (
          <form
            className="flex flex-col gap-2 p-2"
            onChange={(e) => {
              const fd = new FormData(e.currentTarget);
              const changes: Record<string, string | null> = { date: null, startDate: null, endDate: null };
              for (const k of ["date", "startDate", "endDate"]) {
                const v = fd.get(k);
                if (typeof v === "string" && v) changes[k] = v;
              }
              navigate(changes);
            }}
            onSubmit={(e) => e.preventDefault()}
          >
            <DateRangeFilter
              initialDate={dateStart}
              initialStartDate={dateStart}
              initialEndDate={dateEnd}
              initialIsRange={isRange}
            />
            <button
              type="button"
              onClick={() => {
                navigate({ date: null, startDate: null, endDate: null });
                close();
              }}
              className="self-start text-sm text-brand-600 hover:text-brand-700"
            >
              Jump to today ({todayKey})
            </button>
          </form>
        )}
      </ChipMenu>

      <ChipMenu label={capperName ?? "All cappers"} active={Boolean(capperId)}>
        {(close) => (
          <OptionList
            options={cappers}
            value={capperId}
            allLabel="All cappers"
            searchable={cappers.length > 10}
            onPick={(v) => {
              navigate({ capperId: v || null });
              close();
            }}
          />
        )}
      </ChipMenu>

      {sports.map((s) => (
        <button
          key={s.value}
          type="button"
          aria-pressed={sportId === s.value}
          onClick={() => setSport(s.value)}
          className={chipBase + " " + (sportId === s.value ? chipActive : chipIdle)}
        >
          {s.label}
        </button>
      ))}

      <ChipMenu label={betTypeName ?? "Bet type"} active={Boolean(betType)}>
        {(close) => (
          <OptionList
            options={betTypeOptions}
            value={betType}
            allLabel="All bet types"
            onPick={(v) => {
              navigate({ betType: v || null });
              close();
            }}
          />
        )}
      </ChipMenu>

      <ChipMenu label={resultName ?? "Result"} active={Boolean(status)}>
        {(close) => (
          <OptionList
            options={RESULT_OPTIONS}
            value={status}
            allLabel="All results"
            onPick={(v) => {
              navigate({ status: v || null });
              close();
            }}
          />
        )}
      </ChipMenu>

      {anyActive && (
        <button
          type="button"
          onClick={() => startTransition(() => router.push(pathname))}
          className="px-1 text-sm text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}
