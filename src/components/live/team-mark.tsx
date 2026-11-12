"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// A team's logo image, or - when there is none - the mark the Live page already
// used (the caller's `fallback`: a TeamColorBar, a header dot, a TeamCrest).
// The fallback renders exactly as it did before logos existed whenever:
//   - logoUrl is missing (a team ESPN sent no logo for, a card that matched no
//     score row, a game outside the score window), or
//   - the image fails to load (CDN hiccup, 404) - never a broken-image icon.
//
// The image is decorative (the team name is always printed next to it), hence
// alt="" and aria-hidden. A plain <img>, like the app's other logo marks: the
// URLs are ESPN's own CDN (validated in lib/team-logo.ts), already sized.
export function TeamMark({
  logoUrl,
  fallback,
  sizeClass = "h-5 w-5",
}: {
  logoUrl: string | null | undefined;
  fallback: ReactNode;
  // Tailwind size classes for the image box. The fallback keeps its own size.
  sizeClass?: string;
}) {
  // Keyed by URL so a card whose logo changes (the list re-sorts on a poll) gets a fresh try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // An image that already failed before hydration never fires React's onError, so check once on mount.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailedUrl(logoUrl ?? null);
  }, [logoUrl]);

  if (!logoUrl || failedUrl === logoUrl) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- ESPN CDN logo, decorative, see header
    <img
      ref={imgRef}
      src={logoUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setFailedUrl(logoUrl)}
      className={sizeClass + " shrink-0 object-contain"}
    />
  );
}
