"use client";

import { useEffect } from "react";
import { getPageScroller } from "@/lib/page-scroll";

const STORAGE_KEY = "app-scroll-positions";

function urlKey() {
  return location.pathname + location.search;
}

function readPositions(): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writePositions(positions: Record<string, number>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage blocked or full - Back just lands at the top, as it would without this.
  }
}

// Back/forward scroll restoration for the desktop shell. The browser restores
// the window's scroll position on its own, but not a scrolling <main> (see
// lib/page-scroll.ts), so this remembers <main>'s position per URL and puts it
// back after a back/forward navigation. Does nothing when the window scrolls
// (mobile), leaving the browser's own restoration in charge there.
export function PageScrollRestoration() {
  useEffect(() => {
    const scroller = getPageScroller();
    if (!scroller) return;

    const positions = readPositions();
    // While a back/forward restore is in flight, the outgoing page's content
    // swap clamps scrollTop and fires scroll events under the new URL - those
    // must not overwrite the position being restored.
    let restoring = false;
    let saveFrame = 0;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;

    function onScroll() {
      if (restoring) return;
      cancelAnimationFrame(saveFrame);
      saveFrame = requestAnimationFrame(() => {
        positions[urlKey()] = scroller!.scrollTop;
        writePositions(positions);
      });
    }

    function onPopState() {
      const target = positions[urlKey()] ?? 0;
      restoring = true;
      clearTimeout(restoreTimer);
      // The restored page renders asynchronously and may not be tall enough
      // yet on the first try; retry briefly until the position sticks.
      let tries = 0;
      const attempt = () => {
        scroller!.scrollTop = target;
        if (Math.abs(scroller!.scrollTop - target) > 1 && tries++ < 20) {
          restoreTimer = setTimeout(attempt, 50);
        } else {
          restoring = false;
        }
      };
      requestAnimationFrame(attempt);
    }

    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPopState);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPopState);
      cancelAnimationFrame(saveFrame);
      clearTimeout(restoreTimer);
    };
  }, []);

  return null;
}
