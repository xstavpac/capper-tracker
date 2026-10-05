import type { ReactNode } from "react";
import Image, { type StaticImageData } from "next/image";

// From `sm` up. The art fades into the card on its right (over the last 12px of a crop, the last
// 15% of the whole art) and over its bottom 4px: the files' last pixel rows are off-colour, and
// showed as a line. Written out twice, as literal classes, so Tailwind can see them.
// The whole art is shown when the card (a size container) has room for the illustration clear of the
// 140px glow. In the 112px row the illustrations' last details end 965px (/cappers) and 992px
// (/dashboard) across, so that is a card of 1132px or more. The 104px row's art would need 1062px,
// and below `lg` no card is that wide.
const MASK =
  "[mask-image:linear-gradient(90deg,#000_calc(100%_-_12px),transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] " +
  "lg:[@container_(min-width:1132px)]:w-auto " +
  "lg:[@container_(min-width:1132px)]:[mask-image:linear-gradient(90deg,#000_85%,transparent),linear-gradient(180deg,#000_calc(100%_-_4px),transparent)] ";

// The blue light on the card's edges: a soft glow, and a 3px bar over it. The card's rounded
// corners clip both. From `sm` up it is on the right only; a phone has it on both sides.
const GLOW =
  "pointer-events-none absolute inset-y-0 right-0 w-[140px] bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.22)_70%,rgba(56,189,248,0.4)_100%)] max-sm:hidden";
const PHONE_GLOW = "pointer-events-none absolute inset-y-0 w-[70px] sm:hidden ";
const PHONE_GLOW_LEFT = PHONE_GLOW + "left-0 bg-[linear-gradient(270deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.22)_70%,rgba(56,189,248,0.38)_100%)]";
const PHONE_GLOW_RIGHT = PHONE_GLOW + "right-0 bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.22)_70%,rgba(56,189,248,0.38)_100%)]";
const BAR = "pointer-events-none absolute inset-y-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)] ";

// A phone's row, in px: the icon's circle starts EDGE from the card's edge; the word's crop has FADE
// of art on each side of the word, which is what fades; the word's first letter is at least GAP
// from the circle. The icon's crop is opaque to HALO past the circle and gone by HALO_END, which is
// short of the art's own divider (about 12px from the circle at these row heights).
const EDGE = 16;
const FADE = 8;
const GAP = 24;
const HALO = 3;
const HALO_END = 9;

const px = (n: number) => Math.round(n * 10) / 10 + "px";

// Where the icon's circle and the word are in the file, in its own pixels, and the phone's row height.
export type PhoneArt = { height: number; circle: { left: number; right: number; centerY: number }; word: { start: number; end: number } };

// A phone's row: two crops of the art, drawn at the row's height. The icon is on the left, cut to
// its circle by a round mask, so none of the art's navy shows as a box around it. The word is
// centred in the card, or further right on a narrow phone to keep GAP from the icon. The line
// between them is drawn here, halfway between the two: the art's own divider is in neither crop.
// The sizes come from the file's measurements, so they are inline styles.
function PhoneRow({ src, art, glow }: { src: StaticImageData; art: PhoneArt; glow: boolean }) {
  const scale = art.height / src.height;
  const radius = ((art.circle.right - art.circle.left) / 2) * scale;
  const circleRight = EDGE + 2 * radius;
  const iconMask = `radial-gradient(circle at ${px(EDGE + radius)} ${px(art.circle.centerY * scale)}, #000 ${px(radius + HALO)}, transparent ${px(radius + HALO_END)})`;
  const wordWidth = (art.word.end - art.word.start) * scale + 2 * FADE;
  const wordMask = `linear-gradient(90deg, transparent, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent)`;
  const wordLeft = `max(calc(50% - ${px(wordWidth / 2)}), ${px(circleRight + GAP - FADE)})`;
  const image = (shift: number) => (
    <Image src={src} alt="" priority quality={90} sizes="550px" className="h-full w-auto max-w-none" style={{ marginLeft: px(-shift) }} />
  );

  return (
    <div className="relative sm:hidden" style={{ height: art.height }}>
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: px(circleRight + HALO_END), maskImage: iconMask, WebkitMaskImage: iconMask }}>
        {image(art.circle.left * scale - EDGE)}
      </div>
      <span
        aria-hidden
        className="absolute top-1/4 h-1/2 w-0.5 rounded-full bg-[#22D3EE] shadow-[0_0_6px_rgba(34,211,238,0.8)]"
        style={{ left: `calc((${px(circleRight + FADE)} + ${wordLeft}) / 2 - 1px)` }}
      />
      <div className="absolute inset-y-0 overflow-hidden" style={{ left: wordLeft, width: px(wordWidth), maskImage: wordMask, WebkitMaskImage: wordMask }}>
        {image(art.word.start * scale - FADE)}
      </div>
      {glow && <span aria-hidden className={PHONE_GLOW_LEFT} />}
      {glow && <span aria-hidden className={PHONE_GLOW_RIGHT} />}
    </div>
  );
}

// The image banner on /cappers and /dashboard: one navy card with the banner art on top and, as
// `children`, the page's strip under it. Dark in both themes. The page name is part of the art, so
// the images are decorative and the real heading is for screen readers only.
// A phone has its own row (PhoneRow, from `phone`). From `sm` up the art is drawn at the row's
// height (104px, 112px from `lg`) and its own width, from the left, and the page crops it to the
// icon and the word: `cropClassName` is the crop's width at each row height, ending before the
// illustration. A card wide enough for the illustration shows the whole art instead (see MASK).
// `className` is the card's background: the navy of the art's bottom edge. `glow` is how far down
// the edges' glow reaches.
export function PageBanner({
  src,
  title,
  className,
  phone,
  cropClassName,
  glow,
  children,
}: {
  src: StaticImageData;
  title: string;
  className: string;
  phone: PhoneArt;
  cropClassName: string;
  glow: "art" | "card";
  children?: ReactNode;
}) {
  return (
    <div className={"relative overflow-hidden rounded-2xl [container-type:inline-size] shadow-[0_8px_24px_rgba(3,11,41,0.22)] " + className}>
      <PhoneRow src={src} art={phone} glow={glow === "art"} />
      <div className="relative h-[104px] max-sm:hidden lg:h-28">
        {/* Out of the flow, so the art's width can't widen the card: it is cut at the card's edge. */}
        <div className={"absolute inset-y-0 left-0 max-w-full overflow-hidden [mask-composite:intersect] " + MASK + cropClassName}>
          <Image src={src} alt="" priority quality={90} sizes="1100px" className="h-full w-auto max-w-none" />
        </div>
        {glow === "art" && <span aria-hidden className={GLOW} />}
      </div>
      <h1 className="sr-only">{title}</h1>
      {children}
      {glow === "card" && (
        <>
          <span aria-hidden className={PHONE_GLOW_LEFT} />
          <span aria-hidden className={PHONE_GLOW_RIGHT} />
          <span aria-hidden className={GLOW} />
        </>
      )}
      <span aria-hidden className={BAR + "left-0 sm:hidden"} />
      <span aria-hidden className={BAR + "right-0"} />
    </div>
  );
}
