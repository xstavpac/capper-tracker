"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Shared across all three /charts workspaces so entering fullscreen on the
// chart card always leaves this much of the viewport for it - big enough to
// feel like "the chart took over the screen," small enough that the toolbar
// above it (date range, view toggle, fullscreen button) and any scroll
// headroom for a tall sidebar never get squeezed out.
//
// This used to be a static "68vh" CSS string, on the theory that Recharts'
// own ResizeObserver-driven ResponsiveContainer would pick up the resulting
// box change automatically. Confirmed via a real (non-automated) click that
// this was wrong: on entering fullscreen the chart rendered nothing at all -
// classic symptom of ResponsiveContainer's ResizeObserver catching its very
// first post-transition layout at a transitional (zero-ish) size and never
// being nudged again, since nothing further actually resizes afterward. A
// static CSS value has no way to force a re-measurement once that happens.
// chartHeight below is the fix: an explicit, JS-computed pixel number,
// recomputed from window.innerHeight a couple of animation frames after the
// transition (and again on any subsequent window resize while fullscreen),
// so ResponsiveContainer always receives an already-settled value instead of
// depending on it discovering one on its own.
const FULLSCREEN_CHART_HEIGHT_RATIO = 0.68;
export const FULLSCREEN_CHART_HEIGHT = `${FULLSCREEN_CHART_HEIGHT_RATIO * 100}vh`;

// iOS Safari has no Element.requestFullscreen for non-<video> elements at
// all (a real, long-standing WebKit restriction, not a bug in this code) -
// document.fullscreenEnabled (or its older webkit-prefixed equivalent on
// pre-16.4 desktop Safari) is false there, which `supported` below reflects
// so callers can simply not render a fullscreen control rather than offer a
// button that silently does nothing.
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

function currentFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

// One hook, one ref - attach `ref` to whatever DOM node should become the
// fullscreen surface (the whole workspace root, so the variable picker and
// toolbar go fullscreen along with the chart, not just the chart itself).
// `isFullscreen` only ever reflects THIS element being the fullscreen one
// (not some other component's), since fullscreenchange is a document-wide
// event but only one element can be fullscreen at a time.
export function useFullscreen<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(false);
  // undefined until the post-transition measurement lands - callers should
  // fall back to the static FULLSCREEN_CHART_HEIGHT for the brief window
  // before that first measurement, not to the normal (non-fullscreen) height.
  const [chartHeight, setChartHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const doc = document as FullscreenDocument;
    setSupported(Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled));

    function measure() {
      setChartHeight(Math.round(window.innerHeight * FULLSCREEN_CHART_HEIGHT_RATIO));
    }

    function handleChange() {
      const nowFullscreen = currentFullscreenElement() === ref.current;
      setIsFullscreen(nowFullscreen);
      if (nowFullscreen) {
        // Two rAFs (not one) - the fullscreenchange event can fire a frame
        // or two before the browser has actually finished laying out the
        // element at its new fullscreen size, which is exactly the window
        // that produced the blank-chart bug. A single setTimeout(0/other
        // short delay) would work on most machines but is a guess about how
        // long the transition takes; rAF instead waits for two real paints,
        // which is what's actually needed regardless of machine speed.
        requestAnimationFrame(() => requestAnimationFrame(measure));
      } else {
        setChartHeight(undefined);
      }
    }
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      document.removeEventListener("webkitfullscreenchange", handleChange);
    };
  }, []);

  // Belt-and-suspenders for the rAF measurement above: if the real viewport
  // still changes after that (a delayed browser-chrome-hide animation, the
  // window moving to a different monitor, an OS-level display change),
  // this keeps the chart's height correct for as long as fullscreen stays
  // active, the same way a normal (non-fullscreen) window resize already
  // gets picked up by ResponsiveContainer's own ResizeObserver.
  useEffect(() => {
    if (!isFullscreen) return;
    function handleResize() {
      setChartHeight(Math.round(window.innerHeight * FULLSCREEN_CHART_HEIGHT_RATIO));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isFullscreen]);

  const enter = useCallback(() => {
    const el = ref.current as FullscreenElement | null;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }, []);

  const exit = useCallback(() => {
    const doc = document as FullscreenDocument;
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
  }, []);

  const toggle = useCallback(() => {
    if (currentFullscreenElement() === ref.current) exit();
    else enter();
  }, [enter, exit]);

  return { ref, isFullscreen, supported, toggle, chartHeight };
}

// Shared class string for the fullscreen surface itself, applied only while
// isFullscreen is true - `fixed inset-0` (re-asserted on top of the
// UA's own :fullscreen sizing, which varies slightly across browsers) plus
// an explicit opaque background so nothing of the page behind ever shows
// through, and its own scroll container so a tall variable-picker sidebar
// never gets clipped instead of exiting fullscreen to reach it.
export const FULLSCREEN_SURFACE_CLASS =
  "fixed inset-0 z-50 h-screen w-screen overflow-y-auto bg-background p-4 sm:p-6";
