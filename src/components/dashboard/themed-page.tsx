import type { ReactNode } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { SHELL_CONTAINER } from "@/components/layout/shell";

// The page wrapper shared by /cappers and /dashboard: their own typeface, applied to the wrapper only
// (self-hosted by next/font at build time), and the soft neutral backdrop.
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", fallback: ["system-ui", "sans-serif"] });
// The backdrop is painted over the shared layout's content padding (<main>'s p-4 / md:p-8, cancelled by
// the negative margins) rather than changing that layout, so it sits flush with the full-width main.
// It is at least as tall as the content area - the viewport less the ticker (32px) and the header
// (site-header.tsx: one 64px row at every width) - so a short page is not half white. The top is only pulled up when nothing sits above the page. Its
// own vertical padding is 16px, 24px from 768px, 32px from 1536px; the sides come from the shell container.
// The content sits in the shared shell container (layout/shell.ts), the same edges as the header and the banner card.
const BACKDROP =
  "-mx-4 -mb-4 bg-[#F5F6FA] pb-4 pt-4 first:-mt-4 dark:bg-transparent md:-mx-8 md:-mb-8 min-h-[calc(100vh-96px)] md:pb-6 md:pt-6 md:first:-mt-8 min-[1536px]:pb-8 min-[1536px]:pt-8";

export function ThemedPage({ children }: { children: ReactNode }) {
  return (
    <div className={jakarta.className + " " + BACKDROP}>
      <div className={SHELL_CONTAINER + " space-y-3.5"}>{children}</div>
    </div>
  );
}
