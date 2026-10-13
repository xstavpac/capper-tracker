import type { ReactNode, Ref } from "react";

// The navy banner drawn in code (not from an image), shared by /live and /parlay: the card and the
// blue light on its edges, the row its content sits in, and the brand block - the glowing icon
// ring, the cyan line and the page's title. Dark in both themes.
// The layout follows the card's width (a size container), not the screen's: beside the sidebar the
// card is far narrower than the screen. Under 640px it is stacked, as on a phone.

// The blue light on the card's edges, as on the /cappers and /dashboard banners (page-banner.tsx):
// a soft glow, and a 3px bar over it. On the right only; a stacked card (under 640px) has it on
// both sides, the glow over the title's rows only (BannerBrand).
// Exported for a card with rows under the title (/charts): it draws the glow in its title row only.
export const BANNER_GLOW =
  "pointer-events-none absolute inset-y-0 right-0 hidden w-[140px] bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)] [@container_(min-width:640px)]:block";
const BAR = "pointer-events-none absolute inset-y-0 w-[3px] bg-[linear-gradient(180deg,#38BDF8,#2563EB)] shadow-[0_0_14px_2px_rgba(56,189,248,0.7)] ";

// `glow={false}` leaves the soft glow out (the bars stay): a card taller than one row places
// BANNER_GLOW itself, so the glow is not drawn over the rows under the title.
export function NavyBanner({ children, glow = true }: { children: ReactNode; glow?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-banner shadow-[0_10px_28px_rgba(3,11,41,0.28)] [container-type:inline-size] sm:rounded-[20px]">
      {children}
      {glow && <span aria-hidden className={BANNER_GLOW} />}
      <span aria-hidden className={BAR + "left-0 [@container_(min-width:640px)]:hidden"} />
      <span aria-hidden className={BAR + "right-0"} />
    </div>
  );
}

// The banner's row from 640px: the brand on the left, the controls on the right.
export const BANNER_ROW =
  "[@container_(min-width:640px)]:flex [@container_(min-width:640px)]:items-center [@container_(min-width:640px)]:justify-between [@container_(min-width:640px)]:gap-x-5 [@container_(min-width:640px)]:pl-6 [@container_(min-width:640px)]:pr-7";
// The right-side controls: their own padded row when stacked, pushed to the right from 640px.
export const BANNER_CONTROLS = "flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 pb-3 pt-1 [@container_(min-width:640px)]:ml-auto [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:gap-3 [@container_(min-width:640px)]:p-0";
// The size of the icon in the ring.
export const BANNER_ICON = "h-[18px] w-[18px] [@container_(min-width:640px)]:h-[22px] [@container_(min-width:640px)]:w-[22px]";

// Stacked, the line sits in what is left of the first column, between the ring and the word.
const BRAND =
  "relative grid grid-cols-[1fr_auto_1fr] [@container_(min-width:640px)]:h-[84px] [@container_(min-width:640px)]:flex-none [@container_(min-width:640px)]:grid-cols-[auto_auto] [@container_(min-width:640px)]:content-center";
// The blue light on a stacked card's edges, over the title's rows only (see NavyBanner).
const PHONE_GLOW = "pointer-events-none absolute inset-y-0 w-[70px] [@container_(min-width:640px)]:hidden ";
const TITLE = "font-extrabold leading-none text-white [text-shadow:0_0_14px_rgba(96,165,250,0.55)] ";

// `badge` is drawn on the ring's corner (/live's red dot). `tagline` is a small letter-spaced line
// under the title, its words parted by cyan dots. `titleClassName` is the title's size, for a
// title longer than one short word. The refs are for a page that measures its row (/live).
export function BannerBrand({
  icon,
  badge,
  title,
  tagline,
  titleClassName = "text-[34px] tracking-[-0.8px]",
  ringRef,
  titleRef,
}: {
  icon: ReactNode;
  badge?: ReactNode;
  title: string;
  tagline?: string[];
  titleClassName?: string;
  ringRef?: Ref<HTMLDivElement>;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className={BRAND}>
      <div ref={ringRef} className="flex h-[52px] items-center [@container_(min-width:640px)]:h-auto [@container_(min-width:640px)]:pr-4">
        <span
          className="relative ml-4 flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border-2 border-[#3B82F6] bg-[rgba(3,11,41,0.6)] text-[#9AD8FF] shadow-[0_0_14px_rgba(59,130,246,0.75),inset_0_0_10px_rgba(59,130,246,0.45)] [@container_(min-width:640px)]:ml-0 [@container_(min-width:640px)]:h-11 [@container_(min-width:640px)]:w-11"
        >
          {icon}
          {badge}
        </span>
        <span aria-hidden className="flex flex-1 justify-center [@container_(min-width:640px)]:ml-4 [@container_(min-width:640px)]:flex-none">
          <span className="h-[26px] w-0.5 rounded-full bg-[#22D3EE] shadow-[0_0_6px_rgba(34,211,238,0.8)] [@container_(min-width:640px)]:h-8" />
        </span>
      </div>
      {tagline ? (
        <div className="self-center">
          <h1 ref={titleRef} className={TITLE + titleClassName}>
            {title}
          </h1>
          <p className="mt-1.5 whitespace-nowrap text-[9.5px] font-bold uppercase leading-none tracking-[2px] text-[#BFD3FF] [@container_(min-width:640px)]:text-[11px] [@container_(min-width:640px)]:tracking-[3px]">
            {tagline.map((word, i) => (
              <span key={word}>
                {i > 0 && <span className="text-[#38BDF8]"> · </span>}
                {word}
              </span>
            ))}
          </p>
        </div>
      ) : (
        <h1 ref={titleRef} className={"self-center " + TITLE + titleClassName}>
          {title}
        </h1>
      )}
      <span aria-hidden className={PHONE_GLOW + "left-0 bg-[linear-gradient(270deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]"} />
      <span aria-hidden className={PHONE_GLOW + "right-0 bg-[linear-gradient(90deg,rgba(37,99,235,0)_0%,rgba(37,99,235,0.2)_70%,rgba(56,189,248,0.38)_100%)]"} />
    </div>
  );
}
