import type { ReactNode } from "react";
import Image, { type StaticImageData } from "next/image";

// The art fades into the card on its right (over its last 12px on a phone, where it is a crop) and
// over its bottom 4px: the files' last pixel rows are off-colour, and showed as a line.
// Written out twice, as literal classes, so Tailwind can see them.
const MASK =
  "[mask-image:linear-gradient(90deg,#000_calc(100%_-_12px),transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] " +
  "sm:[mask-image:linear-gradient(90deg,#000_85%,transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] ";

// The blue light on the card's right edge: a soft glow, and a 3px bar over it. The card's rounded
// corners clip both.
const GLOW =
  "pointer-events-none absolute inset-y-0 right-0 w-[90px] bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.22)_70%,rgba(56,189,248,0.4)_100%)] sm:w-[140px]";
const BAR =
  "pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)]";

// The image banner on /cappers and /dashboard: one navy card with the banner art on top and, as
// `children`, the page's strip under it. Dark in both themes. The page name is part of the art, so
// the image is decorative and the real heading is for screen readers only.
// The art is drawn at the row's height and its own width, from the left. On a phone the page crops
// it to the icon and the word: `rowClassName` is the row's height, `cropClassName` the crop's width
// and `imageClassName` the shift to the left. From `sm` up the row is 104px (112px from `lg`) and
// shows the whole art, which fades into the card on its right. `className` is the card's background: the
// navy of the art's bottom edge. `glow` is how far down the edge's glow reaches.
export function PageBanner({
  src,
  title,
  className,
  rowClassName,
  cropClassName,
  imageClassName,
  glow,
  children,
}: {
  src: StaticImageData;
  title: string;
  className: string;
  rowClassName: string;
  cropClassName: string;
  imageClassName: string;
  glow: "art" | "card";
  children?: ReactNode;
}) {
  return (
    <div className={"relative overflow-hidden rounded-2xl shadow-[0_8px_24px_rgba(3,11,41,0.22)] " + className}>
      <div className={"relative sm:h-[104px] lg:h-28 " + rowClassName}>
        {/* Out of the flow, so the art's width can't widen the card: it is cut at the card's edge. */}
        <div
          className={
            "absolute inset-y-0 left-0 max-w-full overflow-hidden [mask-composite:intersect] " + MASK + cropClassName
          }
        >
          <Image src={src} alt="" priority quality={90} sizes="(max-width: 639px) 550px, 1100px" className={"h-full w-auto max-w-none " + imageClassName} />
        </div>
        {glow === "art" && <span aria-hidden className={GLOW} />}
      </div>
      <h1 className="sr-only">{title}</h1>
      {children}
      {glow === "card" && <span aria-hidden className={GLOW} />}
      <span aria-hidden className={BAR} />
    </div>
  );
}
