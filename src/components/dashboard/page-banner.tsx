import type { ReactNode } from "react";
import Image, { type StaticImageData } from "next/image";

// The art fades into the card on its right (over the last 12px of a crop, the last 15% of the whole
// art) and over its bottom 4px: the files' last pixel rows are off-colour, and showed as a line.
// Written out twice, as literal classes, so Tailwind can see them.
// The whole art is shown when the card (a size container) has room for the illustration clear of the
// 140px glow. In the 112px row the illustrations' last details end 965px (/cappers) and 992px
// (/dashboard) across, so that is a card of 1132px or more. The 104px row's art would need 1062px,
// and below `lg` no card is that wide.
const MASK =
  "[mask-image:linear-gradient(90deg,#000_calc(100%_-_12px),transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] " +
  "lg:[@container_(min-width:1132px)]:w-auto " +
  "lg:[@container_(min-width:1132px)]:[mask-image:linear-gradient(90deg,#000_85%,transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] ";

// The blue light on the card's right edge: a soft glow, and a 3px bar over it. The card's rounded
// corners clip both.
const GLOW =
  "pointer-events-none absolute inset-y-0 right-0 w-[90px] bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.22)_70%,rgba(56,189,248,0.4)_100%)] sm:w-[140px]";
const BAR =
  "pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)]";

// The image banner on /cappers and /dashboard: one navy card with the banner art on top and, as
// `children`, the page's strip under it. Dark in both themes. The page name is part of the art, so
// the image is decorative and the real heading is for screen readers only.
// The art is drawn at the row's height and its own width, from the left, and the page crops it to
// the icon and the word: `cropClassName` is the crop's width at each row height, ending before the
// illustration. A card wide enough for the illustration shows the whole art instead (see MASK).
// The row is 104px from `sm` and 112px from `lg`; `rowClassName` is its height on a phone, and
// `imageClassName` the phone's shift to the left. `className` is the card's background: the navy
// of the art's bottom edge. `glow` is how far down the edge's glow reaches.
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
    <div className={"relative overflow-hidden rounded-2xl [container-type:inline-size] shadow-[0_8px_24px_rgba(3,11,41,0.22)] " + className}>
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
