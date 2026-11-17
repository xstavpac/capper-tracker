"use client";

import { useSyncExternalStore, type ReactNode } from "react";

// Render-by-width wrappers. MobileOnly / DesktopOnly split at 1024px (Tailwind's lg, where the header's
// page tabs appear); PhoneOnly / TabletUp split at 768px (md). The server render includes the children
// (the viewport is unknown there) under a class that hides them at the other width, so nothing paints
// where it should not; once hydrated, the other width drops them from the DOM, so a control that is
// drawn in two places is only ever in the DOM / accessibility tree once. Without matchMedia (jsdom) the
// server value stands. The data the children need is still loaded by the server (the cached score
// feed), which this cannot skip.
function useMatch(query: string, serverValue: boolean) {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue
  );
}

const BELOW_LG = "(max-width: 1023px)";
const BELOW_MD = "(max-width: 767px)";

export function MobileOnly({ children }: { children: ReactNode }) {
  if (!useMatch(BELOW_LG, true)) return null;
  return <div className="lg:hidden">{children}</div>;
}

export function DesktopOnly({ children, className = "" }: { children: ReactNode; className?: string }) {
  if (useMatch(BELOW_LG, false)) return null;
  return <div className={"hidden lg:block " + className}>{children}</div>;
}

export function PhoneOnly({ children, className = "" }: { children: ReactNode; className?: string }) {
  if (!useMatch(BELOW_MD, true)) return null;
  return <div className={"md:hidden " + className}>{children}</div>;
}

export function TabletUp({ children, className = "" }: { children: ReactNode; className?: string }) {
  if (useMatch(BELOW_MD, false)) return null;
  return <div className={"hidden md:block " + className}>{children}</div>;
}
