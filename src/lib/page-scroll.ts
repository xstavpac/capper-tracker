// Which element scrolls the page. Inside the app shell ((app)/layout.tsx) the
// desktop layout is locked to the viewport and <main id="app-scroll"> scrolls
// on its own, so the sidebar never scrolls away; on mobile, and on pages
// outside the shell, the window scrolls as usual. Anything that asks "is this
// on screen?" or scrolls the page should go through here rather than assume
// the window.

export const PAGE_SCROLLER_ID = "app-scroll";

// The scrolling <main>, or null when the window is what scrolls (mobile, where
// <main> isn't overflow-y:auto, or a page outside the app shell).
export function getPageScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(PAGE_SCROLLER_ID);
  if (!el) return null;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === "auto" || overflowY === "scroll" ? el : null;
}

// The band of the viewport (client coordinates) the page content is visible in.
export function getPageViewport(): { top: number; bottom: number; height: number } {
  const scroller = getPageScroller();
  if (!scroller) return { top: 0, bottom: window.innerHeight, height: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.top + scroller.clientHeight, height: scroller.clientHeight };
}

export function isFullyInPageView(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const view = getPageViewport();
  return rect.top >= view.top && rect.bottom <= view.bottom;
}

// scrollIntoView already scrolls whichever ancestor scrolls (<main> or the
// window); this just adds the jump-instead-of-glide for reduced motion.
export function scrollPageToElement(el: Element | null, block: ScrollLogicalPosition) {
  if (!el) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block });
}
