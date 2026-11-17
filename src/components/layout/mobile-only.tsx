"use client";

import { useSyncExternalStore, type ReactNode } from "react";

// Renders its children only below 1024px (Tailwind's lg), the width where the header's page tabs
// appear: below it the pages live in the menu / bottom tab bar, and the Slate Bar stands in for them.
// The server render includes the children (the viewport is unknown there) under `lg:hidden`, so a
// desktop never paints them; once hydrated, a desktop drops them from the DOM. The data the children
// need is still loaded by the layout on the server (the cached score feed), which this cannot skip.
const QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function MobileOnly({ children }: { children: ReactNode }) {
  const below = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true
  );
  if (!below) return null;
  return <div className="lg:hidden">{children}</div>;
}
