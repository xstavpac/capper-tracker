"use client";

import { useEffect, useState } from "react";
import { CopyIcon } from "@/components/dashboard/cappers-icons";

// A dark code panel (the Bot Guide mockup's) with a Copy button. The code scrolls inside its own box, so a long
// line never widens the page at phone width.
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl bg-[#0A1530] dark:border dark:border-white/10 dark:bg-black/40">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 py-1 pl-4 pr-1.5">
        <span className="text-xs font-semibold text-[#9FB0D0]">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[#C9D3E6] hover:bg-white/10 hover:text-white"
        >
          <CopyIcon className="h-3.5 w-3.5" />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="m-0 max-w-full overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.65] text-[#E6EAF0]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
