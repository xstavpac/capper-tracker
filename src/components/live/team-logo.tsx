"use client";

import { useState } from "react";

// Falls back to the old colored-initials badge if `src` is null (no mapping
// for this sport/team yet) or the image itself fails to load (e.g. ESPN
// hasn't got that abbreviation, or the CDN is briefly unreachable) - a broken
// image icon in the game card header would look worse than the badge it's
// replacing.
export function TeamLogo({ src, teamName, size = 28 }: { src: string | null; teamName: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-600"
        style={{ width: size, height: size }}
      >
        {teamName.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN image, no next/image remote-pattern config in this project
    <img
      src={src}
      alt={teamName}
      width={size}
      height={size}
      className="shrink-0 rounded-full bg-white object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
