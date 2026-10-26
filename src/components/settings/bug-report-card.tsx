"use client";

import { useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { submitBugReportAction } from "@/server/actions/bug-reports";
import { MAX_DESCRIPTION_CHARS } from "@/lib/bug-report";
import { shrinkScreenshot } from "@/lib/bug-report-image";

// Settings > Report a bug. The screenshot is shrunk in the browser first
// (shrinkScreenshot); the server re-checks every limit. The sender only gets a
// confirmation - reports are read in the admin ops console.
export function BugReportCard() {
  const pathname = usePathname();
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("description", description);
      form.set("pagePath", pathname ?? "");
      if (file) {
        const shrunk = await shrinkScreenshot(file);
        if (!shrunk.ok) {
          setError(shrunk.error);
          return;
        }
        form.set("screenshot", new File([shrunk.blob], "screenshot.webp", { type: "image/webp" }));
      }
      const result = await submitBugReportAction(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDescription("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setNotice(
        result.screenshot === "unavailable"
          ? "Thanks - your report was sent, but the screenshot couldn't be attached. Please describe what you saw."
          : "Thanks - your report was sent."
      );
    });
  }

  return (
    <form onSubmit={submit} className="rounded-card bg-card p-5 shadow-soft">
      <h3 className="mb-1 text-sm font-medium text-card-foreground">Report a bug</h3>
      <p className="mb-3 text-xs text-muted-foreground">Tell us what went wrong. A screenshot helps.</p>

      <label htmlFor="bug-description" className="sr-only">
        What went wrong
      </label>
      <textarea
        id="bug-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={MAX_DESCRIPTION_CHARS}
        rows={4}
        required
        disabled={pending}
        placeholder="What did you expect, and what happened instead?"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Screenshot (optional)"
          disabled={pending}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-xs text-muted-foreground"
        />
        <button
          type="submit"
          disabled={pending || description.trim().length === 0}
          className="ml-auto rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Sending..." : "Send report"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[#DC2626] dark:text-[#F87171]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </form>
  );
}
