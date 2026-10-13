import type { ReactNode } from "react";

// The banner stat cell and its text tones, shared by the capper hero (a server component) and the
// /charts workspace (a client component). This file must stay free of server/data imports: the
// hero's own data modules build Prisma.sql at module scope, which throws in a browser bundle.

export const UP = "text-[#34D399]";
export const DOWN = "text-[#FCA5A5]";
export const LABEL = "font-medium uppercase tracking-[0.08em] text-white/60";

// `wraps` is for a value made of words (a market's name): it breaks onto a second line
// rather than being cut off.
export function StatCell({ label, value, sub, tone, wraps, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "down"; wraps?: boolean; className?: string }) {
  return (
    // The banner's navy under the same faint white wash as the momentum card (opaque, to cover the grid's own).
    <div className={"min-w-0 bg-banner bg-[linear-gradient(rgb(255_255_255/0.06),rgb(255_255_255/0.06))] px-4 py-[9px] " + className}>
      <div className={"text-[11px] " + LABEL}>{label}</div>
      <div className={"mt-0.5 text-xl font-semibold leading-tight tabular-nums " + (wraps ? "" : "truncate ") + (tone === "up" ? UP : tone === "down" ? DOWN : "text-white")}>{value}</div>
      {sub && <div className="truncate text-xs tabular-nums text-white/60">{sub}</div>}
    </div>
  );
}
