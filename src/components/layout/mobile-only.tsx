"use client";

import { useSyncExternalStore, type ReactNode } from "react";

// Render-by-width wrappers around the 1024px (Tailwind's lg) line, where the header's page tabs
// appear. MobileOnly: below it. DesktopOnly: from it. The server render includes the children (the
// viewport is unknown there) under a class that hides them at the other width, so nothing paints
// where it should not; once hydrated, the other width drops them from the DOM. The data the children
// need is still loaded by the layout on the server (the cached score feed), which this cannot skip.
const QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useBelowLg(serverValue: boolean) {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => serverValue);
}

export function MobileOnly({ children }: { children: ReactNode }) {
  if (!useBelowLg(true)) return null;
  return <div className="lg:hidden">{children}</div>;
}

export function DesktopOnly({ children, className = "" }: { children: ReactNode; className?: string }) {
  if (useBelowLg(false)) return null;
  return <div className={"hidden lg:block " + className}>{children}</div>;
}
