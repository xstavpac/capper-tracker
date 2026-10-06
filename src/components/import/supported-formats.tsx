import {
  SUPPORTED_PICK_FORMATS,
  FORMAT_SHORTCUTS,
  COMMON_FORMATS,
  FORMAT_FOOTER_TIP,
  FORMAT_STATUS_LABEL,
  type FormatStatus,
} from "@/lib/supported-pick-formats";

const STATUS_BADGE: Record<FormatStatus, string> = {
  supported: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  asks: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  "coming-soon": "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300",
  "not-yet": "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

const STATUS_DOT: Record<FormatStatus, string> = {
  supported: "bg-emerald-500",
  asks: "bg-amber-500",
  "coming-soon": "bg-brand-500",
  "not-yet": "bg-red-500",
};

const STATUS_ORDER: FormatStatus[] = ["supported", "asks", "coming-soon", "not-yet"];

const cardClass = "rounded-card border border-border bg-card shadow-soft";

function FormatStatusBadge({ status }: { status: FormatStatus }) {
  return (
    <span className={"shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold " + STATUS_BADGE[status]}>
      {FORMAT_STATUS_LABEL[status]}
    </span>
  );
}

// The small card under the Match results panel: four everyday examples and a
// jump link to the full list.
export function CommonFormatsCard() {
  return (
    <section aria-labelledby="common-formats-title" className={cardClass + " p-4"}>
      <h2 id="common-formats-title" className="text-sm font-semibold text-foreground">
        Common formats
      </h2>
      <dl className="mt-2 divide-y divide-border-subtle">
        {COMMON_FORMATS.map((f) => (
          <div key={f.market} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <dt className="text-xs text-muted-foreground">{f.market}</dt>
            <dd className="font-mono text-xs text-foreground">{f.example}</dd>
          </div>
        ))}
      </dl>
      <a
        href="#formats"
        className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
      >
        See every supported format <span aria-hidden="true" className="ml-1">&darr;</span>
      </a>
    </section>
  );
}

// Full-width reference at the bottom of the page. Everything here renders
// from lib/supported-pick-formats.ts - statuses are never written in this file.
export function SupportedFormatsSection() {
  const usedStatuses = STATUS_ORDER.filter((s) =>
    SUPPORTED_PICK_FORMATS.some((g) => g.rows.some((r) => r.status === s))
  );

  return (
    <section id="formats" aria-labelledby="formats-title" className="mt-8 scroll-mt-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="formats-title" className="text-lg font-semibold text-foreground">
            Supported pick formats
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Write picks the way cappers post them. Case, spacing and o/u shorthand don&apos;t matter.
          </p>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground">
          {usedStatuses.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={"h-2 w-2 rounded-full " + STATUS_DOT[s]} />
              {FORMAT_STATUS_LABEL[s]}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Shortcuts we read:</span>
        <ul className="flex flex-wrap gap-1.5">
          {FORMAT_SHORTCUTS.map((s) => (
            <li key={s} className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground">
              {s}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {SUPPORTED_PICK_FORMATS.map((group) => (
          <div key={group.title} className={cardClass + " p-4"}>
            <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
            <ul className="mt-2 divide-y divide-border-subtle">
              {group.rows.map((row) => (
                <li key={row.market} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-foreground">{row.market}</div>
                    <div className="mt-0.5 break-words font-mono text-xs text-muted-foreground">
                      {row.examples.join(" · ")}
                      {row.note && <span className="font-sans"> &rarr; {row.note}</span>}
                    </div>
                  </div>
                  <FormatStatusBadge status={row.status} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-4 rounded-lg bg-brand-50 px-3 py-2.5 text-[13px] text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
        {FORMAT_FOOTER_TIP}
      </p>
    </section>
  );
}

// "Step 3" explainer: where an imported pick shows up, beside the example game card.
export function WherePicksLandCard() {
  return (
    <section aria-labelledby="picks-land-title" className={cardClass + " mt-5 flex flex-wrap items-center gap-x-8 gap-y-4 p-5"}>
      <div className="min-w-0 flex-1 basis-72">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
          Step 3 · Where your picks land
        </p>
        <h2 id="picks-land-title" className="mt-1 text-lg font-semibold text-foreground">
          Every pick lives under its game on the Live tab
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Once a catalog is imported, each pick is grouped under its matchup with the capper&apos;s name, and grades
          itself when the game goes final.
        </p>
        <a
          href="/live"
          className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
        >
          Open the Live tab <span aria-hidden="true" className="ml-1">&rarr;</span>
        </a>
      </div>
      <figure className="w-full max-w-[280px] shrink-0 rounded-xl border border-border bg-muted/40 p-2">
        <img
          src="/example-picks.png"
          alt="Example game card on the Live tab: Rockets at Nuggets, with each capper&apos;s pick listed under the game"
          className="h-auto w-full rounded-lg"
        />
        <figcaption className="px-1 pt-1.5 text-[11px] text-muted-foreground">Example game card</figcaption>
      </figure>
    </section>
  );
}
