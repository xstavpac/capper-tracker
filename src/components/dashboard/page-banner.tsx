import type { ReactNode } from "react";
import Image, { type StaticImageData } from "next/image";

// The image banner on /cappers and /dashboard: one navy card with the banner art on top and, as
// `children`, the page's strip under it. Dark in both themes. The page name is part of the art, so
// the image is decorative and the real heading is for screen readers only.
// `frameClassName` sizes the art: a fixed height on a phone (a left-anchored crop to the icon and
// the word) and the file's own aspect ratio from `sm` up, written out as literal classes so
// Tailwind can see them.
export function PageBanner({ src, title, frameClassName, children }: { src: StaticImageData; title: string; frameClassName: string; children?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[18px] bg-[#030B29] shadow-[0_8px_24px_rgba(3,11,41,0.22)] sm:rounded-2xl">
      <div className={"relative w-full " + frameClassName}>
        {/* The phone's crop is drawn wider than the screen (its height times the aspect ratio). */}
        <Image src={src} alt="" fill priority quality={90} sizes="(max-width: 639px) 750px, 100vw" className="object-cover object-left" />
      </div>
      <h1 className="sr-only">{title}</h1>
      {children}
    </div>
  );
}
