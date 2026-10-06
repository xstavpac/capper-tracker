"use client";

import { useState, type ComponentProps } from "react";
import { PickForm } from "@/components/dashboard/pick-form";
import { PageHeader, pageHeaderActionClass } from "@/components/ui/page-header";

type PickFormProps = ComponentProps<typeof PickForm>;

// The Catalog Import header plus the manual single-pick form it toggles: the
// button lives in the header, the same PickForm opens as a card underneath.
export function ImportPageHeader({ cappers, sports, atLimit }: Pick<PickFormProps, "cappers" | "sports" | "atLimit">) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 11v6" />
            <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
          </svg>
        }
        title="Catalog Import"
        subtitle="Paste a capper's card — we match every pick to tonight's board and grade it automatically."
        back={{ href: "/picks", label: "Back to Picks" }}
        action={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={pageHeaderActionClass}
          >
            + Log a single pick
          </button>
        }
      />
      {open && (
        <div className="mb-5">
          <PickForm cappers={cappers} sports={sports} atLimit={atLimit} open={open} onOpenChange={setOpen} />
        </div>
      )}
    </>
  );
}
