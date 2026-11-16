"use client";

import { useState, type ComponentProps } from "react";
import { PickForm } from "@/components/dashboard/pick-form";

type PickFormProps = ComponentProps<typeof PickForm>;

// The row under the Catalog Import banner: "Back to Picks", the one-line description and the
// "Log a single pick" button, which opens the same PickForm as a card underneath.
export function ImportPageHeader({ cappers, sports, atLimit }: Pick<PickFormProps, "cappers" | "sports" | "atLimit">) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <a href="/picks" className="-my-2 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600 transition hover:underline dark:text-brand-300">
            <span aria-hidden="true" className="mr-1">
              &larr;
            </span>
            Back to Picks
          </a>
          <p className="max-w-2xl text-sm text-muted-foreground">Paste a capper&apos;s card — we match every pick to tonight&apos;s board and grade it automatically.</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-full border border-[#2A4A8A] bg-[#0A1530] px-5 text-sm font-medium text-white transition hover:bg-[#12214A] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          + Log a single pick
        </button>
      </div>
      {open && (
        <div className="mb-5">
          <PickForm cappers={cappers} sports={sports} atLimit={atLimit} open={open} onOpenChange={setOpen} />
        </div>
      )}
    </>
  );
}
