"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Shared across all three /charts workspaces so entering fullscreen on the
// chart card always leaves this much of the viewport for it - big enough to
// feel like "the chart took over the screen," small enough that the toolbar
// above it (date range, view toggle, fullscreen button) and any scroll
// headroom for a tall sidebar never get squeezed out. Expressed in vh (not a
// JS-computed pixel number) so Recharts' own ResizeObserver-driven
// ResponsiveContainer picks up window resizes/zoom automatically - no resize
// listener of our own needed.
export const FULLSCREEN_CHART_HEIGHT = "68vh";

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

  useEffect(() => {
    const doc = document as FullscreenDocument;
    setSupported(Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled));

    function handleChange() {
      setIsFullscreen(currentFullscreenElement() === ref.current);
    }
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      document.removeEventListener("webkitfullscreenchange", handleChange);
    };
  }, []);

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

  return { ref, isFullscreen, supported, toggle };
}

// Shared class string for the fullscreen surface itself, applied only while
// isFullscreen is true - `fixed inset-0` (re-asserted on top of the
// UA's own :fullscreen sizing, which varies slightly across browsers) plus
// an explicit opaque background so nothing of the page behind ever shows
// through, and its own scroll container so a tall variable-picker sidebar
// never gets clipped instead of exiting fullscreen to reach it.
export const FULLSCREEN_SURFACE_CLASS =
  "fixed inset-0 z-50 h-screen w-screen overflow-y-auto bg-background p-4 sm:p-6";
