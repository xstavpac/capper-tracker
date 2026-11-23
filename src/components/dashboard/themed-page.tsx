import type { ReactNode } from "react";
import localFont from "next/font/local";
import { SHELL_CONTAINER } from "@/components/layout/shell";

// The page wrapper shared by /cappers and /dashboard: their own typeface, applied to the wrapper only
// (self-hosted from src/fonts via next/font/local), and the soft neutral backdrop.
const jakarta = localFont({
  src: [{ path: "../../fonts/plus-jakarta-sans-latin-wght.woff2", weight: "200 800", style: "normal" }],
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});
// The site's typeface, for page content that sits outside ThemedPage (the /live league row under the banner).
export const SITE_FONT = jakarta.className;
// The backdrop is painted over the shared layout's content padding (<main>'s p-4 / md:p-8, cancelled by
// the negative margins) rather than changing that layout, so it sits flush with the full-width main.
// It is at least as tall as the content area - the viewport less the ticker (32px) and the header
// (site-header.tsx: one 64px row at every width) - so a short page is not half white. The top is only pulled up when nothing sits above the page. Its
// own vertical padding is 16px, 24px from 768px, 32px from 1536px; the sides come from the shell container.
// The content sits in the shared shell container (layout/shell.ts), the same edges as the header and the banner card.
const BACKDROP =
  "-mx-4 -mb-4 bg-[#F5F6FA] pb-4 pt-4 first:-mt-4 themed-bg md:-mx-8 md:-mb-8 min-h-[calc(100vh-96px)] md:pb-6 md:pt-6 md:first:-mt-8 min-[1536px]:pb-8 min-[1536px]:pt-8";

// themed-bg (globals.css) is the /live page background in dark; light keeps the flat #F5F6FA.
// `frost` (/live only): the icy gradient backdrop (.live-bg in globals.css) in place of the flat one, in both themes.
const FROST_BACKDROP = BACKDROP.replace("bg-[#F5F6FA] ", "live-bg ").replace("themed-bg ", "");
export function ThemedPage({ children, frost = false }: { children: ReactNode; frost?: boolean }) {
  return (
    <div className={jakarta.className + " " + (frost ? FROST_BACKDROP : BACKDROP)}>
      <div className={SHELL_CONTAINER + " space-y-3.5"}>{children}</div>
    </div>
  );
}
