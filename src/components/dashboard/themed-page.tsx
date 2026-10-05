import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";

// The page wrapper shared by /cappers and /dashboard: their own typeface, applied to the wrapper only
// (self-hosted by next/font at build time), and the soft neutral backdrop.
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", fallback: ["system-ui", "sans-serif"] });
// The backdrop is painted over the shared layout's content padding (p-4 / md:p-8) rather than changing
// that layout, and is at least as tall as that content area (the viewport less the ticker and the
// layout gutter) so a short page is not half white. The top is only pulled up when nothing sits above
// the page. Its own gutter is the same on every side: 24px, 32px from 1536px.
// The content fills that area; its max-width only stops it stretching further on an ultrawide screen.
const BACKDROP = "-mx-4 -mb-4 bg-[#F5F6FA] px-4 pb-4 pt-4 first:-mt-4 dark:bg-transparent md:-mx-8 md:-mb-8 md:min-h-[calc(100vh-68px)] md:rounded-[11px] md:px-6 md:pb-6 md:pt-6 md:first:-mt-8 min-[1536px]:px-8 min-[1536px]:pb-8 min-[1536px]:pt-8";

export function ThemedPage({ children }: { children: ReactNode }) {
  return (
    <div className={jakarta.className + " " + BACKDROP}>
      <div className="mx-auto max-w-[1680px] space-y-3.5">{children}</div>
    </div>
  );
}
