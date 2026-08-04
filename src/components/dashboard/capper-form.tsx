"use client";

import { useState, useRef } from "react";
import { createCapperAction } from "@/server/actions/cappers";

const SOURCES = [
  { value: "TWITTER", label: "Twitter / X" },
  { value: "DISCORD", label: "Discord" },
  { value: "TELEGRAM", label: "Telegram" },
  { value: "DUBCLUB", label: "DubClub" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "FRIEND", label: "Friend" },
  { value: "OTHER", label: "Other" },
];

const COLOR_TAGS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#6B7280"];

export function CapperForm({ atLimit }: { atLimit: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState("TWITTER");
  const [colorTag, setColorTag] = useState(COLOR_TAGS[0]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  if (atLimit && !isOpen) {
    return (
      <div className="rounded-card bg-white p-4 shadow-soft">
        <p className="text-sm text-gray-600">
          You&apos;ve reached the free plan limit of 2 cappers.{" "}
          <span className="font-medium text-brand-600">Upgrade to Pro</span> for unlimited
          cappers.
        </p>
      </div>
    );
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700"
      >
        + Add capper
      </button>
    );
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    setSubmitting(true);
    formData.set("colorTag", colorTag);

    const result = await createCapperAction(formData);
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    setIsOpen(false);
    formRef.current?.reset();
    setSource("TWITTER");
    setColorTag(COLOR_TAGS[0]);
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      className="rounded-card bg-white p-5 shadow-soft"
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">Add a capper</h3>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
          <input
            name="name"
            required
            placeholder="e.g. @JD_Picks"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Source</label>
          <select
            name="source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {source === "OTHER" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Custom source</label>
            <input
              name="customSource"
              placeholder="e.g. Reddit"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Sport specialization
          </label>
          <input
            name="sportSpecialization"
            placeholder="e.g. NBA"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Color tag</label>
          <div className="flex items-center gap-2 pt-1.5">
            {COLOR_TAGS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColorTag(c)}
                className={
                  "h-6 w-6 rounded-full transition " +
                  (colorTag === c ? "ring-2 ring-offset-2 ring-gray-400" : "")
                }
                style={{ backgroundColor: c }}
                aria-label={"Select color " + c}
              />
            ))}
          </div>
        </div>

        <div className="col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-600">Notes (optional)</label>
          <textarea
            name="notes"
            rows={2}
            placeholder="Anything worth remembering about this capper"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700 disabled:opacity-50"
      >
        {submitting ? "Adding..." : "Add capper"}
      </button>
    </form>
  );
}
